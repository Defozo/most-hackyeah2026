import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

const password=randomUUID()+randomUUID();
test.describe.configure({mode:'serial'});
const artifacts='artifacts/screenshots';
async function nav(page:Page,name:string){
  if(await page.getByRole('button',{name:'Otwórz menu',exact:true}).isVisible())await page.getByRole('button',{name:'Otwórz menu',exact:true}).click();
  await page.locator('nav button').filter({has:page.getByText(name,{exact:true})}).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.route-loading')).toHaveCount(0);
}
async function dismiss(page:Page){const close=page.getByRole('button',{name:'Zamknij komunikat',exact:true});if(!(await page.getByRole('dialog').count())&&await close.isVisible())await close.click();}
async function shot(page:Page,name:string){
  await dismiss(page);await page.screenshot({path:`${artifacts}/${name}.png`,fullPage:true});
  if(name==='offline')await page.locator('.connection-bar').screenshot({path:`${artifacts}/offline-status.png`});
  const detail:Record<string,string>={graph:'.graph-panel',plan:'.planning-results > .panel',uncertainty:'.check-list > .panel',tasks:'.verification-panel',offline:'.planning-results > .panel'};
  if(detail[name]){
    const target=page.locator(detail[name]).first();await target.scrollIntoViewIfNeeded();
    const box=await target.boundingBox();if(!box)throw new Error(`Missing evidence panel ${name}`);
    const timeline=['plan','offline'].includes(name)?await target.locator('.timeline').boundingBox():null;
    const height=timeline?timeline.y+timeline.height-box.y+16:Math.min(box.height,550);
    await page.screenshot({path:`${artifacts}/${name}-detail.png`,clip:{x:box.x,y:Math.max(0,box.y),width:box.width,height}});
  }
}
async function snapshot(page:Page){return page.evaluate(async()=>await(await fetch('/api/snapshot')).json());}
async function api(page:Page,path:string,body?:unknown){return page.evaluate(async({path,body})=>{const me=await(await fetch('/api/auth/me')).json();const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-csrf-token':me.csrfToken},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};},{path,body});}

test('pełny przepływ: plan, awaria LAN, zimny start, synchronizacja, wykonanie i dowód',async({page,context,browser})=>{
  test.setTimeout(600000);await mkdir(artifacts,{recursive:true});
  await page.setViewportSize({width:1440,height:1000});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.stack||error.message));
  const renderTimings:Record<string,number>={};
  const accessibility:unknown[]=[];
  async function axe(name:string,target=page){const result=await new AxeBuilder({page:target}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();accessibility.push({view:name,violations:result.violations});await writeFile('artifacts/accessibility.json',JSON.stringify(accessibility,null,2));}
  await page.goto('/');
  const manifestResponse=await page.request.get('/release-manifest.json');expect(manifestResponse.ok()).toBe(true);
  const releaseManifestHash=createHash('sha256').update(await manifestResponse.body()).digest('hex');
  await page.getByLabel('Nazwa organizacji',{exact:true}).fill('MOST · centrum ćwiczenia');
  await page.getByLabel('Imię i nazwisko lub nazwa dyżuru',{exact:true}).fill('Koordynator ćwiczenia');
  await page.getByLabel('Nazwa użytkownika',{exact:true}).fill('koordynator-e2e');
  await page.getByLabel(/^Hasło/).fill(password);
  await axe('bootstrap');
  await page.getByRole('button',{name:'Utwórz organizację',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Zaplanuj pracę usług podczas awarii'})).toBeVisible();
  await shot(page,'overview');await axe('overview');

  const graphStart=Date.now();await nav(page,'Zależności');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>{
    const node=(id:string)=>document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect();
    const fiber=node('fiber'),uplink=node('uplink'),digital=node('digital-connection');
    return Boolean(fiber&&uplink&&digital&&fiber.right<uplink.left&&uplink.right<digital.left);
  })).toBe(true);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));renderTimings.graphNavigationToPaintMs=Date.now()-graphStart;
  await shot(page,'graph');await axe('graph');
  await nav(page,'Plany i przydziały');
  await page.getByRole('combobox',{name:'Budżet obliczenia',exact:true}).selectOption('30000');
  const planStart=Date.now();await page.getByRole('button',{name:'Oblicz nowy plan',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'Oblicz nowy plan',exact:true})).toBeEnabled({timeout:60000});
  await expect(page.getByRole('heading',{name:'Wszystkie minima od 30. minuty'})).toBeVisible();
  await expect(page.locator('.plan-metrics')).toContainText('310');
  renderTimings.firstPlanClickToVisibleMs=Date.now()-planStart;
  await shot(page,'plan');await axe('plans');
  await page.getByLabel(/Daniel/).selectOption('unavailable');
  await page.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();
  await expect(page.getByRole('button',{name:'Oblicz nowy plan',exact:true})).toBeEnabled({timeout:60000});
  await expect(page.locator('.plan-metrics')).toContainText('220');
  await expect(page.getByRole('heading',{name:'Nie utrzymamy jednocześnie wszystkich minimów'})).toBeVisible();
  await shot(page,'shortage');
  await page.getByLabel(/Daniel/).selectOption('available');

  await nav(page,'Co sprawdzić');
  await page.getByRole('combobox',{name:'Wspólny budżet porównania',exact:true}).selectOption('30000');
  await page.getByRole('button',{name:'Porównaj odpowiedzi',exact:true}).click();
  await expect(page.getByRole('button',{name:'Porównaj odpowiedzi',exact:true})).toBeEnabled({timeout:60000});
  await expect(page.locator('.check-comparison .impact').first()).toContainText('90');
  await shot(page,'uncertainty');await axe('uncertainty');

  await nav(page,'To urządzenie');
  await page.getByRole('button',{name:'Pobierz klucz publiczny',exact:true}).click();
  await page.getByLabel('Porównałem identyfikator z kluczem organizacji dostarczonym niezależną, zaufaną drogą.').check();
  await page.evaluate(async()=>await navigator.serviceWorker.ready);
  await page.getByRole('button',{name:'Przygotuj urządzenie',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Pakiet lokalny przygotowany'})).toBeVisible({timeout:120000});
  await expect(page.getByText('Zweryfikowany wobec wybranego klucza',{exact:true})).toBeVisible();
  await shot(page,'prepared');await axe('device');
  await page.reload();await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();await expect(page.locator('.connection-bar.disconnected')).toContainText('Brak serwera');
  await nav(page,'Plany i przydziały');
  await page.getByRole('combobox',{name:'Budżet obliczenia',exact:true}).selectOption('30000');
  await page.getByLabel(/Daniel/).selectOption('unavailable');
  await page.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();
  await expect(page.getByRole('button',{name:'Oblicz nowy plan',exact:true})).toBeEnabled({timeout:60000});
  await expect(page.locator('.plan-metrics')).toContainText('220');
  await expect(page.getByRole('button',{name:'Zatwierdź i zarezerwuj',exact:true})).toBeDisabled();
  await shot(page,'offline');
  await nav(page,'Meldunki');
  await page.getByRole('button',{name:'Nowy meldunek',exact:true}).click();
  await page.getByRole('textbox',{name:'Oryginalna treść',exact:true}).fill('Syntetyczna próba offline: wiadomość żąda przeniesienia agregatu. Oryginał zachowany.');
  await page.getByLabel('Źródło informacji',{exact:true}).fill('Ćwiczenie przeglądarkowe');
  await page.getByRole('combobox',{name:'Element, którego dotyczy',exact:true}).selectOption('router');
  await page.getByLabel('Wiadomość zawiera polecenie lub prośbę o zmianę przydziału').check();
  await page.getByLabel('Dowód (opcjonalny)').setInputFiles({name:'dowod.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic evidence: offline observation')});
  await page.getByRole('button',{name:'Zapisz meldunek',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Na tym urządzeniu',{exact:true})).toBeVisible();
  await page.reload();await nav(page,'Meldunki');
  await expect(page.getByText('Syntetyczna próba offline:',{exact:false})).toBeVisible();
  await context.setOffline(false);
  await nav(page,'Synchronizacja');
  await page.getByRole('button',{name:'Sprawdź i uzgodnij',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Kolejka jest uzgodniona'})).toBeVisible();
  const synchronized=await snapshot(page);
  expect(synchronized.observations).toHaveLength(1);
  expect(synchronized.evidence.length).toBeGreaterThan(0);
  expect(synchronized.allocations).toHaveLength(0);
  await page.getByRole('button',{name:'Sprawdź i uzgodnij',exact:true}).click();
  expect((await snapshot(page)).observations).toHaveLength(1);
  await shot(page,'sync');await axe('sync');

  await nav(page,'Gotowość');
  await page.getByRole('button',{name:'Importuj dane',exact:true}).click();
  let importAttempts=0,controlledImportResponseMs=0;
  await page.route('**/api/import/preview',async route=>{
    if(++importAttempts===1){await route.abort('failed');return;}
    const started=Date.now();const response=await route.fetch();
    // Regression: preserve a failed upload and accept an actual response after the old 15 s deadline.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,17000-(Date.now()-started))));
    controlledImportResponseMs=Date.now()-started;await route.fulfill({response});
  });
  await page.getByLabel('Plik JSON / CSV lub dokument PDF / DOCX').setInputFiles('official-2026-10-03/materials/85c3a02ffa44b357.docx');
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('85c3a02ffa44b357.docx',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Ponów odczyt wybranego pliku',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Przetwarzanie pliku'})).toBeVisible();
  await expect(page.getByLabel('Plik JSON / CSV lub dokument PDF / DOCX')).toBeDisabled();
  await expect(page.getByText('Tekst dokumentu jest szkicem. Nie opublikowano procedury.')).toBeVisible({timeout:90000});
  await page.unroute('**/api/import/preview');expect(importAttempts).toBe(2);expect(controlledImportResponseMs).toBeGreaterThanOrEqual(17000);
  expect((await snapshot(page)).model.revision).toBe(synchronized.model.revision);
  await axe('document-import');
  const draftText='Syntetyczna korekta fragmentu: zachowaj dokument źródłowy i nie publikuj procedury.';
  await page.getByRole('textbox',{name:'Szkic tekstu dokumentu',exact:true}).fill(draftText);
  await expect(page.getByRole('status').filter({hasText:'Szkic zapisany lokalnie na tym koncie.'})).toBeVisible();
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();await nav(page,'Obraz sytuacji');await page.reload();await nav(page,'Gotowość');
  await page.getByRole('button',{name:'Otwórz szkic 85c3a02ffa44b357.docx',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Szkic tekstu dokumentu',exact:true})).toHaveValue(draftText);
  const draftDownloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Eksport szkicu ze źródłami',exact:true}).click();const draftDownload=await draftDownloadPromise;const draftPath=await draftDownload.path();expect(draftPath).toBeTruthy();const draftExport=JSON.parse(await readFile(draftPath!,'utf8'));
  expect(draftExport.published).toBe(false);expect(draftExport.source.filename).toBe('85c3a02ffa44b357.docx');expect(draftExport.fragments[0].text).toBe(draftText);expect(draftExport.fragments[0].originalText).not.toBe(draftText);expect(draftExport.fragments[0].source).toBeTruthy();expect((await snapshot(page)).model.revision).toBe(synchronized.model.revision);
  await writeFile('artifacts/document-draft-verification.json',JSON.stringify({at:new Date().toISOString(),passed:true,failedUploadRetainsFileAndAllowsRetry:true,controlledImportResponseMs,acceptsResponseAfterOld15SecondDeadline:true,reloadRetainsEditedFragment:true,exportRetainsOriginalAndSource:true,published:false,modelUnchanged:true},null,2));
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  const operatorPassword=randomUUID()+randomUUID();
  await page.getByRole('tab',{name:'Konta i lokalne pule',exact:true}).click();await page.getByRole('button',{name:'Nowe konto',exact:true}).click();
  await page.getByLabel('Imię i nazwisko / dyżur',{exact:true}).fill('Wykonawca punktu pomocy');await page.getByLabel('Login',{exact:true}).fill('wykonawca-e2e');await page.getByLabel('Hasło początkowe',{exact:true}).fill(operatorPassword);await page.getByRole('button',{name:'Utwórz konto',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  const preparedState=await snapshot(page);const operator=preparedState.users.find((u:any)=>u.username==='wykonawca-e2e');expect(operator).toBeTruthy();

  await nav(page,'Plany i przydziały');
  await page.getByRole('combobox',{name:'Budżet obliczenia',exact:true}).selectOption('30000');
  await page.getByRole('button',{name:'Oblicz nowy plan',exact:true}).click();
  await expect(page.getByRole('button',{name:'Oblicz nowy plan',exact:true})).toBeEnabled({timeout:60000});
  await expect(page.locator('.plan-metrics')).toContainText('310');
  const helpMode=preparedState.model.modes.find((m:any)=>m.id==='help-local');await page.getByRole('combobox',{name:`Wykonawca: ${helpMode.name}`,exact:true}).selectOption(operator.id);
  await page.getByRole('button',{name:'Zatwierdź i zarezerwuj',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).actions.length).toBe(3);
  await nav(page,'Moje zadania');
  const workerContext=await browser.newContext({baseURL:new URL(page.url()).origin,viewport:{width:390,height:844},isMobile:true,hasTouch:true});const workerPage=await workerContext.newPage();await workerPage.goto('/');await workerPage.getByLabel('Nazwa użytkownika',{exact:true}).fill('wykonawca-e2e');await workerPage.getByLabel(/^Hasło/).fill(operatorPassword);await workerPage.getByRole('button',{name:'Zaloguj się',exact:true}).click();await expect(workerPage.getByRole('heading',{name:'Mój kolejny krok'})).toBeVisible();
  const assigned=(await snapshot(page)).actions;
  for(const action of assigned){
    const taskPage=action.ownerId===operator.id?workerPage:page;
    const s=await snapshot(page);const service=s.model.services.find((v:any)=>v.id===action.serviceId);
    await taskPage.locator('.task-selector').getByRole('button',{name:new RegExp(service.name)}).click();
    await taskPage.getByRole('button',{name:'Przyjmij zadanie',exact:true}).click();
    await expect(taskPage.getByRole('button',{name:'Przyjmij zadanie',exact:true})).toHaveCount(0);
    for(const checkbox of await taskPage.locator('.condition input[type="checkbox"]').all())await checkbox.check();
    await taskPage.getByRole('button',{name:'Warunki sprawdzone, rozpocznij',exact:true}).click();
    await taskPage.getByRole('button',{name:'Zapisz wykonanie czynności',exact:true}).click();
    await expect(taskPage.getByText('Zadanie wykonane. Działanie usługi wymaga osobnego, ważnego testu.',{exact:true})).toBeVisible();
    expect((await snapshot(page)).verifications.filter((v:any)=>v.actionId===action.id)).toHaveLength(0);
    const mode=s.model.modes.find((m:any)=>m.id===action.modeId);const contract=s.model.verificationContracts.find((c:any)=>c.id===mode.verificationContractId);
    if(!contract.simulated)await taskPage.getByRole('button',{name:'Zapisz i odczytaj zgłoszenie testowe',exact:true}).click();else await taskPage.getByRole('button',{name:'Uruchom symulator testu',exact:true}).click();
    await expect(taskPage.getByText(contract.simulated?/Symulator zapisał wynik/:/Rejestr rzeczywiście zapisał i odczytał test/)).toBeVisible();
    await taskPage.getByRole('button',{name:'Zapisz wynik testu',exact:true}).click();
    await taskPage.getByLabel('Opis próby i obserwacji',{exact:true}).fill(contract.simulated?'Symulowany dowód wyniku usługi. Bez rzeczywistego sprzętu.':'Rzeczywisty zapis i odczyt syntetycznego zgłoszenia.');
    await taskPage.getByRole('button',{name:'Zapisz test osobno od wykonania',exact:true}).click();
    await expect(taskPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async()=>(await snapshot(page)).verifications.filter((v:any)=>v.actionId===action.id).length).toBe(1);
  }
  await shot(workerPage,'operator-mobile');await axe('mobile-operator',workerPage);await workerContext.close();
  await page.locator('.connection-status').click();await expect.poll(async()=>await page.locator('.connection-status .spin').count()).toBe(0);
  await shot(page,'tasks');await axe('tasks');
  await nav(page,'Gotowość');await page.getByRole('tab',{name:'Procedury i testy',exact:true}).click();await page.getByRole('button',{name:'Zapisz próbę i pomiar przygotowania',exact:true}).click();
  await page.getByRole('combobox',{name:'Próbowany tryb',exact:true}).selectOption('help-local');await page.getByLabel('Przygotowanie danych (min)',{exact:true}).fill('0');await page.getByLabel('Zmierzony czas procedury (min)',{exact:true}).fill('15');await page.getByLabel('Zmierzony poziom usługi',{exact:true}).fill('6');await page.getByLabel('Źródło i sposób pomiaru',{exact:true}).fill('Syntetyczna próba formularza E2E, bez pomiaru uczestników');await page.getByLabel('Uwagi właściciela',{exact:true}).fill('Dane tej automatycznej próby są syntetyczne; nie publikuj ich jako wyników badania.');await page.getByLabel('Właściciel sprawdził znany dobry stan, warunki próby i poprawność pomiaru.').check();await page.getByRole('button',{name:'Zatwierdź pomiar próby',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await snapshot(page)).readinessTrials).toHaveLength(1);
  await expect(page.locator('.panel').filter({has:page.getByRole('heading',{name:'Aktualność parametrów i prób',exact:true})}).getByText('Aktualna próba',{exact:true})).toBeVisible();
  await nav(page,'Raport i historia');await shot(page,'report');await axe('report');
  await nav(page,'Moje zadania');const waterName=preparedState.model.services.find((s:any)=>s.id==='water').name;await page.locator('.task-selector').getByRole('button',{name:new RegExp(waterName)}).click();await page.getByRole('button',{name:'Zapisz wynik testu',exact:true}).click();await page.getByRole('combobox',{name:'Wynik',exact:true}).selectOption('failed');await page.getByLabel(/^Zmierzona wartość/).fill('0');await page.getByLabel('Opis próby i obserwacji',{exact:true}).fill('Kolejna próba wykazała brak działania wody. Symulacja negatywnego rezultatu.');await page.getByLabel('Dowód',{exact:true}).setInputFiles({name:'test-negatywny.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic failed test, measured value 0')});await page.getByRole('button',{name:'Zapisz test osobno od wykonania',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await shot(page,'failed-test');const failedState=await snapshot(page);expect(failedState.verifications.filter((v:any)=>v.actionId===assigned.find((a:any)=>a.serviceId==='water').id&&v.current)).toHaveLength(0);

  // A separate mobile browser is a second device and session, with server-enforced read-only rights.
  await nav(page,'Meldunki');await page.getByRole('button',{name:'Oceń i potwierdź stan',exact:true}).click();
  await page.getByRole('combobox',{name:'Potwierdzony stan',exact:true}).selectOption('unavailable');await page.getByLabel('Przesłanki i sposób sprawdzenia',{exact:true}).fill('Niezależna syntetyczna próba potwierdziła awarię routera; polecenie z meldunku nie jest upoważnieniem.');await page.getByRole('button',{name:'Zapisz ocenę',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Ocena i wpływ na usługi',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Brakujące sprawdzenia',exact:true})).toBeVisible();
  const assessmentState=await snapshot(page);expect(assessmentState.assessments).toHaveLength(1);expect(assessmentState.assessments[0].computedImpact.affectedServiceIds.length).toBeGreaterThan(0);expect(assessmentState.observations).toHaveLength(1);await shot(page,'assessment');await axe('assessment');
  await writeFile('artifacts/assessment-verification.json',JSON.stringify({at:new Date().toISOString(),passed:true,explicitHumanAssessment:true,computedImpact:assessmentState.assessments[0].computedImpact,originalObservationPreserved:true},null,2));
  const observerPassword=randomUUID()+randomUUID();
  const created=await api(page,'/api/users',{username:'obserwator-e2e',password:observerPassword,displayName:'Obserwator ćwiczenia',role:'observer'});expect(created.status).toBe(200);
  const mobile=await browser.newContext({baseURL:new URL(page.url()).origin,viewport:{width:390,height:844},isMobile:true,hasTouch:true});const phone=await mobile.newPage();
  await phone.goto('/');await phone.getByLabel('Nazwa użytkownika',{exact:true}).fill('obserwator-e2e');await phone.getByLabel(/^Hasło/).fill(observerPassword);await phone.getByRole('button',{name:'Zaloguj się',exact:true}).click();await expect(phone.locator('.app-shell')).toBeVisible();
  expect(await phone.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await phone.screenshot({path:`artifacts/screenshots/mobile.png`,fullPage:true});await axe('mobile-overview',phone);
  const forbidden=await api(phone,'/api/plans/approve',{plan:(await snapshot(page)).plans[0],incidentId:synchronized.incidents[0].id});expect(forbidden.status).toBe(403);
  await nav(phone,'Meldunki');await expect(phone.getByRole('button',{name:'Nowy meldunek',exact:true})).toBeDisabled();await mobile.close();
  expect(errors).toEqual([]);
  await writeFile('artifacts/browser-verification.json',JSON.stringify({at:new Date().toISOString(),releaseManifestHash,functionalSolverBudgetMs:30000,passed:accessibility.every((a:any)=>!a.violations.some((v:any)=>v.impact==='serious'||v.impact==='critical')),observations:1,actions:3,verifiedContracts:3,subsequentFailedTestInvalidatesPrevious:true,coldOffline:true,localReplanningServiceMinutes:220,roles:['administrator','operator','observer'],accessibilityViews:accessibility.length,keyboardNavigation:true,renderTimings,pageErrors:errors},null,2));
  const video=page.video();await context.close();if(video)await video.saveAs('artifacts/MOST-demo.webm');
});

test('odporność klienta: brak miejsca, utrata odpowiedzi, konflikt dwóch urządzeń i wygaśnięcie dostępu',async({page,context,browser})=>{
  test.setTimeout(150000);await page.goto('/');await page.getByLabel('Nazwa użytkownika',{exact:true}).fill('koordynator-e2e');await page.getByLabel(/^Hasło/).fill(password);await page.getByRole('button',{name:'Zaloguj się',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible();
  await nav(page,'Meldunki');await page.getByRole('button',{name:'Nowy meldunek',exact:true}).click();await page.getByRole('textbox',{name:'Oryginalna treść',exact:true}).fill('Próba pełnej pamięci: ten tekst musi pozostać w formularzu.');await page.getByLabel('Źródło informacji',{exact:true}).fill('Test kontrolowanej awarii magazynu');
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(value:any,key?:IDBValidKey){if(this.name==='outbox'){(window as any).__quotaFaults=((window as any).__quotaFaults||0)+1;throw new DOMException('Synthetic quota exhausted','QuotaExceededError');}return original.call(this,value,key);};});
  await page.getByRole('button',{name:'Zapisz meldunek',exact:true}).click();
  await expect(page.getByRole('dialog').getByText('Nie zapisano zmiany. Pamięć urządzenia jest pełna lub niedostępna. Nie zamykaj formularza.',{exact:true})).toBeVisible();
  const retainedText=page.getByRole('textbox',{name:'Oryginalna treść',exact:true});await expect(retainedText).toHaveValue('Próba pełnej pamięci: ten tekst musi pozostać w formularzu.');expect((await snapshot(page)).observations).toHaveLength(1);await retainedText.scrollIntoViewIfNeeded();await shot(page,'storage-error');
  await page.getByRole('dialog').getByRole('button',{name:'Zamknij komunikat',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(retainedText).toHaveValue('Próba pełnej pamięci: ten tekst musi pozostać w formularzu.');expect(await page.evaluate(()=>Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  await page.reload();await nav(page,'Meldunki');
  let lost=false;await page.route('**/api/commands',async route=>{if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'Nowy meldunek',exact:true}).click();await page.getByRole('textbox',{name:'Oryginalna treść',exact:true}).fill('Unikalny meldunek: przyjęto na serwerze, lecz utracono odpowiedź.');await page.getByLabel('Źródło informacji',{exact:true}).fill('Próba ponowienia komendy');await page.getByRole('button',{name:'Zapisz meldunek',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await page.unroute('**/api/commands');await nav(page,'Synchronizacja');await page.getByRole('button',{name:'Sprawdź i uzgodnij',exact:true}).click();await expect(page.getByRole('heading',{name:'Kolejka jest uzgodniona'})).toBeVisible();expect((await snapshot(page)).observations).toHaveLength(2);

  const second=await browser.newContext({baseURL:new URL(page.url()).origin});const other=await second.newPage();await other.goto('/');await other.getByLabel('Nazwa użytkownika',{exact:true}).fill('koordynator-e2e');await other.getByLabel(/^Hasło/).fill(password);await other.getByRole('button',{name:'Zaloguj się',exact:true}).click();await expect(other.locator('.app-shell')).toBeVisible();
  await nav(page,'To urządzenie');await page.getByRole('button',{name:'Pobierz klucz publiczny',exact:true}).click();await page.getByLabel('Porównałem identyfikator z kluczem organizacji dostarczonym niezależną, zaufaną drogą.').check();await page.getByRole('button',{name:'Przygotuj urządzenie',exact:true}).click();await expect(page.getByRole('heading',{name:'Pakiet lokalny przygotowany'})).toBeVisible({timeout:120000});
  await page.reload();await nav(page,'Gotowość');await page.getByRole('tab',{name:'Zasoby',exact:true}).click();
  await context.setOffline(true);const resourceSelect=page.getByLabel(/^Dostępność /).first();await resourceSelect.selectOption('unknown');
  await expect(page.getByText('Zapisano na tym urządzeniu. Serwer jeszcze nie przyjął zmiany.',{exact:true})).toBeVisible();
  const state=await snapshot(other);const conflicting=await api(other,'/api/commands',{commands:[{schemaVersion:1,commandId:randomUUID(),deviceId:'second-browser-device',organizationId:state.organizationId,baseRevision:state.revision,serverEpoch:state.serverEpoch,dependsOn:[],type:'resource.update',payload:{resourceId:state.model.resources[0].id,state:'unavailable',reason:'Niezależna obserwacja drugiego urządzenia'}}]});expect(conflicting.body.results[0].status).toBe('accepted');
  await context.setOffline(false);await nav(page,'Synchronizacja');await page.getByRole('button',{name:'Sprawdź i uzgodnij',exact:true}).click();await expect(page.getByRole('button',{name:'Rozstrzygnij z uzasadnieniem',exact:true})).toBeVisible();await shot(page,'conflict');await page.getByRole('button',{name:'Rozstrzygnij z uzasadnieniem',exact:true}).click();await page.getByLabel('Uzasadnienie i potwierdzony stan').fill('Zachowano aktualną ocenę drugiego urządzenia; oryginał nie został nadpisany.');await page.getByRole('button',{name:'Zapisz rozstrzygnięcie',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await snapshot(other)).model.resources[0].state).toBe('unavailable');await second.close();

  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const req=indexedDB.open('most-device-v1');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const tx=db.transaction('accounts','readwrite');const store=tx.objectStore('accounts');const all=store.getAll();all.onsuccess=()=>{for(const row of all.result)store.put({...row,offlineUntil:'2020-01-01T00:00:00Z'});};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}));
  await context.setOffline(true);await page.reload();await expect(page.getByText('Upoważnienie offline wygasło lub czas urządzenia jest niepewny. Połącz się z serwerem i zaloguj ponownie.',{exact:true})).toBeVisible();await expect(page.locator('.app-shell')).toHaveCount(0);await context.setOffline(false);
  await writeFile('artifacts/client-resilience.json',JSON.stringify({at:new Date().toISOString(),passed:true,checks:['Komunikat błędu jest dostępny wewnątrz dialogu i można go zamknąć bez utraty formularza','QuotaExceeded zachowuje formularz i nie potwierdza zapisu','Utrata odpowiedzi nie dubluje faktu po ponowieniu','Dwa urządzenia ujawniają konflikt i zachowują oryginał','Rozstrzygnięcie nie nadpisuje automatycznie drugiej oceny','Wygaśnięcie dostępu blokuje chroniony odczyt offline']},null,2));
});

test('migracja magazynu zachowuje kolejkę i rozdziela identyczne pliki dwóch kont',async({page})=>{
  await page.goto('/icon.svg');
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const req=indexedDB.open('most-device-v1',10);req.onupgradeneeded=()=>{const db=req.result;for(const [name,key] of [['snapshots','scope'],['accounts','scope'],['outbox','commandId'],['proposals','id'],['files','id'],['meta','key']]){const store=db.createObjectStore(name,{keyPath:key});if(['outbox','proposals','files'].includes(name))store.createIndex('scope','scope');if(['outbox','files'].includes(name))store.createIndex('status','status');if(name==='proposals')store.createIndex('type','type');}req.transaction!.objectStore('files').put({id:'identical-content',scope:'org:account-a',blob:new Blob(['same content']),name:'dowod.txt',sha256:'identical-content',status:'pending'});req.transaction!.objectStore('outbox').put({commandId:'legacy-pending-command',scope:'org:account-a',status:'pending',createdAt:new Date().toISOString(),command:{type:'observation.create',payload:{original:'Zachowany oryginał starej kolejki.'}}});};req.onsuccess=()=>{req.result.close();resolve();};req.onerror=()=>reject(req.error);}));
  const mutations:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/'))mutations.push(request.url());});
  await page.goto('/');await expect(page.getByRole('button',{name:/^(Zaloguj się|Utwórz organizację)$/})).toBeVisible();
  const result=await page.evaluate(()=>new Promise<any>((resolve,reject)=>{const req=indexedDB.open('most-device-v1');req.onsuccess=()=>{const db=req.result;const tx=db.transaction(['scopedFiles','outbox'],'readwrite');const files=tx.objectStore('scopedFiles');files.put({id:'identical-content',scope:'org:account-b',blob:new Blob(['same content']),name:'dowod-b.txt',sha256:'identical-content',status:'pending'});const all=files.getAll(),queue=tx.objectStore('outbox').getAll();tx.oncomplete=()=>{resolve({version:db.version,files:all.result.map((f:any)=>({scope:f.scope,id:f.id})),queue:queue.result});db.close();};tx.onerror=()=>reject(tx.error);};req.onerror=()=>reject(req.error);}));
  expect(result.version).toBe(30);expect(result.files).toHaveLength(2);expect(new Set(result.files.map((f:any)=>f.scope)).size).toBe(2);expect(result.queue).toHaveLength(1);expect(result.queue[0].command.payload.original).toBe('Zachowany oryginał starej kolejki.');expect(mutations).toEqual([]);
  await writeFile('artifacts/client-migration.json',JSON.stringify({at:new Date().toISOString(),passed:true,from:1,to:3,preservedCommands:result.queue.length,isolatedIdenticalFiles:result.files.length,foreignAccountMutations:mutations.length},null,2));
});

test('odmowa trwałej pamięci, utrata cache oraz klawiatura mają jawne stany',async({page,context})=>{
  test.setTimeout(210000);
  await page.goto('/');await page.getByLabel('Nazwa użytkownika',{exact:true}).fill('koordynator-e2e');await page.getByLabel(/^Hasło/).fill(password);await page.getByRole('button',{name:'Zaloguj się',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible();
  await nav(page,'Meldunki');const opener=page.getByRole('button',{name:'Nowy meldunek',exact:true});await opener.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog')).toBeVisible();
  for(let i=0;i<15;i++){await page.keyboard.press('Tab');expect(await page.evaluate(()=>Boolean(document.activeElement?.closest('dialog')))).toBe(true);}
  for(let i=0;i<15;i++){await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>Boolean(document.activeElement?.closest('dialog')))).toBe(true);}
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(opener).toBeFocused();
  const metrics=await context.newCDPSession(page);await metrics.send('Emulation.setDeviceMetricsOverride',{width:720,height:500,deviceScaleFactor:2,mobile:false});await nav(page,'Obraz sytuacji');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await shot(page,'reflow-200');await metrics.send('Emulation.clearDeviceMetricsOverride');await metrics.detach();await page.setViewportSize({width:1440,height:1000});
  await nav(page,'To urządzenie');await page.getByRole('button',{name:'Pobierz klucz publiczny',exact:true}).click();await page.getByLabel('Porównałem identyfikator z kluczem organizacji dostarczonym niezależną, zaufaną drogą.').check();
  await page.evaluate(()=>{Object.defineProperty(navigator.storage,'persist',{value:async()=>false,configurable:true});});
  await page.getByRole('button',{name:'Przygotuj urządzenie',exact:true}).click();await expect(page.getByRole('heading',{name:'Pakiet lokalny przygotowany'})).toBeVisible({timeout:120000});await expect(page.getByText('Niepotwierdzona; możliwe usunięcie danych',{exact:true})).toBeVisible();
  const removed=await page.evaluate(async()=>{let n=0;for(const key of await caches.keys()){const cache=await caches.open(key);if(await cache.delete('/highs.wasm',{ignoreSearch:true}))n++;}return n;});expect(removed).toBeGreaterThan(0);
  await nav(page,'Obraz sytuacji');await nav(page,'To urządzenie');await expect(page.getByRole('heading',{name:'Pakiet lokalny przygotowany'})).toHaveCount(0);await expect(page.getByText(/Brak.*kopii offline|pamięć.*niekompletna|pakiet.*niekompletny/i)).toBeVisible();
  await writeFile('artifacts/cache-and-keyboard.json',JSON.stringify({at:new Date().toISOString(),passed:true,persistDeniedVisible:true,evictedWasmInvalidatesReadiness:true,modalFocusTrapped:true,tabAndShiftTabVerified:true,escapeRestoresFocus:true,reflow720At2xNoHorizontalOverflow:true},null,2));
});

test('wszystkie sprawdzone ekrany spełniają automatyczne kryteria dostępności',async()=>{
  const views=JSON.parse(await readFile('artifacts/accessibility.json','utf8'));
  expect(views.length).toBeGreaterThanOrEqual(10);
  for(const view of views)expect.soft(view.violations.filter((v:any)=>v.impact==='serious'||v.impact==='critical'),view.view).toEqual([]);
});





