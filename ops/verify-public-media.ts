import { chromium, expect as baseExpect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const expect=baseExpect.configure({timeout:30000});
const access=JSON.parse(await readFile('DEMO_ACCESS.json','utf8'));
const origin=new URL(access.url).origin;
const files=['MOST-pitch.pdf','MOST-pitch.pptx','MOST-film.mp4','MOST-film.vtt','MOST-source.zip','URUCHOMIENIE.txt','plan.png'];
const checks:{name:string;passed:boolean;detail?:unknown}[]=[];
const check=(name:string,passed:boolean,detail?:unknown)=>{checks.push({name,passed,...(detail===undefined?{}:{detail})});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);};
await mkdir('artifacts/public-demo',{recursive:true});
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'pl-PL'});const page=await context.newPage();
const snapshot=()=>page.evaluate(async()=>await(await fetch('/api/snapshot')).json());
async function solve(){await page.locator('nav').getByRole('button',{name:'Plany i przydziały',exact:true}).click();await page.getByRole('combobox',{name:'Budżet obliczenia',exact:true}).selectOption('30000');await page.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();await expect(page.getByRole('button',{name:'Oblicz nowy plan',exact:true})).toBeEnabled({timeout:60000});await expect(page.locator('.plan-metrics')).toContainText('310');}
try{
  for(const file of files){
    const local=await readFile(`output/public/${file}`);
    const response=await page.request.get(`${origin}/materialy/${file}`,{timeout:120000});
    const bytes=await response.body();
    check(`Publiczne pobranie ${file} ma tę samą sumę SHA-256`,response.ok()&&createHash('sha256').update(bytes).digest('hex')===createHash('sha256').update(local).digest('hex'),{bytes:bytes.length,contentType:response.headers()['content-type']});
  }
  const range=await page.request.get(`${origin}/materialy/MOST-film.mp4`,{headers:{range:'bytes=0-4095'}});check('Film obsługuje Range: HTTP 206 i zakres 4096 bajtów',range.status()===206&&(await range.body()).length===4096&&/^bytes 0-4095\//.test(range.headers()['content-range']||''),range.headers()['content-range']);
  const missing=await page.request.get(`${origin}/materialy/no-such-file.pdf`);check('Nieistniejący plik ma HTTP 404',missing.status()===404);
  await page.goto(`${origin}/materialy`);await expect(page.getByRole('heading',{name:'Awaria wspólnego routera. Trzy usługi do utrzymania.'})).toBeVisible();check('Świeża przeglądarka otwiera mediahub z przekierowaniem /materialy/',page.url()===`${origin}/materialy/`);
  await expect.poll(()=>page.locator('video').evaluate((element:HTMLVideoElement)=>element.readyState>=1&&Number.isFinite(element.duration)&&element.duration>0)).toBe(true);
  await page.locator('video').evaluate(async(element:HTMLVideoElement)=>{element.muted=true;await element.play();});await expect.poll(()=>page.locator('video').evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeGreaterThan(1);await page.locator('video').evaluate((element:HTMLVideoElement)=>element.pause());check('Film rzeczywiście odtwarza się z publicznego hostingu',true);
  await page.screenshot({path:'artifacts/public-demo/mediahub.png',fullPage:true});
  await page.goto(`${origin}/demo`);await expect(page.getByRole('heading',{name:'Cztery osoby. Trzy usługi do utrzymania.'})).toBeVisible();await page.screenshot({path:'artifacts/public-demo/01-entry.png',fullPage:true});await page.getByRole('button',{name:'Uruchom demo',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible();
  const original=await snapshot();await solve();await page.getByRole('button',{name:'Zatwierdź i zarezerwuj',exact:true}).click();await expect.poll(async()=>(await snapshot()).actions.length).toBe(3);
  await page.evaluate(async()=>await navigator.serviceWorker.ready);await page.reload();await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);await page.reload();await expect(page.locator('.app-shell')).toBeVisible();await context.setOffline(false);
  await page.goto(`${origin}/materialy/`);await expect(page.getByRole('heading',{name:'Awaria wspólnego routera. Trzy usługi do utrzymania.'})).toBeVisible();check('Po aktywacji PWA i offline -> online mediahub nie jest przechwycony',true);
  const served=await page.evaluate(async()=>{const results=[];for(const file of ['MOST-pitch.pdf','MOST-film.mp4']){const response=await fetch(`/materialy/${file}`,{headers:{range:'bytes=0-4095'}});results.push({file,status:response.status,type:response.headers.get('content-type'),bodyBytes:(await response.arrayBuffer()).byteLength});}return results;});check('PDF i MP4 po PWA pobierają prawidłowe pliki, a nie index aplikacji',served.every(row=>row.status===206&&row.bodyBytes===4096&&row.type?.startsWith(row.file.endsWith('.pdf')?'application/pdf':'video/mp4')),served);
  await page.goto(`${origin}/demo`);await page.getByRole('button',{name:'Nowe ćwiczenie',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible();const fresh=await snapshot();check('Nowe ćwiczenie w tej samej przeglądarce ma nową organizację i nie przejmuje zadań ani przydziałów',fresh.organizationId!==original.organizationId&&fresh.actions.length===0&&fresh.allocations.length===0&&fresh.plans.length===0);await solve();check('Nowe ćwiczenie w tej samej przeglądarce ponownie oblicza 310 usługominut',true);await page.screenshot({path:'artifacts/public-demo/07-new-exercise-310.png',fullPage:true});
}catch(error){checks.push({name:'Pełna kontrola mediów',passed:false,detail:error instanceof Error?error.message:String(error)});await page.screenshot({path:'artifacts/private/public-demo/media-verification-failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();const report={verifiedAt:new Date().toISOString(),url:`${origin}/materialy/`,passed:checks.every(c=>c.passed),functionalSolverBudgetMs:30000,checks};await writeFile('artifacts/public-media-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:checks.length}));}
