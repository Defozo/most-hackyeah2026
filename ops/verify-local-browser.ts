import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { buildApp } from '../apps/api/src/app.ts';
import { access, cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';

// An isolated real browser and real HTTP server. Credentials and profile stay in temporary storage.
const origin = 'http://localhost:8095';
const dataDir = await mkdtemp(join(tmpdir(), 'most-local-browser-data-'));
const profileDir = await mkdtemp(join(tmpdir(), 'most-local-browser-profile-'));
const artifacts = resolve('artifacts/local-browser');
await mkdir(artifacts, { recursive: true });
const staticDir = process.env.LOCAL_BROWSER_RELEASE_DIR ? resolve(process.env.LOCAL_BROWSER_RELEASE_DIR) : await mkdtemp(join(tmpdir(), 'most-local-browser-release-'));
if (!process.env.LOCAL_BROWSER_RELEASE_DIR) await cp(resolve('apps/web/dist'), staticDir, { recursive: true });
await Promise.all(['index.html', 'sw.js', 'release-manifest.json'].map(file => access(join(staticDir, file))));
const releaseManifestHash = createHash('sha256').update(await readFile(join(staticDir, 'release-manifest.json'))).digest('hex');
const keys = generateKeyPairSync('ed25519');
const signingKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const trustedKeyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'pem' })).digest('hex').slice(0, 16);
const options = { dataDir, staticDir, trustedOrigins: [origin], secureCookies: false, seedDemo: true, signingKey };
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let context: BrowserContext | undefined;
let page!: Page;
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
const browserErrors: string[] = [];
const timings: Record<string, number> = {};
function check(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
async function startServer() { app = await buildApp(options); await app.listen({ host: '127.0.0.1', port: 8095 }); }
async function openBrowser(offline = false) {
  context = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1440, height: 1000 }, locale: 'pl-PL', serviceWorkers: 'allow', offline });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
}
async function rows(store: string): Promise<any[]> {
  return page.evaluate(storeName => new Promise<any[]>((resolveRows, reject) => {
    const request = indexedDB.open('most-device-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction(storeName).objectStore(storeName).getAll();
      read.onsuccess = () => { resolveRows(read.result.map(row => row.blob instanceof Blob ? { ...row, blob: { size: row.blob.size, type: row.blob.type } } : row)); db.close(); };
      read.onerror = () => { reject(read.error); db.close(); };
    };
  }), store);
}
async function snapshot() { return page.evaluate(async () => { const response = await fetch('/api/snapshot'); if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`); return response.json(); }); }
async function navigate(label: string) { await page.locator('nav').getByRole('button', { name: new RegExp('^' + label + '(?:\\s|$)') }).click(); }
async function outboxPending(type: string) { await expect.poll(async () => (await rows('outbox')).some(row => row.command.type === type && row.status === 'pending'), { timeout: 30_000 }).toBe(true); }
let identity: { userId: string; organizationId: string; serverEpoch: string };
let offlineCommands: any[] = [];
try {
  console.log('Starting isolated server and browser');
  await startServer(); await openBrowser();
  await page.getByLabel('Imię i nazwisko lub nazwa dyżuru').fill('Syntetyczna próba lokalna');
  await page.getByLabel('Nazwa użytkownika', { exact: true }).fill('local-browser');
  await page.getByLabel(/^Hasło/).fill(randomUUID() + randomUUID());
  await page.getByRole('button', { name: 'Utwórz organizację' }).click();
  await expect(page.getByRole('heading', { name: 'Zaplanuj pracę usług podczas awarii' })).toBeVisible({ timeout: 60_000 });
  let state = await snapshot();
  const account = (await rows('accounts'))[0];
  identity = { userId: account.user.id, organizationId: state.organizationId, serverEpoch: state.serverEpoch };
  check('Rzeczywisty bootstrap i uwierzytelniona przeglądarka', account.user.role === 'administrator' && state.model.synthetic);
  await navigate('Gotowość');
  await page.getByRole('tab', { name: 'Konta i lokalne pule' }).click();
  await page.getByRole('button', { name: 'Przyznaj pulę' }).click();
  const dialog = page.getByRole('dialog');
  for (const checkbox of await dialog.locator('input[name="resourceIds"],input[name="modeIds"]').all()) await checkbox.check();
  await dialog.getByLabel('Warunki i ograniczenia').fill('Syntetyczna próba pełnej puli lokalnej. Wyłącznie zatwierdzone tryby i konserwatywne obniżenie dostępności.');
  await dialog.getByRole('button', { name: 'Zatwierdź lokalny zakres' }).click();
  await expect(dialog).not.toBeVisible();
  state = await snapshot();
  const scope = state.allocationScopes[0];
  check('Pełna rozłączna pula przyznana przez interfejs', scope.authorizedUserId === identity.userId && scope.resourceIds.length === state.model.resources.length && scope.modeIds.length === state.model.modes.filter((mode: any) => mode.approved).length && state.allocations.length === 0, { resources: scope.resourceIds.length, modes: scope.modeIds.length });
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((_, reject) => setTimeout(() => reject(new Error('Service Worker installation timeout')), 60_000))]));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Zaplanuj pracę usług podczas awarii' })).toBeVisible();
  await navigate('To urządzenie');
  await page.getByRole('button', { name: 'Pobierz klucz publiczny' }).click();
  await expect(page.locator('.fingerprint')).toContainText(trustedKeyId);
  await page.getByRole('checkbox', { name: /Porównałem identyfikator/ }).check();
  const preparationStarted = performance.now();
  await page.getByRole('button', { name: 'Przygotuj urządzenie', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pakiet lokalny przygotowany' })).toBeVisible({ timeout: 120_000 });
  timings.preparationMs = performance.now() - preparationStarted;
  const prepared = (await rows('meta')).find(row => row.key.startsWith('prepared:')).value;
  check('Podpis aplikacji, WASM i danych oraz próba 310 usługominut', prepared.signatureVerified && prepared.manifest.application.complete && prepared.minimumServiceMinutes === 310 && prepared.wasmHash === prepared.manifest.application.files.find((file: any) => file.path === '/highs.wasm').sha256, { minimumServiceMinutes: prepared.minimumServiceMinutes, files: prepared.manifest.application.files.length, keyId: trustedKeyId });
  await page.screenshot({ path: join(artifacts, '01-trusted-device.png'), fullPage: true });
  await context!.close(); context = undefined;
  await app!.close(); app = undefined;
  let unreachable = false; try { await fetch(origin + '/api/health/ready'); } catch { unreachable = true; }
  check('Proces serwera rzeczywiście wyłączony', unreachable);
  const coldStarted = performance.now();
  await openBrowser(true);
  await expect(page.getByRole('heading', { name: 'Zaplanuj pracę usług podczas awarii' })).toBeVisible({ timeout: 60_000 });
  timings.coldStartMs = performance.now() - coldStarted;
  const coldAccount = (await rows('accounts'))[0];
  check('Zimny start zamkniętej przeglądarki bez serwera i zachowanie konta', coldAccount.user.id === identity.userId && await page.locator('.local-ready').innerText().then(text => text.includes('Praca na urządzeniu')));
  await navigate('Plany i przydziały');
  await page.getByLabel(/^Daniel, pompa/).selectOption('unavailable');
  const solveStarted = performance.now();
  await page.getByRole('button', { name: 'Oblicz nowy plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nie utrzymamy jednocześnie wszystkich minimów' })).toBeVisible({ timeout: 60_000 });
  timings.offlineSolveMs = performance.now() - solveStarted;
  const proposal = (await rows('proposals')).find(row => row.payload.model?.resources?.some((resource: any) => resource.id === 'person-4' && resource.state === 'unavailable'));
  check('Przeliczenie WASM offline z trzema osobami: 220 usługominut', proposal?.payload.plan.validation.valid && proposal.payload.plan.metrics.minimumServiceMinutes === 220 && proposal.payload.plan.metrics.simultaneousMinimumFromMinute == null, proposal?.payload.plan.metrics);
  await page.getByRole('button', { name: 'Decyzja w lokalnej puli' }).click();
  await outboxPending('local.plan');
  await navigate('Moje zadania');
  await page.locator('.task-selector button').filter({ hasText: 'Radio niezależne' }).click();
  await expect(page.locator('.plan-result-title h2')).toHaveText('Radio niezależne');
  await page.getByRole('button', { name: 'Przyjmij zadanie', exact: true }).click(); await outboxPending('action.accept');
  for (const checkbox of await page.locator('.condition input[type="checkbox"]').all()) await checkbox.check();
  await page.getByRole('button', { name: 'Warunki sprawdzone, rozpocznij' }).click(); await outboxPending('action.start');
  await page.getByRole('button', { name: 'Zapisz wykonanie czynności' }).click(); await outboxPending('action.complete');
  check('Wykonanie offline nie tworzy automatycznie testu działania', !(await rows('outbox')).some(row => row.command.type === 'verification.create'));
  await page.getByRole('button', { name: 'Uruchom symulator testu' }).click();
  await expect(page.getByText('Symulator zakończył próbę. Dowód dołączysz do osobnego testu.')).toBeVisible();
  await page.getByRole('button', { name: 'Zapisz wynik testu' }).click();
  await page.getByRole('dialog').getByLabel('Opis próby i obserwacji').fill('Rzeczywisty przebieg interfejsu offline; wynik radia jest jawnie symulowany i nie stanowi pomiaru sprzętu.');
  await page.getByRole('button', { name: 'Zapisz test osobno od wykonania' }).click(); await outboxPending('verification.create');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('.task-selector button').filter({ hasText: 'Rejestr lokalny' }).click();
  await page.getByRole('button', { name: 'Przyjmij zadanie', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Przyjmij zadanie', exact: true })).not.toBeVisible();
  for (const checkbox of await page.locator('.condition input[type="checkbox"]').all()) await checkbox.check();
  await page.getByRole('button', { name: 'Warunki sprawdzone, rozpocznij' }).click();
  await page.getByRole('button', { name: 'Zapisz wykonanie czynności' }).click();
  await page.getByRole('button', { name: 'Zapisz i odczytaj zgłoszenie testowe' }).click(); await outboxPending('register.record');
  await expect(page.getByText('Rejestr rzeczywiście zapisał i odczytał test. Dowód jest gotowy do dołączenia.')).toBeVisible();
  await page.getByRole('button', { name: 'Zapisz wynik testu' }).click();
  await page.getByRole('dialog').getByLabel('Opis próby i obserwacji').fill('Syntetyczne zgłoszenie rzeczywiście zapisane i odczytane z IndexedDB, podczas wyłączenia serwera.');
  await page.getByRole('button', { name: 'Zapisz test osobno od wykonania' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(async () => (await rows('outbox')).filter(row => row.command.type === 'verification.create' && row.status === 'pending').length).toBe(2);
  offlineCommands = (await rows('outbox')).filter(row => row.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const expectedTypes = ['local.plan', 'action.accept', 'action.start', 'action.complete', 'verification.create', 'action.accept', 'action.start', 'action.complete', 'register.record', 'verification.create'];
  check('Pełna kolejka przyczynowa plan, przyjęcie, start, wykonanie i test', JSON.stringify(offlineCommands.map(row => row.command.type)) === JSON.stringify(expectedTypes) && offlineCommands.every((row, index) => index === 0 || row.command.dependsOn.includes(offlineCommands[index - 1].commandId)), offlineCommands.map(row => ({ type: row.command.type, commandId: row.commandId, dependsOn: row.command.dependsOn })));
  check('Dowód symulatora trwale zapisany w IndexedDB przed wysłaniem', (await rows('scopedFiles')).some(row => row.status === 'pending' && row.blob.size > 0));
  const registryReadBack = (await rows('meta')).find(row => row.key.startsWith('registry:'))?.value;
  check('Rzeczywisty zapis i odczyt zgłoszenia w IndexedDB bez serwera', Boolean(registryReadBack?.id && registryReadBack?.text));
  await page.screenshot({ path: join(artifacts, '02-offline-execution.png'), fullPage: true });
  await navigate('To urządzenie');
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Eksport danych, plików i kolejki' }).click();
  const exportedFile = await exportDownload;
  await exportedFile.saveAs(join(artifacts, 'device-export.json'));
  const exported = JSON.parse(await readFile(join(artifacts, 'device-export.json'), 'utf8'));
  const registryProof = exported.attachments.map((attachment: any) => JSON.parse(Buffer.from(attachment.base64, 'base64').toString('utf8'))).find((proof: any) => proof.readBackVerified === true);
  check('Eksport zachowuje oba kompletne bloby z poprawnymi hashami i dowodem odczytu', exported.attachments.length === 2 && exported.attachments.every((attachment: any) => createHash('sha256').update(Buffer.from(attachment.base64, 'base64')).digest('hex') === attachment.sha256) && JSON.stringify(registryProof?.record) === JSON.stringify(registryReadBack) && JSON.stringify(registryProof?.readBack) === JSON.stringify(registryReadBack), { attachments: exported.attachments.length, registerRecordId: registryReadBack.id });
  await context!.close(); context = undefined;
  const secondColdStarted = performance.now();
  await openBrowser(true);
  await expect(page.getByRole('heading', { name: 'Zaplanuj pracę usług podczas awarii' })).toBeVisible({ timeout: 30_000 });
  timings.secondColdStartMs = performance.now() - secondColdStarted;
  check('Kolejka i oba pliki przeżyły drugi zimny start', (await rows('outbox')).filter(row => row.status === 'pending').length === 10 && (await rows('scopedFiles')).length === 2);
  await navigate('Moje zadania');
  await page.locator('.task-selector button').filter({ hasText: 'Radio niezależne' }).click();
  await expect(page.getByText('Zadanie wykonane. Działanie usługi wymaga osobnego, ważnego testu.')).toBeVisible();
  check('Wykonane zadanie odtworzone z kolejki po zimnym starcie', true);
  await startServer();
  let droppedResponse = false;
  await context!.route('**/api/commands', async route => {
    const body = route.request().postDataJSON();
    if (!droppedResponse && body.commands?.some((command: any) => command.type === 'verification.create')) {
      const response = await route.fetch();
      const result = await response.json();
      check('Serwer przyjął test przed kontrolowaną utratą odpowiedzi', result.results?.[0]?.status === 'accepted', result.results?.[0]);
      droppedResponse = true;
      await route.abort('failed');
    } else await route.continue();
  });
  await context!.setOffline(false);
  await navigate('Synchronizacja');
  await page.getByRole('button', { name: 'Sprawdź i uzgodnij' }).click();
  await expect.poll(() => droppedResponse, { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await rows('outbox')).find(row => row.command.type === 'verification.create')?.status, { timeout: 30_000 }).toBe('pending');
  await page.getByRole('button', { name: 'Sprawdź i uzgodnij' }).click();
  await expect(page.getByRole('heading', { name: 'Kolejka jest uzgodniona' })).toBeVisible({ timeout: 60_000 });
  const reconciled = await rows('outbox');
  const retried = reconciled.find(row => row.commandId === offlineCommands.find(original => original.command.type === 'verification.create').commandId);
  state = await snapshot();
  check('Idempotentne ponowienie po utracie rzeczywistej odpowiedzi HTTP', droppedResponse && retried.result.replayed === true && state.verifications.length === 2, { replayed: retried.result.replayed, verifications: state.verifications.length });
  const executed = state.actions.find((action: any) => action.id === retried.command.payload.actionId);
  const verification = state.verifications.find((item: any) => item.actionId === executed.id);
  const evidenceComplete = verification.evidenceIds.length > 0 && verification.evidenceIds.every((id: string) => state.evidence.some((file: any) => file.id === id && file.complete));
  check('Lokalna decyzja uzgodniona bez nowych globalnych rezerwacji', state.allocations.length === 0 && state.localAllocations.length > 0 && state.plans.length === 1 && state.plans[0].localScopeId === scope.id && executed.status === 'completed' && verification.current && evidenceComplete, { globalAllocations: state.allocations.length, localAllocations: state.localAllocations.length, actionStatus: executed.status, verificationCurrent: verification.current, evidenceComplete });
  const returned = (await rows('accounts'))[0];
  check('To samo konto, organizacja i epoka po powrocie serwera', returned.user.id === identity.userId && state.organizationId === identity.organizationId && state.serverEpoch === identity.serverEpoch);
  const reconciledRecord = app!.store.db.prepare('SELECT id,value,action_id FROM register_records WHERE organization_id=? AND id=?').get(identity.organizationId, registryReadBack.id) as any;
  const recordCommand = reconciled.find(row => row.command.type === 'register.record');
  check('Ten sam rekord z urządzenia zapisany i odczytany w SQLite po powrocie serwera', reconciledRecord?.value === registryReadBack.text && recordCommand.result.data.serverWriteReadVerified === true && state.verifications.some((item: any) => item.actionId === reconciledRecord.action_id && item.current), { recordId: reconciledRecord?.id, serverWriteReadVerified: recordCommand.result.data.serverWriteReadVerified });
  check('Wszystkie oryginalne komendy uzgodnione dokładnie raz', offlineCommands.every(original => reconciled.find(row => row.commandId === original.commandId)?.status === 'accepted' && (app!.store.db.prepare('SELECT COUNT(*) AS count FROM commands WHERE organization_id=? AND command_id=?').get(identity.organizationId, original.commandId) as any).count === 1));
  check('Brak błędów JavaScript aplikacji', browserErrors.length === 0, browserErrors);
  await page.screenshot({ path: join(artifacts, '03-reconciled.png'), fullPage: true });
} catch (error) {
  checks.push({ name: 'Przerwanie przebiegu', passed: false, detail: error instanceof Error ? error.stack : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  if (context) { await page!.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(artifacts, 'failure-body.txt'), await page!.locator('body').innerText().catch(() => 'Page unavailable')); }
  process.exitCode = 1;
} finally {
  await context?.close(); await app?.close();
  const result = { at: new Date().toISOString(), passed: checks.every(item => item.passed), releaseManifestHash, environment: 'Chromium desktop, actual HTTP localhost:8095, persistent profile, immutable release copy, server stopped, synthetic exercise, accelerated timing and simulated radio', timings, browserErrors, checks };
  await writeFile('artifacts/local-browser-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, checks: checks.length, timings }));
}
