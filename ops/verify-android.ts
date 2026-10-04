/** Reproducible Android emulator proof. Uses a temporary synthetic database and generated credentials.
 * Never targets a physical device: launching Chrome force-stops that emulator's browser.
 * Run after pnpm build-offline: pnpm exec tsx ops/verify-android.ts
 */
import { _android, expect as playwrightExpect, type BrowserContext, type Page } from '@playwright/test';
import { buildApp } from '../apps/api/src/app.ts';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';

const sdkRoot=process.env.ANDROID_SDK_ROOT??(process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'Android','Sdk'):undefined);
const adb=process.env.ADB_PATH??(sdkRoot?join(sdkRoot,'platform-tools',process.platform==='win32'?'adb.exe':'adb'):'adb');
const expect=playwrightExpect.configure({timeout:60000});
function selectEmulator(){
  if(process.env.MOST_ANDROID_SERIAL)return process.env.MOST_ANDROID_SERIAL;
  const candidates=execFileSync(adb,['devices'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/).map(line=>line.match(/^(emulator-\d+)\s+device\b/)?.[1]).filter((value):value is string=>Boolean(value));
  for(const candidate of candidates){const name=execFileSync(adb,['-s',candidate,'emu','avd','name'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0].trim();if(name==='MOST_Verification_API_36')return candidate;}
  throw new Error('Nie znaleziono uruchomionego dedykowanego AVD MOST_Verification_API_36. Uruchom ten AVD albo jawnie ustaw MOST_ANDROID_SERIAL na emulator przeznaczony do tej próby. Runner nie wybiera automatycznie współdzielonego emulatora.');
}
const serial=selectEmulator();
if(!serial.startsWith('emulator-'))throw new Error('This script is restricted to an emulator. Physical devices require a separate non-disruptive test.');
const origin='http://localhost:8093',artifactDir=resolve('artifacts/android');
await mkdir(artifactDir,{recursive:true});
let previousEvidenceArchive:string|undefined;
try{const previous=JSON.parse(await readFile(join(artifactDir,'verification-final.json'),'utf8')),stamp=new Date(Number.isFinite(Date.parse(previous.at))?Date.parse(previous.at):Date.now()).toISOString().replace(/[:.]/g,'-');previousEvidenceArchive=join('history',`${stamp}-${String(previous.releaseManifestHash??'pending').replace(/[^a-zA-Z0-9]/g,'').slice(0,12)}`);await mkdir(join(artifactDir,previousEvidenceArchive),{recursive:true});for(const file of ['verification.json','verification-final.json','verification-recovery.json','offline-device-export.json','01-prepared.png','02-four-person-plan.png','03-offline-three-person-plan.png','04-offline-report-after-restart.png'])try{await cp(join(artifactDir,file),join(artifactDir,previousEvidenceArchive,file));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
await writeFile(join(artifactDir,'verification-final.json'),JSON.stringify({at:new Date().toISOString(),passed:false,target:'Android emulator',physicalPhone:false,status:'verification_started_not_complete',previousEvidenceArchive},null,2));await writeFile(join(artifactDir,'verification-recovery.json'),JSON.stringify({at:new Date().toISOString(),passed:false,status:'no_recovery_used_by_current_attempt',previousEvidenceArchive},null,2));await access('apps/web/dist/index.html');await access('apps/web/dist/sw.js');
const dataDir=await mkdtemp(join(tmpdir(),'most-android-'));
const staticDir=join(dataDir,'web');await cp(resolve('apps/web/dist'),staticDir,{recursive:true});
const releaseManifestHash=createHash('sha256').update(await readFile(join(staticDir,'release-manifest.json'))).digest('hex');
const keys=generateKeyPairSync('ed25519');
const app=await buildApp({dataDir,staticDir,trustedOrigins:[origin],secureCookies:false,seedDemo:true,signingKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()});
const checks:{name:string;passed:boolean;detail?:unknown}[]=[],errors:string[]=[],metrics:Record<string,unknown>={};
const records:{baselinePlanId?:string;reducedPlanId?:string;commandIds:string[]}={commandIds:[]};
let context:BrowserContext|undefined,page:Page|undefined,appClosed=false;
// Device discovery only reads ADB metadata. Never install a driver on personal devices.
console.log('Discovering Android devices without installing any driver.');
const devices=await _android.devices({omitDriverInstall:true});
const device=devices.find(d=>d.serial()===serial);
for(const other of devices)if(other!==device)await other.close();
if(!device)throw new Error(`Android emulator ${serial} is not attached.`);
device.setDefaultTimeout(120000);
const previousDebugApp=adbRun('shell','settings','get','global','debug_app');
const environment={avdName:adbRun('emu','avd','name').split(/\r?\n/)[0].trim(),androidVersion:adbRun('shell','getprop','ro.build.version.release'),chromeVersion:adbRun('shell','dumpsys','package','com.android.chrome').match(/versionName=([^\s]+)/)?.[1]??'unknown'};
function check(name:string,passed:boolean,detail?:unknown){checks.push({name,passed,...(detail===undefined?{}:{detail})});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
function adbRun(...args:string[]){return execFileSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true}).trim();}
function assertNativeScreenReady(){
  adbRun('shell','uiautomator','dump','/sdcard/most-native-screen.xml');
  const xml=adbRun('shell','cat','/sdcard/most-native-screen.xml');
  if(/isn(?:'|&apos;)t responding|is not responding|text="No thanks"|text="Continue"/i.test(xml))throw new Error('Natywna nakładka Androida lub Chrome zasłania próbę. Przygotuj dedykowany emulator i powtórz pełny test; sam stan DOM nie jest dowodem widocznego ekranu.');
  const focus=adbRun('shell','dumpsys','window','windows').split(/\r?\n/).find(line=>line.includes('mCurrentFocus='));
  if(!focus?.includes('com.android.chrome'))throw new Error(`Chrome nie jest aktywnym ekranem natywnym: ${focus??'brak okna z focusem'}`);
}
async function navigate(label:string){console.log(`Navigate: ${label}`);await expect(page!.locator('.app-shell')).toBeVisible();const menu=page!.getByRole('button',{name:'Otwórz menu',exact:true});if(await menu.isVisible()){await menu.click();await expect(page!.locator('.sidebar')).toHaveClass(/open/);}await page!.getByRole('button',{name:label,exact:true}).click();}
async function rows(store:string){return page!.evaluate(async name=>new Promise<any[]>((ok,fail)=>{const request=indexedDB.open('most-device-v1');request.onerror=()=>fail(request.error);request.onsuccess=()=>{const database=request.result,transaction=database.transaction(name,'readonly'),read=transaction.objectStore(name).getAll();read.onsuccess=()=>{ok(read.result);database.close();};read.onerror=()=>fail(read.error);};}),store);}
async function screenshot(name:string){const heading=name==='01-prepared.png'?'Pakiet lokalny przygotowany':name==='02-four-person-plan.png'?'Wszystkie minima od 30. minuty':name==='03-offline-three-person-plan.png'?'Nie utrzymamy jednocześnie wszystkich minimów':undefined;if(heading)await page!.getByRole('heading',{name:heading,exact:true}).evaluate(el=>el.scrollIntoView({block:'center'}));if(name==='04-offline-report-after-restart.png')await page!.getByText('Test Android offline: Daniel opuścił obsadę. Nowy plan potwierdza niedobór obsługi wody.',{exact:true}).evaluate(el=>el.scrollIntoView({block:'center'}));if(name!=='failure.png')assertNativeScreenReady();await device!.screenshot({path:join(artifactDir,name)});}
async function freshPage(){const fresh=await context!.newPage();for(const older of context!.pages())if(older!==fresh&&older.url().startsWith(`${origin}/`))await older.close();return fresh;}
function nativeDownloads(){
  const files=adbRun('shell','ls','-1','/sdcard/Download').split(/\r?\n/).filter(name=>/^most-urzadzenie(?: \(\d+\))?\.json$/.test(name));
  return new Map(files.map(name=>[name,adbRun('shell','stat','-c','%s:%Y',`"/sdcard/Download/${name}"`)]));
}
async function exportFromAndroidDownloads(){
  // Android Chrome delegates downloads to Android's download manager and does
  // not emit Playwright's desktop download event. Check the real saved file.
  const before=nativeDownloads();let savedName:string|undefined;
  await page!.getByRole('button',{name:'Eksport danych, plików i kolejki'}).click();
  await expect.poll(async()=>{
    savedName=[...nativeDownloads()].find(([name,stamp])=>before.get(name)!==stamp)?.[0];
    if(savedName)return true;
    let xml='';try{adbRun('shell','uiautomator','dump','/sdcard/most-export-dialog.xml');xml=adbRun('shell','cat','/sdcard/most-export-dialog.xml');}catch{return false;}
    if(/download[^<]*again|pobrać[^<]*ponownie/i.test(xml)){
      const button=xml.match(/<node\b[^>]*\btext="(?:Download|Pobierz)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if(button)adbRun('shell','input','tap',String(Math.floor((Number(button[1])+Number(button[3]))/2)),String(Math.floor((Number(button[2])+Number(button[4]))/2)));
    }
    return false;
  },{timeout:60000,intervals:[1000,2000,4000]}).toBe(true);
  const target=join(artifactDir,'offline-device-export.json');
  execFileSync(adb,['-s',serial,'pull',`/sdcard/Download/${savedName}`,target],{encoding:'utf8',windowsHide:true});
  return JSON.parse(await readFile(target,'utf8'));
}
async function computeExpected(expectedMinutes:number){
  // First exercise the unchanged product default. A valid interrupted incumbent
  // is recorded honestly; the explicit larger UI budget can then prove the oracle.
  for(const budgetMs of [5000,30000]){
    await page!.getByRole('combobox',{name:'Budżet obliczenia',exact:true}).selectOption(String(budgetMs));
    const before=new Set((await rows('proposals')).map(row=>row.id));
    await page!.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();
    await expect.poll(async()=>(await rows('proposals')).filter(row=>!before.has(row.id)&&row.type==='local.plan').length,{timeout:90000}).toBeGreaterThan(0);
    const proposal=(await rows('proposals')).find(row=>!before.has(row.id)&&row.type==='local.plan'),plan=proposal.payload.plan;
    const attempts=(metrics.calculationAttempts??=[]) as unknown[];attempts.push({expectedMinutes,budgetMs,status:plan.status,metrics:plan.metrics,timings:plan.solver.timings,interruption:plan.solver.interruption??null});
    if(plan.validation.valid&&plan.metrics.minimumServiceMinutes===expectedMinutes)return proposal;
    check(`Jawny wynik ograniczonego budżetu ${budgetMs} ms`,budgetMs===5000&&!plan.solver.completeHierarchy&&(plan.validation.valid&&plan.status==='feasible'||!plan.validation.valid&&plan.status==='no_solution'),{status:plan.status,minimumServiceMinutes:plan.metrics.minimumServiceMinutes,timings:plan.solver.timings});
    if(plan.status==='no_solution')await expect(page!.getByRole('heading',{name:'Nie znaleziono sprawdzonego planu',exact:true})).toBeVisible();
  }
  throw new Error(`Nie uzyskano oczekiwanych ${expectedMinutes} usługominut także przy jawnym budżecie30s.`);
}
async function reopenOffline(){const start=performance.now();await context?.close();context=await device!.launchBrowser({offline:true,locale:'pl-PL',viewport:null});context.setDefaultTimeout(30000);page=await freshPage();page.on('pageerror',e=>errors.push(e.message));const navigationStart=performance.now();await page.goto(origin,{waitUntil:'domcontentloaded'});await expect(page.getByRole('heading',{name:'Zaplanuj pracę usług podczas awarii',exact:true})).toBeVisible({timeout:30000});await expect(page.locator('.connection-status')).toContainText('Brak serwera');const finished=performance.now();((metrics.coldStartStages??=[]) as unknown[]).push({browserRestartAndTabCleanupMs:navigationStart-start,navigationToReadyMs:finished-navigationStart,totalMs:finished-start});return finished-start;}
try{
  await app.listen({host:'127.0.0.1',port:8093});adbRun('reverse','tcp:8093','tcp:8093');
  // Only this emulator is touched. Restore the prior debug-app setting below.
  adbRun('shell','am','set-debug-app','--persistent','com.android.chrome');
  console.log('Launching emulator Chrome.');context=await device.launchBrowser({locale:'pl-PL',viewport:null});context.setDefaultTimeout(30000);page=await freshPage();
  const session=await context.newCDPSession(page);await session.send('Storage.clearDataForOrigin',{origin,storageTypes:'all'});await session.detach();
  page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.getByLabel('Imię i nazwisko lub nazwa dyżuru').fill('Syntetyczny test Android');await page.getByLabel('Nazwa użytkownika',{exact:true}).fill('android-verification');await page.getByLabel(/^Hasło/).fill(randomUUID()+randomUUID());await page.getByRole('button',{name:'Utwórz organizację'}).click();
  await expect(page.getByRole('heading',{name:'Zaplanuj pracę usług podczas awarii',exact:true})).toBeVisible();
  check('Lokalne konto i pełny interfejs Android',true,{model:device.model(),android:adbRun('shell','getprop','ro.build.version.release'),browser:await page.evaluate(()=>navigator.userAgent),transport:'adb reverse, localhost:8093',physicalPhone:false});
  await page.evaluate(()=>Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Service Worker not ready after 60 seconds.')),60000))]));await page.reload({waitUntil:'domcontentloaded'});
  await navigate('To urządzenie');await page.getByRole('button',{name:'Pobierz klucz publiczny',exact:true}).click();const expectedKeyId=createHash('sha256').update(keys.publicKey.export({type:'spki',format:'pem'})).digest('hex').slice(0,16);await expect(page.locator('.fingerprint')).toContainText(expectedKeyId);await page.getByRole('checkbox',{name:/Porównałem identyfikator/}).check();const prepareStart=performance.now();await page.getByRole('button',{name:'Przygotuj urządzenie',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('h2')).some(node=>node.textContent==='Pakiet lokalny przygotowany')||document.querySelector('.preparation-progress')?.textContent?.startsWith('Przygotowanie przerwane:'),null,{timeout:180000});
  const preparePhase=await page.locator('.preparation-progress').innerText();if(preparePhase.startsWith('Przygotowanie przerwane:'))throw new Error(preparePhase);
  await expect(page.getByRole('heading',{name:'Pakiet lokalny przygotowany'})).toBeVisible();metrics.prepareAndVerifyPackageMs=performance.now()-prepareStart;
  const prepared=(await rows('meta')).find(r=>r.key.startsWith('prepared:'))?.value;check('Lokalny WASM i podpisany pakiet PWA przygotowane',prepared?.signatureVerified&&['optimal','feasible'].includes(prepared?.solverStatus),{signatureVerified:prepared?.signatureVerified,solverStatus:prepared?.solverStatus,minimumServiceMinutes:prepared?.minimumServiceMinutes,persistent:prepared?.persistent,wasmHash:prepared?.wasmHash});await screenshot('01-prepared.png');
  await navigate('Plany i przydziały');const baseline=(await computeExpected(310)).payload.plan;records.baselinePlanId=baseline.id;await expect(page.getByRole('heading',{name:'Wszystkie minima od 30. minuty'})).toBeVisible();
  check('Cztery osoby dają 310 usługominut',baseline.validation.valid&&baseline.metrics.minimumServiceMinutes===310,baseline.metrics);metrics.baseline=baseline.solver.timings;await screenshot('02-four-person-plan.png');
  await app.close();appClosed=true;adbRun('reverse','--remove','tcp:8093');
  metrics.coldOfflineStartMs=await reopenOffline();check('Zimny start po zatrzymaniu Chrome i serwera, bez sieci',true,{elapsedMs:metrics.coldOfflineStartMs});
  await navigate('Plany i przydziały');await page.getByRole('combobox',{name:'Daniel, pompa',exact:true}).selectOption('unavailable');const start=performance.now(),reducedProposal=await computeExpected(220);await expect(page.getByRole('heading',{name:'Nie utrzymamy jednocześnie wszystkich minimów'})).toBeVisible();metrics.offlineCalculationAndRenderMs=performance.now()-start;
  const reduced=reducedProposal.payload.plan;records.reducedPlanId=reduced.id;check('Model nowego wariantu zawiera nieobecność Daniela',reducedProposal.payload.model.resources.find((r:any)=>r.id==='person-4')?.state==='unavailable');
  check('Nowe lokalne obliczenie 4 do 3 osób bez serwera',reduced?.validation.valid&&reduced.metrics.minimumServiceMinutes===220&&reduced.metrics.simultaneousMinimumFromMinute===null,{metrics:reduced?.metrics,timings:reduced?.solver.timings});metrics.offlineSolver=reduced.solver.timings;await screenshot('03-offline-three-person-plan.png');
  await navigate('Meldunki');await page.getByRole('button',{name:'Nowy meldunek',exact:true}).click();await page.getByLabel('Oryginalna treść').fill('Test Android offline: Daniel opuścił obsadę. Nowy plan potwierdza niedobór obsługi wody.');await page.getByLabel('Źródło informacji').fill('Syntetyczne ćwiczenie emulatora Android');await page.getByLabel('Element, którego dotyczy').selectOption('person-4');await page.getByLabel('Stan opisany w meldunku').selectOption('unavailable');await page.getByRole('button',{name:'Zapisz meldunek',exact:true}).click();await expect(page.getByText('Test Android offline: Daniel opuścił obsadę. Nowy plan potwierdza niedobór obsługi wody.',{exact:true})).toBeVisible();
  records.commandIds=(await rows('outbox')).filter(r=>r.command.type==='observation.create'&&r.status==='pending'&&r.command.payload.text==='Test Android offline: Daniel opuścił obsadę. Nowy plan potwierdza niedobór obsługi wody.').map(r=>r.commandId);check('Meldunek zapisany w trwałej kolejce',records.commandIds.length===1);
  metrics.secondColdOfflineStartMs=await reopenOffline();await navigate('Meldunki');await expect(page.getByText('Test Android offline: Daniel opuścił obsadę. Nowy plan potwierdza niedobór obsługi wody.',{exact:true})).toBeVisible();check('Meldunek odczytany po kolejnym zimnym restarcie',true);await screenshot('04-offline-report-after-restart.png');
  const retained=(await rows('proposals')).filter(r=>r.type==='local.plan');check('Zachowano obydwa lokalne plany po restarcie',retained.some(r=>r.payload.plan.id===baseline.id)&&retained.some(r=>r.payload.plan.id===reduced.id));
  await navigate('To urządzenie');const exported=await exportFromAndroidDownloads();check('Eksport danych i kolejki dostępny offline',exported.format==='most-device-export'&&exported.proposals.some((row:any)=>row.payload.plan?.id===baseline.id)&&exported.proposals.some((row:any)=>row.payload.plan?.id===reduced.id)&&records.commandIds.every(id=>exported.outbox.some((row:any)=>row.commandId===id&&row.command.type==='observation.create'&&row.status==='pending')),{source:'Real file saved by Android Chrome in /sdcard/Download',records,proposals:exported.proposals.length,pending:exported.outbox.filter((row:any)=>row.status==='pending').length});
  check('Brak błędów JavaScript',errors.length===0,errors);
}catch(error){checks.push({name:'Przerwanie testu Android',passed:false,detail:error instanceof Error?error.message:String(error)});process.exitCode=1;try{await screenshot('failure.png');await writeFile(join(artifactDir,'failure-dom.txt'),await page!.locator('body').innerText());}catch{};console.error(error instanceof Error?error.message:String(error));}
finally{const result={at:new Date().toISOString(),target:'Android emulator',physicalPhone:false,serial,environment,releaseManifestHash,previousEvidenceArchive,passed:checks.every(c=>c.passed),checks,records,metrics,limitations:['Wynik emulatora nie zastępuje pomiaru na docelowym fizycznym telefonie.','Test korzysta z aplikacji PWA w Chrome, bez instalowania skrótu na ekranie głównym.']};await writeFile(join(artifactDir,'verification.json'),JSON.stringify(result,null,2));await writeFile(join(artifactDir,'verification-final.json'),JSON.stringify({...result,verificationMode:'Single complete attempt; a failed attempt remains explicitly failed.',stages:[{path:'verification.json',passed:result.passed}]},null,2));await context?.close().catch(()=>{});await device.close().catch(()=>{});if(!appClosed){await app.close();try{adbRun('reverse','--remove','tcp:8093');}catch{}}try{if(previousDebugApp&&previousDebugApp!=='null')adbRun('shell','am','set-debug-app','--persistent',previousDebugApp);else adbRun('shell','am','clear-debug-app');}catch{};console.log(JSON.stringify({passed:result.passed,checks:checks.length,artifactDir}));}

