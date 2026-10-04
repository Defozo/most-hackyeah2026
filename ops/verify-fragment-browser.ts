import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { buildApp } from '../apps/api/src/app.ts';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { DomainModel } from '../packages/contracts/src/index.ts';

// An isolated synthetic installation. The expected manifest prevents testing an
// older frozen release by accident while other acceptance flows are running.
const expectedHash=process.env.MOST_FRAGMENT_RELEASE_HASH;
if(!expectedHash||!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error('Set MOST_FRAGMENT_RELEASE_HASH to the agreed final release-manifest SHA-256.');
const origin='http://localhost:8096';const expect=playwrightExpect.configure({timeout:30_000});
const root=await mkdtemp(join(tmpdir(),'most-fragments-'));const staticDir=join(root,'web-release');
await cp(resolve('apps/web/dist'),staticDir,{recursive:true});
const releaseManifestHash=createHash('sha256').update(await readFile(join(staticDir,'release-manifest.json'))).digest('hex');
if(releaseManifestHash!==expectedHash)throw new Error('The copied frontend does not match the agreed release.');
await mkdir('artifacts/screenshots',{recursive:true});
const keys=generateKeyPairSync('ed25519');
const app=await buildApp({dataDir:join(root,'data'),staticDir,trustedOrigins:[origin],secureCookies:false,seedDemo:true,signingKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()});
let browser:Browser|undefined;let page:Page|undefined;
const checks:{name:string;passed:boolean;detail?:unknown}[]=[];const pageErrors:string[]=[];
function check(name:string,passed:boolean,detail?:unknown){checks.push({name,passed,...(detail===undefined?{}:{detail})});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
async function snapshot(){return page!.evaluate(async()=>{const response=await fetch('/api/snapshot');if(!response.ok)throw new Error(`snapshot ${response.status}`);return response.json();});}
async function navigate(name:string){await page!.locator('nav button').filter({has:page!.getByText(name,{exact:true})}).click();await expect(page!.locator('.route-loading')).toHaveCount(0);}
async function screenshot(name:string){const close=page!.getByRole('button',{name:'Zamknij komunikat',exact:true});if(await close.isVisible())await close.click();await page!.screenshot({path:`artifacts/screenshots/fragments-${name}.png`,fullPage:true});}
async function importThroughUi(model:DomainModel,name:string,excludedMode:string){
  await navigate('Gotowość');await page!.getByRole('button',{name:'Importuj dane',exact:true}).click();const dialog=page!.getByRole('dialog');
  const json=JSON.stringify(model,null,2);await dialog.getByLabel('Plik JSON / CSV lub dokument PDF / DOCX').setInputFiles({name:`${name}.json`,mimeType:'application/json',buffer:Buffer.from(json)});
  await expect(dialog.getByRole('textbox',{name:'Dane do importu',exact:true})).toHaveValue(json);await dialog.getByRole('button',{name:'Sprawdź i pokaż różnice',exact:true}).click();
  await expect(dialog.getByText('Podgląd dopuszczony z wykluczeniami. Wskazane fragmenty nie będą używane do planowania.',{exact:true})).toBeVisible();
  await expect(dialog.locator('.excluded-fragments')).toContainText(excludedMode);
  await screenshot(`${name}-preview`);
  await dialog.getByRole('button',{name:'Zatwierdź dokładnie ten podgląd',exact:true}).click();await expect(dialog).toHaveCount(0);
  const state=await snapshot();check(`${name}: preview accepted through UI and independent model remains valid`,state.modelValidation.valid===true&&state.modelValidation.blockedFragments.some((fragment:any)=>fragment.kind==='mode'&&model.modes.find(mode=>mode.name===excludedMode)?.id===fragment.id),state.modelValidation.blockedFragments);
  const readiness=page!.locator('section.panel').filter({has:page!.getByRole('heading',{name:'Aktualność parametrów i prób',exact:true})});
  const row=readiness.getByRole('row').filter({has:page!.getByText(excludedMode,{exact:true})});
  await expect(row).toContainText('Wykluczony z planowania');await expect(row.locator('.badge.green')).toHaveCount(0);
  check(`${name}: readiness explicitly excludes the affected mode`,true);await screenshot(`${name}-readiness`);return state;
}
async function calculateThroughUi(name:string,minimumMinutes:number,excludedModeId:string){
  await navigate('Plany i przydziały');await page!.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();
  await expect(page!.locator('.plan-metrics')).toContainText(String(minimumMinutes));
  await expect(page!.getByRole('heading',{name:'Nie utrzymamy jednocześnie wszystkich minimów',exact:true})).toBeVisible();
  await expect(page!.locator('.planning-results .excluded-fragments')).toContainText('Wykluczone fragmenty modelu');
  const stored=await page!.evaluate(()=>new Promise<any[]>((resolveRows,reject)=>{const request=indexedDB.open('most-device-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const transaction=db.transaction('proposals','readonly');const get=transaction.objectStore('proposals').getAll();transaction.oncomplete=()=>{resolveRows(get.result);db.close();};transaction.onerror=()=>{reject(transaction.error);db.close();};};}));
  const proposal=stored.filter(row=>row.type==='local.plan').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).at(-1);const plan=proposal?.payload.plan;
  check(`${name}: partial plan remains feasible without excluded actions`,plan?.validation.valid===true&&['optimal','feasible'].includes(plan.status)&&plan.metrics.minimumServiceMinutes===minimumMinutes&&plan.actions.length===2&&plan.actions.every((action:any)=>action.modeId!==excludedModeId),{status:plan?.status,metrics:plan?.metrics,modeIds:plan?.actions.map((action:any)=>action.modeId),blockedFragments:plan?.validation.blockedFragments});
  await screenshot(`${name}-plan`);
}
async function graphThroughUi(name:string,missingId?:string){
  await navigate('Zależności');await expect(page!.locator('.graph-panel .react-flow__node').first()).toBeVisible();
  await expect.poll(()=>page!.evaluate(()=>{const fiber=document.querySelector('.react-flow__node[data-id="fiber"]')?.getBoundingClientRect();const uplink=document.querySelector('.react-flow__node[data-id="uplink"]')?.getBoundingClientRect();const digital=document.querySelector('.react-flow__node[data-id="digital-connection"]')?.getBoundingClientRect();return Boolean(fiber&&uplink&&digital&&fiber.right<uplink.left&&uplink.right<digital.left);})).toBe(true);
  await expect(page!.locator('.notice.red')).toHaveCount(0);
  if(missingId){const node=page!.locator(`.react-flow__node[data-id="${missingId}"]`);await expect(node).toContainText(`Brak definicji: ${missingId}`);await expect(node).toContainText('Wykluczony z planowania');}
  check(`${name}: graph lays out exclusions without an uncaught error`,pageErrors.length===0,{missingId,pageErrors:[...pageErrors]});await screenshot(`${name}-graph`);
}
try{
  await app.listen({host:'127.0.0.1',port:8096});browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'pl-PL'});page=await context.newPage();page.setDefaultTimeout(30_000);page.on('pageerror',error=>pageErrors.push(error.stack||error.message));
  await page.goto(origin);await page.getByLabel('Nazwa organizacji',{exact:true}).fill('MOST: syntetyczny test wykluczeń');await page.getByLabel('Imię i nazwisko lub nazwa dyżuru',{exact:true}).fill('Koordynator testu wykluczeń');await page.getByLabel('Nazwa użytkownika',{exact:true}).fill('fragments-test');await page.getByLabel(/^Hasło/).fill(randomUUID()+randomUUID());await page.getByRole('button',{name:'Utwórz organizację',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible();
  const initial=await snapshot();const baseline:DomainModel=structuredClone(initial.model);const provenance={source:'MOST fragment browser fixture v1, dane syntetyczne',checkedAt:new Date().toISOString(),synthetic:true};
  const cycle=structuredClone(baseline);cycle.dependencies.push({id:'cycle-or',name:'OR z cyklem i działającą gałęzią',kind:'or',inputs:['fiber','cycle-back'],provenance},{id:'cycle-back',name:'Powrót do OR',kind:'and',inputs:['cycle-or','fiber'],provenance});cycle.modes.find(mode=>mode.id==='coord-radio')!.dependencyId='cycle-or';
  await importThroughUi(cycle,'cycle-or','Radio niezależne');await calculateThroughUi('cycle-or',195,'coord-radio');await graphThroughUi('cycle-or');
  const missing=structuredClone(baseline);missing.dependencies.push({id:'missing-or',name:'OR z brakującym wejściem',kind:'or',inputs:['fiber','missing-source'],provenance});missing.modes.find(mode=>mode.id==='water-generator')!.dependencyId='missing-or';
  await importThroughUi(missing,'missing-input','Agregat przy pompie');await calculateThroughUi('missing-input',220,'water-generator');await graphThroughUi('missing-input','missing-source');
  const final=await snapshot();check('No global reservations were fabricated while calculating local proposals',final.allocations.length===0&&final.actions.length===0);check('No browser page errors in both complete flows',pageErrors.length===0,pageErrors);
}catch(error){const detail=error instanceof Error?error.stack:String(error);console.error(detail?.slice(0,1800));checks.push({name:'complete flow',passed:false,detail});if(page)await screenshot('failure').catch(()=>{});process.exitCode=1;}
finally{
  await writeFile('artifacts/fragment-browser-verification.json',JSON.stringify({at:new Date().toISOString(),passed:checks.length>0&&checks.every(check=>check.passed),origin,releaseManifestHash,synthetic:true,checks,pageErrors},null,2));
  await browser?.close();await app.close();
}
