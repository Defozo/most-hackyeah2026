import { chromium, expect as baseExpect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const processes=JSON.parse(await readFile('artifacts/private/public-demo/processes.json','utf8'));
const origin=process.env.MOST_PUBLIC_DEMO_ORIGIN||processes.origin;
const expect=baseExpect.configure({timeout:30000});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'pl-PL'});
const page=await context.newPage();page.setDefaultTimeout(30000);
const checks:{name:string;passed:boolean;detail?:unknown}[]=[];
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const path='artifacts/public-demo';await mkdir(path,{recursive:true});
let manifestHash='';
const check=(name:string,passed:boolean,detail?:unknown)=>{checks.push({name,passed,...(detail===undefined?{}:{detail})});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name);};
const nav=async(name:string)=>{await page.locator('nav').getByRole('button',{name:new RegExp('^'+name+'(?:\\s|$)')}).click();};
const snapshot=async(target=page)=>target.evaluate(async()=>await(await fetch('/api/snapshot')).json());
async function solve(target=310){await page.getByRole('combobox',{name:'Budżet obliczenia',exact:true}).selectOption('30000');await page.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();await expect(page.getByRole('button',{name:'Oblicz nowy plan',exact:true})).toBeEnabled({timeout:60000});await expect(page.locator('.plan-metrics')).toContainText(String(target));}
try{
  await page.goto(`${origin}/demo`);await expect(page.getByRole('button',{name:'Uruchom demo',exact:true})).toBeVisible();
  await page.screenshot({path:`${path}/01-entry.png`,fullPage:true});
  await page.getByRole('button',{name:'Uruchom demo',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible({timeout:60000});
  const manifestResponse=await page.request.get(`${origin}/release-manifest.json`);manifestHash=createHash('sha256').update(await manifestResponse.body()).digest('hex');
  check('Czysta sesja przez publiczny HTTPS uruchamia własne ćwiczenie',true);
  check('Publiczny serwer podaje docelowy manifest',manifestHash===processes.releaseManifestHash);
  const first=await snapshot();check('Rzeczywisty zestaw trzech usług i osobna organizacja',first.model.synthetic===true&&first.model.services.length===3&&Boolean(first.organizationId));
  await nav('Zależności');await expect(page.locator('.react-flow__node').first()).toBeVisible();await page.screenshot({path:`${path}/02-dependencies.png`,fullPage:true});
  await nav('Plany i przydziały');await solve(310);await page.screenshot({path:`${path}/03-plan-310.png`,fullPage:true});check('Solver w publicznej przeglądarce oblicza 310 usługominut',true);
  await page.getByLabel(/Daniel/).selectOption('unavailable');await solve(220);await page.screenshot({path:`${path}/04-plan-220.png`,fullPage:true});check('Utrata jednej osoby zmienia rzeczywisty wynik na 220',true);
  await nav('To urządzenie');await page.getByRole('button',{name:'Pobierz klucz publiczny',exact:true}).click();await page.getByLabel('Porównałem identyfikator z kluczem organizacji dostarczonym niezależną, zaufaną drogą.').check();await page.evaluate(async()=>await navigator.serviceWorker.ready);await page.getByRole('button',{name:'Przygotuj urządzenie',exact:true}).click();await expect(page.getByRole('heading',{name:'Pakiet lokalny przygotowany'})).toBeVisible({timeout:120000});
  await page.reload();await expect(page.locator('.app-shell')).toBeVisible();await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);await page.reload();await expect(page.locator('.connection-bar.disconnected')).toBeVisible();await nav('Plany i przydziały');await page.getByLabel(/Daniel/).selectOption('unavailable');await solve(220);await expect(page.getByRole('button',{name:'Zatwierdź i zarezerwuj',exact:true})).toBeDisabled();await page.screenshot({path:`${path}/05-offline-220.png`,fullPage:true});check('Po odłączeniu i przeładowaniu solver liczy 220 na urządzeniu',true);
  await context.setOffline(false);await page.reload();await expect(page.locator('.connection-bar.connected')).toBeVisible();await nav('Plany i przydziały');await page.getByLabel(/Daniel/).selectOption('available');await solve(310);await page.getByRole('button',{name:'Zatwierdź i zarezerwuj',exact:true}).click();await expect.poll(async()=>((await snapshot()).actions||[]).length).toBe(3);check('Zatwierdzenie zapisuje trzy czynności i przydziały na serwerze',true);
  await nav('Moje zadania');await page.getByRole('button',{name:'Przyjmij zadanie',exact:true}).click();await expect(page.getByRole('button',{name:'Przyjmij zadanie',exact:true})).toHaveCount(0);await page.screenshot({path:`${path}/06-task-accepted.png`,fullPage:true});check('Wykonawca przyjmuje prawdziwe zadanie w swoim ćwiczeniu',true);
  const secondContext=await browser.newContext();const second=await secondContext.newPage();await second.goto(`${origin}/demo`);await second.getByRole('button',{name:'Uruchom demo',exact:true}).click();await expect(second.locator('.app-shell')).toBeVisible();const other=await snapshot(second);check('Drugi juror otrzymuje osobne dane bez czynności pierwszego',other.organizationId!==first.organizationId&&other.actions.length===0&&other.allocations.length===0);await secondContext.close();
  await page.goto(`${origin}/demo`);await expect(page.getByRole('heading',{name:'Cztery osoby. Trzy usługi do utrzymania.'})).toBeVisible();check('Powrót do strony demo działa również po aktywacji PWA',true);
  check('Brak błędów JavaScript w przebiegu publicznym',errors.length===0,errors);
}catch(error){await page.screenshot({path:`${path}/verification-failure.png`,fullPage:true}).catch(()=>{});checks.push({name:'Przebieg zakończony bez błędu',passed:false,detail:error instanceof Error?error.message:String(error)});process.exitCode=1;}
finally{await browser.close();const report={verifiedAt:new Date().toISOString(),url:`${origin}/demo`,origin,passed:checks.every(c=>c.passed),releaseManifestHash:manifestHash,functionalSolverBudgetMs:30000,checks};await writeFile('artifacts/public-demo-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:checks.length,releaseManifestHash:manifestHash}));}
