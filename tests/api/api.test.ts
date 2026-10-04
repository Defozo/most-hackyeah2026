import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { buildApp } from '../../apps/api/src/app.js';
import { solvePlan } from '../../packages/engine/src/index.js';
import { sha256, Store } from '../../apps/api/src/store.js';
import Database from 'better-sqlite3';
import { deflateRawSync } from 'node:zlib';

describe('MOST authority, evidence and synchronization', () => {
  let app: Awaited<ReturnType<typeof buildApp>>, directory: string, headers: Record<string,string>, user: any;
  const origin = 'http://localhost:8080';
  const keypair = generateKeyPairSync('ed25519');
  const password = 'test-only-strong-password-93820';
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'most-api-test-'));
    app = await buildApp({ dataDir: directory, staticDir:join(directory,'static'), trustedOrigins: [origin], signingKey: keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const response = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { origin }, payload: { username: 'test-admin', password } });
    expect(response.statusCode, response.body).toBe(200); const body = response.json(); user = body.user;
    headers = { origin, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': body.csrfToken };
  }, 120_000);
  afterEach(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const snap = async () => (await app.inject({ url: '/api/snapshot', headers })).json();
  const command = async (type: string, payload: any, overrides: any = {}) => { const state = await snap(); const cmd = { commandId: randomUUID(), deviceId: 'test-device', organizationId: state.organizationId, baseRevision: state.revision, serverEpoch: state.serverEpoch, dependsOn: [], schemaVersion: 1, type, payload, ...overrides }; const response = await app.inject({ method: 'POST', url: '/api/commands', headers, payload: { commands: [cmd] } }); return { result: response.json().results?.[0], command: cmd, response }; };
  async function approved() { const snapshot = await snap(); const plan = await solvePlan(snapshot.model); const result = await command('plan.approve', { plan, incidentId: 'demo-incident' }); expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return await snap(); }

  it('stores Argon2id only, enforces Origin and CSRF, and has no second bootstrap', async () => {
    const row: any = app.store.db.prepare('SELECT password_hash FROM users').get(); expect(row.password_hash).toMatch(/^\$argon2id\$/); expect(row.password_hash).not.toContain(password);
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: headers.cookie, origin: 'https://evil.example' } }); expect(response.statusCode).toBe(403);
    const csrf = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: headers.cookie, origin } }); expect(csrf.statusCode).toBe(403);
    const second = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { origin }, payload: { username: 'second-admin', password } }); expect(second.statusCode).toBe(409);
    const forwarded=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers:{origin,'x-forwarded-for':'198.51.100.42'},payload:{username:'proxy-admin',password}});expect(forwarded.statusCode).toBe(403);expect(forwarded.json().code).toBe('local_bootstrap_only');
  });
  it('retries observations atomically without duplicates and refuses ID mutation', async () => {
    const before = await snap(); const sent = await command('observation.create', { text: 'Przenieś agregat: niezweryfikowane polecenie.', subjectId: 'generator-1', source: 'Test', observedAt: new Date().toISOString(), kind: 'instruction' });
    const replay = await app.inject({ method: 'POST', url: '/api/commands', headers, payload: { commands: [sent.command] } }); expect(replay.json().results[0].replayed).toBe(true);
    const mismatch = await app.inject({ method: 'POST', url: '/api/commands', headers, payload: { commands: [{ ...sent.command, payload: { ...sent.command.payload, text: 'Different' } }] } }); expect(mismatch.json().results[0].code).toBe('idempotency_mismatch');
    const after = await snap(); expect(after.observations).toHaveLength(1); expect(after.model.revision).toBe(before.model.revision); expect(after.allocations).toHaveLength(0); expect(after.serverSeq).toBe(before.serverSeq + 1);
  });
  it('waits for dependencies and rejects stale mutation and organization spoofing', async () => {
    const waiting = await command('observation.create', { text: 'Test', source: 'Test', observedAt: new Date().toISOString() }, { dependsOn: ['unknown-command'] }); expect(waiting.result.status).toBe('waiting');
    const spoof = await command('incident.create', { title: 'test' }, { organizationId: 'foreign' }); expect(spoof.result.code).toBe('wrong_organization');
    const stale = await command('resource.update', { resourceId: 'person-4', state: 'unavailable' }, { baseRevision: 0 }); expect(stale.result.code).toBe('revision_conflict');
    const changed = await app.inject({ method: 'POST', url: '/api/commands', headers, payload: { commands: [{ ...stale.command, baseRevision: (await snap()).revision }] } }); expect(changed.json().results[0].code).toBe('idempotency_mismatch');
  });
  it('executes the real worker solver and independently validates approval', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/plans/solve', headers, payload: {} }); expect(result.statusCode, result.body).toBe(200); expect(result.json().metrics.minimumServiceMinutes).toBe(310);
    const forged = result.json(); forged.actions[0].allocations[0].resourceId = 'nonexistent'; const reject = await command('plan.approve', { plan: forged, incidentId: 'demo-incident' }); expect(reject.result.status).toBe('conflict');
  }, 20000);
  it('blocks overlapping equipment allocations and start after changed conditions', async () => {
    const state = await approved(); const newPlan = await solvePlan({ ...state.model, reservations: [] }); newPlan.id = randomUUID();
    const overlap = await command('plan.approve', { plan: newPlan, incidentId: 'demo-incident' }); expect(overlap.result.status).toBe('conflict');
    const water = state.actions.find((a: any) => a.serviceId === 'water'); await command('resource.update', { resourceId: 'person-4', state: 'unavailable' });
    const start = await command('action.start', { actionId: water.id, checkedConditions: true }); expect(start.result.code).toBe('review_required');
  });
  it('checks live roles and does not permit a new account to take over an old command', async () => {
    const previous = await command('observation.create', { text: 'Test', source: 'Test', observedAt: new Date().toISOString() });
    const created = await app.inject({ method: 'POST', url: '/api/users', headers, payload: { username: 'operator', password, displayName: 'Operator', role: 'operator' } }); expect(created.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'operator', password } }); headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
    const denied = await command('model.replace', { model: (await snap()).model }); expect(denied.result.code).toBe('forbidden');
    const replay = await app.inject({ method: 'POST', url: '/api/commands', headers, payload: { commands: [previous.command] } }); expect(replay.json().results[0].code).toBe('wrong_actor');
    app.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(created.json().user.id);
    expect((await app.inject({ url: '/api/snapshot', headers })).statusCode).toBe(401);
  });
  it('preserves offline action dependencies while requiring separate complete test evidence', async () => {
    let state = await approved(); const action = state.actions.find((a: any) => a.serviceId === 'help');
    const base = state.revision; const accepted = await command('action.accept', { actionId: action.id }, { baseRevision: base });
    const started = await command('action.start', { actionId: action.id, checkedConditions: true }, { baseRevision: base, dependsOn: [accepted.command.commandId] }); expect(started.result.status, JSON.stringify(started.result)).toBe('accepted');
    const completed = await command('action.complete', { actionId: action.id }, { baseRevision: base, dependsOn: [started.command.commandId] }); expect(completed.result.status, JSON.stringify(completed.result)).toBe('accepted');
    const noEvidence = await command('verification.create', { actionId: action.id, outcome: 'passed', measurement: 6, evidenceIds: [] }); expect(noEvidence.result.code).toBe('missing_evidence');
    state = await snap(); expect(state.verifications).toHaveLength(0);
    const registry = await app.inject({ method: 'POST', url: '/api/register/test', headers, payload: { actionId: action.id, value: 'Synthetic case 001' } }); expect(registry.json().readBackVerified).toBe(true);
    const unrelated=app.store.putEvidence(user.organizationId,'unrelated.txt','text/plain',Buffer.from('A complete attachment that does not prove a register read-back.'));
    expect((await command('verification.create',{actionId:action.id,outcome:'passed',measurement:6,evidenceIds:[unrelated.id]})).result.code).toBe('register_proof_mismatch');
    const wrongRecord=app.store.putEvidence(user.organizationId,'wrong-record.json','application/json',Buffer.from(JSON.stringify({record:{...registry.json().record,id:randomUUID()},readBackVerified:true})));
    expect((await command('verification.create',{actionId:action.id,outcome:'passed',measurement:6,evidenceIds:[wrongRecord.id]})).result.code).toBe('register_proof_mismatch');
    const passed = await command('verification.create', { actionId: action.id, outcome: 'passed', measurement: 6, evidenceIds: [registry.json().evidence.id] }); expect(passed.result.status, JSON.stringify(passed.result)).toBe('accepted');
    expect((await snap()).verifications[0].current).toBe(true);
    const oldTime=new Date(Date.now()-24*3600000).toISOString();
    const staleProof=app.store.putEvidence(user.organizationId,'old-valid-readback.json','application/json',Buffer.from(JSON.stringify({record:{...registry.json().record,createdAt:oldTime},testedAt:oldTime,readBackVerified:true})));
    const stale=await command('verification.create',{actionId:action.id,outcome:'passed',measurement:6,evidenceIds:[staleProof.id],observedAt:new Date().toISOString()});
    expect(stale.result.status).toBe('accepted');expect(Date.parse(stale.result.data.validUntil)).toBeLessThan(Date.now());expect((await snap()).verifications.every((verification:any)=>!verification.current)).toBe(true);
  });
  it('does not reclaim physically occupied equipment because planned time elapsed', async () => {
    const state = await approved(), water = state.actions.find((a: any) => a.serviceId === 'water');
    await command('action.start', { actionId: water.id, checkedConditions: true });
    const earlyRelease = await command('resource.release', { resourceId: 'generator-1', physicalConfirmed: true }); expect(earlyRelease.result.code).toBe('action_still_active');
    await command('action.complete', { actionId: water.id }); const fuelAfter = (await snap()).model.resources.find((r: any) => r.id === 'fuel-1').quantity;
    const repeat = await command('action.complete', { actionId: water.id }); expect(repeat.result.code).toBe('invalid_transition'); expect((await snap()).model.resources.find((r: any) => r.id === 'fuel-1').quantity).toBe(fuelAfter);
    expect((await snap()).model.resources.find((r: any) => r.id === 'generator-1').occupied).toBe(true);
    const released = await command('resource.release', { resourceId: 'generator-1', physicalConfirmed: true }); expect(released.result.status).toBe('accepted');
  });
  it('reserves delegated pools exclusively and records local proposals without new allocations', async () => {
    const state = await snap(); const scope = await command('scope.create', { resourceIds: state.model.resources.map((r: any) => r.id), modeIds: state.model.modes.map((m: any) => m.id), authorizedUserId: user.id, validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString(), allowLocalReplanning: true, conditions: [] }); expect(scope.result.status).toBe('accepted');
    const scopedState = await snap(), model = structuredClone(scopedState.model); model.resources.find((r: any) => r.id === 'person-4').state = 'unavailable'; const plan = await solvePlan(model);
    const local = await command('local.plan', { scopeId: scope.result.data.id, model, plan, approvedLocallyAt: new Date().toISOString() }); expect(local.result.status, JSON.stringify(local.result)).toBe('accepted'); expect(local.result.data.sharedReservationCreated).toBe(false);
    const global = await command('plan.approve', { plan: await solvePlan(scopedState.model), incidentId: 'demo-incident' }); expect(global.result.code).toBe('resource_delegated'); expect((await snap()).allocations).toHaveLength(0);
  });
  it('signs exact bytes, preserves evidence hashes and refuses incomplete backups', async () => {
    const uploaded = await app.inject({ method: 'POST', url: '/api/evidence', headers, payload: { filename: 'proof.txt', mimeType: 'text/plain', base64: Buffer.from('synthetic evidence').toString('base64') } }); expect(uploaded.statusCode).toBe(200);
    const bundle = (await app.inject({ url: '/api/bundle', headers })).json(); expect(verify(null, Buffer.from(bundle.manifestBytes, 'base64'), keypair.publicKey, Buffer.from(bundle.signature, 'base64'))).toBe(true);
    for (const file of bundle.files) expect(sha256(Buffer.from(file.content,'base64'))).toBe(bundle.manifest.files.find((f: any) => f.path === file.path).sha256);
    const backup = await app.store.backup(join(directory, 'backup')); expect(backup.complete).toBe(true); expect(backup.files).toHaveLength(2);
    unlinkSync(join(app.store.evidenceDir, uploaded.json().id)); await expect(app.store.backup(join(directory, 'incomplete'))).rejects.toThrow('missing evidence');
  });
  it('creates a new epoch on restore, invalidates sessions and quarantines resources', async () => {
    const old = await snap(); app.store.restoreEpoch(); expect(app.store.epoch).not.toBe(old.serverEpoch);
    expect((await app.inject({ url: '/api/snapshot', headers })).statusCode).toBe(401);
    const state = app.store.read(user.organizationId); expect(state.recovery.accountsReviewed).toBe(false); expect(state.model.resources.every((r: any) => r.reconciliationRequired)).toBe(true);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'test-admin', password } }); headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
    const rejected = await command('observation.create', { text: 'Old', source: 'test', observedAt: new Date().toISOString() }, { serverEpoch: old.serverEpoch }); expect(rejected.result.code).toBe('epoch_changed');
    const changes = await app.inject({ url: `/api/changes?serverEpoch=${old.serverEpoch}&after=0`, headers }); expect(changes.statusCode).toBe(409);
  });
  it('previews malformed and changed imports safely and preserves full manual paths', async () => {
    const model = (await snap()).model;
    const preview = await app.inject({ method: 'POST', url: '/api/import/preview', headers, payload: { format: 'json', model } }); expect(preview.statusCode, preview.body).toBe(200);
    await command('observation.create', { text: 'Changed snapshot', source: 'test', observedAt: new Date().toISOString() });
    const commit = await app.inject({ method: 'POST', url: '/api/import/commit', headers, payload: { previewId: preview.json().id } }); expect(commit.statusCode).toBe(409);
    const path = await app.inject({ method: 'POST', url: '/api/evidence', headers, payload: { filename: '../escape', mimeType: 'text/plain', base64: 'YWJj' } }); expect(path.statusCode).toBe(400);
    const disabled = await app.inject({ method: 'POST', url: '/api/ai/extract', headers, payload: { text: 'Test' } }); expect(disabled.json().manualFallback).toBe(true); expect(disabled.json().proposal).toBe(null);
  });
  it('reconciles the offline registry from its readback evidence before the separate result', async () => {
    const state = await approved(), action = state.actions.find((a: any) => a.serviceId === 'help');
    await command('action.start', { actionId: action.id, checkedConditions: true }); await command('action.complete', { actionId: action.id });
    const record = { id: randomUUID(), synthetic: true, text: 'Offline synthetic case', createdAt: new Date().toISOString() };
    const proof = app.store.putEvidence(user.organizationId, 'offline-readback.json', 'application/json', Buffer.from(JSON.stringify({ record, readBack: record, readBackVerified: true })));
    const saved = await command('register.record', { actionId: action.id, evidenceId: proof.id }); expect(saved.result.status).toBe('accepted'); expect(saved.result.data.source).toBe('device-readback-evidence');
    const result = await command('verification.create', { actionId: action.id, outcome: 'passed', measurement: 6, evidenceIds: [proof.id] }); expect(result.result.status).toBe('accepted');
  });
  it('exposes untransferred attachments and refuses to call their backup complete', async () => {
    const missing = sha256('not uploaded'); await command('observation.create', { text: 'Pending attachment', source: 'test', observedAt: new Date().toISOString(), evidenceIds: [missing] });
    const snapshot = await snap(); expect(snapshot.evidence.find((e: any) => e.id === missing).status).toBe('pending');
    await expect(app.store.backup(join(directory, 'missing-metadata'))).rejects.toThrow('missing evidence metadata');
  });
  it('rejects unsupported database schemas without rewriting their version or adding missing tables', () => {
    const schemaDir = join(directory,'schema-test'); const initial = new Store(schemaDir); initial.setMeta('schemaVersion','99'); initial.close();
    expect(()=>new Store(schemaDir)).toThrow('Unsupported database schema 99');
    const unchanged = new Database(join(schemaDir,'most.sqlite')); expect((unchanged.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get() as any).value).toBe('99'); unchanged.prepare("UPDATE metadata SET value='1' WHERE key='schemaVersion'").run(); unchanged.exec('DROP TABLE devices'); unchanged.close();
    expect(()=>new Store(schemaDir)).toThrow('Database schema 1 is incomplete: devices');
    const corrupt = new Database(join(schemaDir,'most.sqlite')); expect(corrupt.prepare("SELECT name FROM sqlite_master WHERE name='devices'").get()).toBeUndefined(); corrupt.close();
  });
  it('keeps unrelated verification current and allows unrelated action start after a changed resource', async () => {
    const state = await approved(), help = state.actions.find((a:any)=>a.serviceId==='help'), radio=state.actions.find((a:any)=>a.serviceId==='coordination'), water=state.actions.find((a:any)=>a.serviceId==='water');
    await command('action.start',{actionId:help.id,checkedConditions:true}); await command('action.complete',{actionId:help.id});
    const registry = (await app.inject({method:'POST',url:'/api/register/test',headers,payload:{actionId:help.id,value:'Synthetic unrelated-condition test'}})).json();
    expect((await command('verification.create',{actionId:help.id,outcome:'passed',measurement:6,evidenceIds:[registry.evidence.id]})).result.status).toBe('accepted');
    const waterStaff = water.allocations.find((a:any)=>state.model.resources.some((r:any)=>r.id===a.resourceId&&r.type==='person')).resourceId;
    expect((await command('resource.update',{resourceId:waterStaff,state:'unavailable'})).result.status).toBe('accepted');
    expect((await snap()).verifications[0].current).toBe(true);
    const start = await command('action.start',{actionId:radio.id,checkedConditions:true}); expect(start.result.status,JSON.stringify(start.result)).toBe('accepted');
    expect((await command('action.start',{actionId:water.id,checkedConditions:true})).result.code).toBe('review_required');
  });
  it('invalidates old pass when a later test fails and invalidates all restored action conditions', async () => {
    const state = await approved(), help=state.actions.find((a:any)=>a.serviceId==='help'); await command('action.start',{actionId:help.id,checkedConditions:true}); await command('action.complete',{actionId:help.id});
    const registry=(await app.inject({method:'POST',url:'/api/register/test',headers,payload:{actionId:help.id,value:'Synthetic failing-retest sample'}})).json();
    await command('verification.create',{actionId:help.id,outcome:'passed',measurement:6,evidenceIds:[registry.evidence.id]});
    await command('verification.create',{actionId:help.id,outcome:'failed',measurement:0,evidenceIds:[]}); expect((await snap()).verifications.every((v:any)=>!v.current)).toBe(true);
    app.store.restoreEpoch(); const restored=app.store.read(user.organizationId); expect(restored.actions.every((a:any)=>a.needsReview)).toBe(true); expect(restored.plans.every((p:any)=>p.approvalStatus==='needs_review')).toBe(true); expect(restored.verifications.every((v:any)=>v.invalidatedAt)).toBe(true);
  });
  it('rejects malformed nested inputs with no state mutation and rejects invalid solver limits', async () => {
    const before=await snap(); const model=structuredClone(before.model); delete model.verificationContracts[0].verifierRoles;
    expect((await command('model.replace',{model})).result.code).toBe('invalid_payload');
    expect((await command('resource.update',{resourceId:'person-4',confidence:'trusted-by-ai'})).result.code).toBe('invalid_payload');
    expect((await command('observation.create',{text:'Bad evidence',source:'test',observedAt:new Date().toISOString(),evidenceIds:'not-an-array'})).result.code).toBe('invalid_payload');
    expect((await command('scope.create',{resourceIds:['generator-1'],modeIds:[],authorizedUserId:user.id,validFrom:new Date().toISOString(),validUntil:'invalid',allowLocalReplanning:true,conditions:[]})).result.code).toBe('invalid_payload');
    expect((await app.inject({method:'POST',url:'/api/plans/solve',headers,payload:{budgetMs:-1}})).statusCode).toBe(400);
    expect((await snap()).revision).toBe(before.revision);
  });
  it('does not return expired local pools to global allocation without physical confirmation', async () => {
    const state=await snap(); const scope=await command('scope.create',{resourceIds:state.model.resources.map((r:any)=>r.id),modeIds:state.model.modes.map((m:any)=>m.id),authorizedUserId:user.id,validFrom:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),allowLocalReplanning:true,conditions:[]}); expect(scope.result.status).toBe('accepted');
    const expired=app.store.read(user.organizationId); expired.allocationScopes[0].validUntil=new Date(Date.now()-1000).toISOString(); expired.model.allocationScopes=expired.allocationScopes; app.store.save(expired);
    const plan=await solvePlan(expired.model); expect((await command('plan.approve',{plan,incidentId:'demo-incident'})).result.code).toBe('resource_delegated');
    expect((await command('scope.release',{scopeId:scope.result.data.id,physicalConfirmed:false})).result.code).toBe('physical_confirmation_required');
    expect((await command('scope.release',{scopeId:scope.result.data.id,physicalConfirmed:true})).result.status).toBe('accepted');
    expect((await command('plan.approve',{plan,incidentId:'demo-incident'})).result.status).toBe('accepted');
  });
  it('limits owner changes to the complete graph of owned services', async () => {
    const owner=(await app.inject({method:'POST',url:'/api/users',headers,payload:{username:'service-owner',password,displayName:'Owner',role:'owner'}})).json().user;
    const model=(await snap()).model; model.services.find((s:any)=>s.id==='help').ownerId=owner.id; expect((await command('model.replace',{model})).result.status).toBe('accepted');
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:'service-owner',password}}); headers={origin,cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
    const current=(await snap()).model, foreignMode=current.modes.find((m:any)=>m.serviceId==='water');
    for(const kind of ['mode','procedure','contract']) { const changed=structuredClone(current); if(kind==='mode') changed.modes.find((m:any)=>m.id===foreignMode.id).name='Foreign changed'; if(kind==='procedure') changed.procedures.find((p:any)=>p.id===foreignMode.procedureId).title='Foreign changed'; if(kind==='contract') changed.verificationContracts.find((c:any)=>c.id===foreignMode.verificationContractId).title='Foreign changed'; expect((await command('model.replace',{model:changed})).result.code).toBe('owner_scope'); }
    const own=structuredClone(current); own.services.find((s:any)=>s.id==='help').name='Owned service updated'; expect((await command('model.replace',{model:own})).result.status).toBe('accepted');
  });
  it('records an approved measured readiness trial without publishing changed model parameters', async () => {
    const state=await approved(), help=state.actions.find((a:any)=>a.serviceId==='help'); await command('action.start',{actionId:help.id,checkedConditions:true}); await command('action.complete',{actionId:help.id});
    const registry=(await app.inject({method:'POST',url:'/api/register/test',headers,payload:{actionId:help.id,value:'Readiness known-good synthetic sample'}})).json();
    const verified=await command('verification.create',{actionId:help.id,outcome:'passed',measurement:6,evidenceIds:[registry.evidence.id]});
    const payload={serviceId:'help',modeId:help.modeId,verificationId:verified.result.data.id,knownGoodConfirmed:true,preparationMinutes:8.5,observedSetupMinutes:18,measuredLevel:6,notes:'Zmierzono przygotowanie danych i rzeczywisty zapis oraz odczyt rejestru.',source:'Ćwiczenie właściciela'};
    const before=(await snap()).model; const trial=await command('readiness.trial',payload); expect(trial.result.status,JSON.stringify(trial.result)).toBe('accepted'); expect(trial.result.data.requiresModelReview).toBe(true); expect(trial.result.data.parametersPublished).toBe(false);
    const after=await snap(); expect(after.model).toEqual(before); expect(after.readinessTrials[0].current).toBe(true); expect(after.readinessTrials[0].procedureVersion).toBe(help.procedureVersion);
    expect((await command('readiness.trial',{...payload,measuredLevel:10})).result.code).toBe('measurement_mismatch');
    expect((await command('readiness.trial',{...payload,preparationMinutes:-1})).result.code).toBe('invalid_payload');
    const report=(await app.inject({url:'/api/incidents/demo-incident/report',headers})).json(); expect(report.readinessTrials).toHaveLength(1);
    const csv=await app.inject({url:'/api/incidents/demo-incident/report?format=csv',headers}); expect(csv.body).toContain('readiness_trial'); expect(csv.body).toContain('verification');
    await command('verification.create',{actionId:help.id,outcome:'failed',measurement:0,evidenceIds:[]}); expect((await snap()).readinessTrials[0].current).toBe(false);
    expect((await command('readiness.trial',payload)).result.code).toBe('current_verification_required');
  });
  it('attaches later evidence without overwriting the original or hiding pending transfer', async () => {
    const original='Oryginalny meldunek zachowany bez zmian.'; const observed=await command('observation.create',{text:original,source:'Dyżurny',observedAt:new Date().toISOString()});
    const hash=sha256('later proof'); const attached=await command('observation.attach',{observationId:observed.result.data.id,evidenceIds:[hash]}); expect(attached.result.status).toBe('accepted');
    const pending=await snap(); expect(pending.observations[0].original).toBe(original); expect(pending.evidence.find((e:any)=>e.id===hash).status).toBe('pending');
    await command('observation.attach',{observationId:observed.result.data.id,evidenceIds:[hash]}); expect((await snap()).observations[0].evidenceIds).toEqual([hash]);
    await app.inject({method:'POST',url:'/api/evidence',headers,payload:{filename:'later-proof.txt',mimeType:'text/plain',base64:Buffer.from('later proof').toString('base64')}});
    expect((await snap()).evidence.find((e:any)=>e.id===hash).complete).toBe(true);
  });
  it('executes a locally authorized plan through the dependent offline queue without global allocation', async () => {
    let state=await snap(); const scoped=await command('scope.create',{resourceIds:state.model.resources.map((r:any)=>r.id),modeIds:state.model.modes.map((m:any)=>m.id),authorizedUserId:user.id,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString(),allowLocalReplanning:true,conditions:[]});
    state=await snap(); const model=structuredClone(state.model); model.resources.find((r:any)=>r.id==='person-4').state='unavailable'; const plan=await solvePlan(model), base=state.revision;
    const local=await command('local.plan',{scopeId:scoped.result.data.id,model,plan,incidentId:'demo-incident',approvedLocallyAt:new Date().toISOString()},{baseRevision:base}); expect(local.result.status,JSON.stringify(local.result)).toBe('accepted');
    const help=(await snap()).actions.find((a:any)=>a.serviceId==='help'); expect(help.scopeId).toBe(scoped.result.data.id); expect((await snap()).allocations).toHaveLength(0);
    const accepted=await command('action.accept',{actionId:help.id},{baseRevision:base,dependsOn:[local.command.commandId]}); expect(accepted.result.status).toBe('accepted');
    const started=await command('action.start',{actionId:help.id,checkedConditions:true},{baseRevision:base,dependsOn:[accepted.command.commandId]}); expect(started.result.status,JSON.stringify(started.result)).toBe('accepted');
    const replacement=await solvePlan(model); expect((await command('local.plan',{scopeId:scoped.result.data.id,model,plan:replacement})).result.code).toBe('local_resource_busy');
    const complete=await command('action.complete',{actionId:help.id},{baseRevision:base,dependsOn:[started.command.commandId]}); expect(complete.result.status,JSON.stringify(complete.result)).toBe('accepted');
    const record={id:randomUUID(),actionId:help.id,synthetic:true,text:'Offline scoped record'}; const proof=app.store.putEvidence(user.organizationId,'scoped-readback.json','application/json',Buffer.from(JSON.stringify({record,readBack:record,readBackVerified:true})));
    const registered=await command('register.record',{actionId:help.id,evidenceId:proof.id},{baseRevision:base,dependsOn:[complete.command.commandId]}); expect(registered.result.status).toBe('accepted');
    const verified=await command('verification.create',{actionId:help.id,outcome:'passed',measurement:6,evidenceIds:[proof.id]},{baseRevision:base,dependsOn:[registered.command.commandId]}); expect(verified.result.status,JSON.stringify(verified.result)).toBe('accepted');
    const done=await snap(); expect(done.allocations).toHaveLength(0); expect(done.localAllocations.some((a:any)=>a.actionId===help.id&&a.status==='in_use')).toBe(true); expect(done.verifications[0].current).toBe(true);
    app.store.restoreEpoch(); const restored=app.store.read(user.organizationId); expect(restored.localAllocations.some((a:any)=>a.status==='in_use')).toBe(true); expect(restored.allocationScopes[0].reconciliationRequired).toBe(true);
  });
  it('enforces actual wall-clock preparation for non-synthetic operation and labels accelerated exercises', async () => {
    const fixture=app.store.read(user.organizationId); fixture.model.synthetic=false; fixture.model.referenceTime=new Date(Date.now()+60000).toISOString(); app.store.save(fixture);
    let state=await approved(); const help=state.actions.find((a:any)=>a.serviceId==='help'); expect(help.executionClock.mode).toBe('wall_clock');
    expect((await command('action.start',{actionId:help.id,checkedConditions:true})).result.code).toBe('before_scheduled_start');
    const current=app.store.read(user.organizationId); current.model.referenceTime=new Date(Date.now()-1000).toISOString(); current.plans[0].referenceTime=current.model.referenceTime; app.store.save(current);
    expect((await command('action.start',{actionId:help.id,checkedConditions:true})).result.status).toBe('accepted');
    expect((await command('action.complete',{actionId:help.id})).result.code).toBe('preparation_not_elapsed');
    const elapsed=app.store.read(user.organizationId); elapsed.actions.find((a:any)=>a.id===help.id).startedAt=new Date(Date.now()-16*60000).toISOString(); app.store.save(elapsed);
    expect((await command('action.complete',{actionId:help.id})).result.status).toBe('accepted');
    const expired=app.store.read(user.organizationId); expired.model.referenceTime=new Date(Date.now()-121*60000).toISOString(); expired.model.reservations=[]; app.store.save(expired);
    const plan=await solvePlan(expired.model); expect((await command('plan.approve',{plan,incidentId:'demo-incident'})).result.code).toBe('plan_expired');
    expect((await snap()).executionClock.mode).toBe('wall_clock');
  });
  it('reconciles actual offline execution times without restarting preparation at upload', async () => {
    const time=Date.now(), at=(minutes:number)=>new Date(time+minutes*60000).toISOString();
    const fixture=app.store.read(user.organizationId);fixture.model.synthetic=false;fixture.model.referenceTime=at(-30);app.store.save(fixture);
    const approvedState=await approved(),help=approvedState.actions.find((action:any)=>action.serviceId==='help'),radio=approvedState.actions.find((action:any)=>action.serviceId==='coordination');
    const historical=app.store.read(user.organizationId);historical.plans[0].approvedAt=at(-29);app.store.save(historical);
    expect((await command('action.accept',{actionId:help.id,performedAt:at(2)})).result.code).toBe('future_action');
    expect((await command('action.accept',{actionId:help.id,performedAt:at(-31)})).result.code).toBe('before_authorization');
    expect((await command('action.accept',{actionId:help.id,performedAt:at(-21)})).result.status).toBe('accepted');
    expect((await command('action.start',{actionId:help.id,checkedConditions:true,performedAt:at(-20)})).result.status).toBe('accepted');
    expect((await command('action.complete',{actionId:help.id,performedAt:at(-22)})).result.code).toBe('nonmonotonic_action');
    expect((await command('action.complete',{actionId:help.id,performedAt:at(-10)})).result.code).toBe('preparation_not_elapsed');
    const completed=await command('action.complete',{actionId:help.id,performedAt:at(-5)});expect(completed.result.status,JSON.stringify(completed.result)).toBe('accepted');
    expect(completed.result.data.startedAt).toBe(at(-20));expect(completed.result.data.completedAt).toBe(at(-5));expect(completed.result.data.completedClock.source).toBe('device_reported_server_anchored_time');expect(Date.parse(completed.result.data.completedClock.receivedAt)).toBeGreaterThan(time);
    const chain=app.store.read(user.organizationId);chain.actions.find((action:any)=>action.id===radio.id).predecessorIds=[help.sourceActionId];app.store.save(chain);
    expect((await command('action.start',{actionId:radio.id,checkedConditions:true,performedAt:at(-3)})).result.code).toBe('predecessor_window');
    expect((await command('action.start',{actionId:radio.id,checkedConditions:true,performedAt:at(0)})).result.status).toBe('accepted');
  });
  it('uses the earlier authorized local decision when delayed scope execution reaches the server', async () => {
    const time=Date.now(),at=(minutes:number)=>new Date(time+minutes*60000).toISOString();
    const fixture=app.store.read(user.organizationId);fixture.model.synthetic=false;fixture.model.referenceTime=at(-30);app.store.save(fixture);
    let state=await snap();const scoped=await command('scope.create',{resourceIds:state.model.resources.map((r:any)=>r.id),modeIds:state.model.modes.map((m:any)=>m.id),authorizedUserId:user.id,validFrom:at(-30),validUntil:at(60),allowLocalReplanning:true,conditions:[]});
    state=await snap();const plan=await solvePlan(state.model);
    expect((await command('local.plan',{scopeId:scoped.result.data.id,plan,model:state.model,incidentId:'demo-incident',approvedLocallyAt:at(-28)})).result.code).toBe('before_scope_grant');
    const historical=app.store.read(user.organizationId);historical.allocationScopes[0].approvedAt=at(-29);app.store.save(historical);
    state=await snap();const local=await command('local.plan',{scopeId:scoped.result.data.id,plan,model:state.model,incidentId:'demo-incident',approvedLocallyAt:at(-28)});expect(local.result.status,JSON.stringify(local.result)).toBe('accepted');
    const help=(await snap()).actions.find((action:any)=>action.serviceId==='help');
    expect((await command('action.accept',{actionId:help.id,performedAt:at(-21)})).result.status).toBe('accepted');
    expect((await command('action.start',{actionId:help.id,checkedConditions:true,performedAt:at(-20)})).result.status).toBe('accepted');
    const completed=await command('action.complete',{actionId:help.id,performedAt:at(-5)});expect(completed.result.status,JSON.stringify(completed.result)).toBe('accepted');
    const snapshot=await snap();expect(snapshot.plans[0].approvedLocallyAt).toBe(at(-28));expect(Date.parse(snapshot.plans[0].approvedAt)).toBeGreaterThan(time);expect(snapshot.allocations).toHaveLength(0);expect(completed.result.data.completedAt).toBe(at(-5));
  });
  it('binds application and WASM integrity to the signed device manifest', async () => {
    const dist=join(directory,'static'); mkdirSync(dist); const wasm=Buffer.from([0,97,115,109,1,0,0,0]),index=Buffer.from('<!doctype html><title>Test shell</title>');
    writeFileSync(join(dist,'highs.wasm'),wasm); writeFileSync(join(dist,'index.html'),index);
    writeFileSync(join(dist,'release-manifest.json'),JSON.stringify({schemaVersion:1,version:'test-release',builtAt:new Date().toISOString(),files:[{path:'index.html',sha256:sha256(index),size:index.length},{path:'highs.wasm',sha256:sha256(wasm),size:wasm.length}]}));
    const response=await app.inject({url:'/api/bundle',headers}); expect(response.statusCode,response.body).toBe(200); const bundle=response.json(), signed=JSON.parse(Buffer.from(bundle.manifestBytes,'base64').toString());
    expect(verify(null,Buffer.from(bundle.manifestBytes,'base64'),keypair.publicKey,Buffer.from(bundle.signature,'base64'))).toBe(true); expect(signed.application.complete).toBe(true); expect(signed.application.files.find((f:any)=>f.path==='/highs.wasm').sha256).toBe(sha256(wasm));
    writeFileSync(join(dist,'highs.wasm'),'tampered'); const refused=await app.inject({url:'/api/bundle',headers}); expect(refused.statusCode).toBe(409); expect(refused.json().code).toBe('release_changed');
  });
  it('checks actual DOCX expansion before handing the archive to the document parser', async () => {
    const name=Buffer.from('word/document.xml'),compressed=deflateRawSync(Buffer.from('<document>'+ 'x'.repeat(100000)+'</document>'));
    const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(1,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(1,24);central.writeUInt16LE(name.length,28);
    const ending=Buffer.alloc(22);ending.writeUInt32LE(0x06054b50);ending.writeUInt16LE(1,8);ending.writeUInt16LE(1,10);ending.writeUInt32LE(central.length+name.length,12);ending.writeUInt32LE(local.length+name.length+compressed.length,16);
    const file=Buffer.concat([local,name,compressed,central,name,ending]);
    const response=await app.inject({method:'POST',url:'/api/import/preview',headers,payload:{format:'docx',filename:'mismatched-size.docx',base64:file.toString('base64')}});expect(response.statusCode).toBe(400);expect(response.json().code).toBe('unsafe_archive');
  });
  it('keeps production initialization and incidents separate from the synthetic exercise dataset', async () => {
    expect((await command('incident.create',{title:'Wrong real incident',kind:'incident'})).result.code).toBe('dataset_kind_mismatch');
    const changed=(await snap()).model;changed.synthetic=false;expect((await command('model.replace',{model:changed})).result.code).toBe('dataset_kind_mismatch');
    const production=await buildApp({dataDir:join(directory,'production'),staticDir:join(directory,'production-static'),trustedOrigins:[origin],seedDemo:false});
    try {
      const response=await production.inject({method:'POST',url:'/api/auth/bootstrap',headers:{origin},payload:{username:'production-admin',password}});expect(response.statusCode,response.body).toBe(200);
      const auth={origin,cookie:String(response.headers['set-cookie']).split(';')[0],'x-csrf-token':response.json().csrfToken}; const state=(await production.inject({url:'/api/snapshot',headers:auth})).json();
      expect(state.model.synthetic).toBe(false);expect(state.model.services).toHaveLength(0);expect(state.model.resources).toHaveLength(0);expect(state.incidents).toHaveLength(0);
      const make=(kind:string)=>production.inject({method:'POST',url:'/api/commands',headers:auth,payload:{commands:[{commandId:randomUUID(),deviceId:'production-test',organizationId:state.organizationId,baseRevision:state.revision,serverEpoch:state.serverEpoch,dependsOn:[],schemaVersion:1,type:'incident.create',payload:{title:'Dataset test',kind}}]}});
      expect((await make('exercise')).json().results[0].code).toBe('dataset_kind_mismatch');expect((await make('incident')).json().results[0].status).toBe('accepted');
      expect((await snap()).incidents).toHaveLength(1);
    }finally{await production.close();}
  });
  it.each(['cycle','missing-mode-dependency','missing-resource-dependency'])('imports an explicitly excluded %s fragment while refusing every plan that uses it', async kind => {
    const initial=await snap(),baseline=await solvePlan(initial.model);expect(baseline.metrics.minimumServiceMinutes).toBe(310);const model=structuredClone(initial.model);
    if(kind==='cycle'){const dependency=model.dependencies.find((node:any)=>node.id==='radio-battery');dependency.kind='or';dependency.inputs=['radio-battery','fiber'];}
    else if(kind==='missing-mode-dependency')model.modes.find((mode:any)=>mode.id==='coord-radio').dependencyId='missing-battery-state';
    else model.resources.find((resource:any)=>resource.id==='radio-1').dependencyId='missing-battery-state';
    const previewResponse=await app.inject({method:'POST',url:'/api/import/preview',headers,payload:{format:'json',model}});expect(previewResponse.statusCode,previewResponse.body).toBe(200);const preview=previewResponse.json();expect(preview.validation.valid,JSON.stringify(preview.validation)).toBe(true);expect(preview.validation.blockedFragments).toEqual(expect.arrayContaining([expect.objectContaining({kind:kind==='missing-resource-dependency'?'resource':'mode',id:kind==='missing-resource-dependency'?'radio-1':'coord-radio'})]));
    const committed=await app.inject({method:'POST',url:'/api/import/commit',headers,payload:{previewId:preview.id,baseRevision:initial.revision}});expect(committed.statusCode,committed.body).toBe(200);expect(committed.json().status).toBe('accepted');const current=await snap();expect(current.modelValidation.valid).toBe(true);expect(current.modelValidation.blockedFragments.length).toBeGreaterThan(0);
    const solve=await app.inject({method:'POST',url:'/api/plans/solve',headers,payload:{}});expect(solve.statusCode,solve.body).toBe(200);const plan=solve.json();expect(plan.validation.valid,JSON.stringify(plan.validation)).toBe(true);expect(plan.metrics.minimumServiceMinutes).toBe(195);expect(plan.actions.some((action:any)=>action.modeId==='coord-radio')).toBe(false);expect(plan.validation.blockedFragments.length).toBeGreaterThan(0);
    const forged={...baseline,id:randomUUID(),modelRevision:current.model.revision};const validation=await app.inject({method:'POST',url:'/api/plans/validate',headers,payload:{plan:forged}});expect(validation.statusCode,validation.body).toBe(200);expect(validation.json().valid).toBe(false);expect(validation.json().issues.some((issue:any)=>issue.code===(kind==='missing-resource-dependency'?'blocked_resource':'blocked_mode'))).toBe(true);expect((await command('plan.approve',{plan:forged,incidentId:'demo-incident'})).result.code).toBe('invalid_plan');
    plan.validation={valid:true,issues:[],warnings:[]};plan.diagnostics=[];expect((await command('plan.approve',{plan,incidentId:'demo-incident'})).result.status).toBe('accepted');const accepted=await snap();expect(accepted.plans[0].validation.blockedFragments.length).toBeGreaterThan(0);expect(accepted.plans[0].diagnostics.length).toBeGreaterThan(0);const help=accepted.actions.find((action:any)=>action.serviceId==='help');expect(accepted.actions.some((action:any)=>action.serviceId==='coordination')).toBe(false);expect((await command('action.start',{actionId:help.id,expectedVersion:1,checkedConditions:true})).result.status).toBe('accepted');
  },30_000);
  it('executes separate physical units in one group and invalidates their shared resource dependency', async () => {
    const model=(await snap()).model;const equipment=model.resources.find((resource:any)=>resource.id==='radio-1');equipment.quantity=2;equipment.dependencyId='radio-battery';model.modes.find((mode:any)=>mode.id==='help-local').requirements.push({id:'help-radio',type:'equipment',quantity:1,unit:'szt.',tags:['radio'],phase:'both'});
    expect((await command('model.replace',{model})).result.status).toBe('accepted');const state=await approved(),radio=state.actions.find((action:any)=>action.serviceId==='coordination'),help=state.actions.find((action:any)=>action.serviceId==='help');
    const radioUnits=radio.allocations.filter((allocation:any)=>allocation.resourceId==='radio-1').flatMap((allocation:any)=>allocation.unitIds),helpUnits=help.allocations.filter((allocation:any)=>allocation.resourceId==='radio-1').flatMap((allocation:any)=>allocation.unitIds);expect(radioUnits.length).toBeGreaterThan(0);expect(helpUnits.length).toBeGreaterThan(0);expect(radioUnits.some((id:string)=>helpUnits.includes(id))).toBe(false);
    expect((await command('action.start',{actionId:radio.id,expectedVersion:1,checkedConditions:true})).result.status).toBe('accepted');expect((await command('action.start',{actionId:help.id,expectedVersion:1,checkedConditions:true})).result.status).toBe('accepted');
    const started=await snap();expect(started.model.resources.find((resource:any)=>resource.id==='radio-1').occupied).not.toBe(true);expect(started.allocations.filter((allocation:any)=>allocation.resourceId==='radio-1').every((allocation:any)=>allocation.status==='in_use'&&allocation.unitIds?.length===1)).toBe(true);
    const source=await command('observation.create',{text:'Shared battery unavailable',subjectId:'radio-battery',claimedState:'unavailable',source:'Physical resource check',observedAt:new Date().toISOString()});const result=await command('assessment.create',{subjectId:'radio-battery',state:'unavailable',observationIds:[source.result.data.id],reason:'Shared resource dependency failed in the test.'});expect(result.result.status).toBe('accepted');const after=await snap();expect(after.actions.filter((action:any)=>['help','coordination'].includes(action.serviceId)).every((action:any)=>action.needsReview&&action.status==='started')).toBe(true);expect(after.actions.find((action:any)=>action.serviceId==='water').needsReview).toBe(false);
  });
  it('retains legacy provenance gaps explicitly and requires actual sources before publishing a model', async () => {
    const original=await snap();expect(original.readinessIssues).toEqual([]);
    const legacy=app.store.read(user.organizationId);for(const collection of ['services','modes','verificationContracts','dependencies']) delete legacy.model[collection][0].provenance;app.store.save(legacy);
    const state=await snap();expect(state.model.services[0].provenance).toBeUndefined();expect(state.readinessIssues).toHaveLength(4);expect(app.store.read(user.organizationId).model.services[0].provenance).toBeUndefined();
    const preview=await app.inject({method:'POST',url:'/api/import/preview',headers,payload:{format:'json',model:state.model}});expect(preview.json().validation.valid).toBe(false);expect(preview.json().validation.issues.every((issue:any)=>issue.code==='provenance_missing')).toBe(true);
    expect((await command('model.replace',{model:state.model})).result.code).toBe('invalid_payload');
    for(const collection of ['services','modes','verificationContracts','dependencies']) state.model[collection][0].provenance={source:'Actual owner review during this test, no inferred history',checkedAt:new Date().toISOString()};
    state.model.verificationContracts[0].version++;
    expect((await command('model.replace',{model:state.model})).result.status).toBe('accepted');expect((await snap()).readinessIssues).toEqual([]);
  });
  it('records computed assessment impact and unresolved checks even before any plan exists', async () => {
    const state=app.store.read(user.organizationId);state.model.dependencies.find((node:any)=>node.id==='grid-power').state='available';state.model.dependencies.find((node:any)=>node.id==='fiber').state='unknown';app.store.save(state);
    const source=await command('observation.create',{text:'Router tested available',subjectId:'router',claimedState:'available',source:'Own test',observedAt:new Date().toISOString()});
    const assessment=await command('assessment.create',{subjectId:'router',state:'available',observationIds:[source.result.data.id],reason:'Verified using the approved diagnostic procedure.'});expect(assessment.result.status).toBe('accepted');
    const impact=assessment.result.data.computedImpact;expect(impact.affectedServiceIds).toEqual(['coordination','help']);expect(impact.affectedActionIds).toEqual([]);expect(impact.dependencyChanges).toContainEqual({id:'digital-connection',before:'unavailable',after:'unknown'});expect(impact.missingChecks).toEqual(expect.arrayContaining([expect.objectContaining({subjectId:'lte',contact:'Zatwierdzony katalog: dyżurny łączności'}),expect.objectContaining({subjectId:'fiber'})]));
    expect((await snap()).assessments[0].computedImpact).toEqual(impact);expect((await snap()).plans).toHaveLength(0);expect((await snap()).allocations).toHaveLength(0);
    const resourceSource=await command('observation.create',{text:'Pump operator unavailable',subjectId:'person-4',claimedState:'unavailable',source:'Own check',observedAt:new Date().toISOString()});
    const resourceAssessment=await command('assessment.create',{subjectId:'person-4',state:'unavailable',observationIds:[resourceSource.result.data.id],reason:'Operator confirmed unavailability.'});expect(resourceAssessment.result.data.computedImpact.affectedModeIds).toContain('water-generator');
  });
  it('permits independent operators with current action versions while rejecting stale action or changed conditions', async () => {
    const snapshot=await approved(),radio=snapshot.actions.find((action:any)=>action.serviceId==='coordination'),help=snapshot.actions.find((action:any)=>action.serviceId==='help'),water=snapshot.actions.find((action:any)=>action.serviceId==='water');
    const created=await app.inject({method:'POST',url:'/api/users',headers,payload:{username:'independent-operator',password,displayName:'Independent operator',role:'operator'}});const operator=created.json().user;
    const state=app.store.read(user.organizationId);state.actions.find((action:any)=>action.id===help.id).ownerId=operator.id;app.store.save(state);
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:'independent-operator',password}});const operatorHeaders={origin,cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
    await command('action.start',{actionId:radio.id,expectedVersion:1,checkedConditions:true});await command('action.complete',{actionId:radio.id,expectedVersion:2});
    const send=async(type:string,payload:any)=>{const response=await app.inject({method:'POST',url:'/api/commands',headers:operatorHeaders,payload:{commands:[{commandId:randomUUID(),deviceId:'independent-device',organizationId:snapshot.organizationId,baseRevision:snapshot.revision,serverEpoch:snapshot.serverEpoch,dependsOn:[],schemaVersion:1,type,payload}]}});return response.json().results[0];};
    expect((await send('action.accept',{actionId:help.id,expectedVersion:1})).status).toBe('accepted');expect((await send('action.start',{actionId:help.id,expectedVersion:1,checkedConditions:true})).code).toBe('action_changed');expect((await send('action.start',{actionId:help.id,expectedVersion:2,checkedConditions:true})).status).toBe('accepted');expect((await send('action.complete',{actionId:help.id,expectedVersion:3})).status).toBe('accepted');
    expect((await send('verification.create',{actionId:help.id,expectedVersion:4,outcome:'unknown',notes:'Independent observation without a claim of successful service.'})).status).toBe('accepted');
    await command('resource.update',{resourceId:'person-4',state:'unavailable'});expect((await command('action.start',{actionId:water.id,expectedVersion:1,checkedConditions:true},{baseRevision:snapshot.revision})).result.code).toBe('review_required');
    expect((await command('resource.update',{resourceId:'person-3',state:'unavailable'},{baseRevision:snapshot.revision})).result.code).toBe('revision_conflict');
  });
  it('binds a simulated verification measurement to proof from the selected action and contract', async () => {
    const state=await approved(),water=state.actions.find((a:any)=>a.serviceId==='water');await command('action.start',{actionId:water.id,checkedConditions:true});await command('action.complete',{actionId:water.id});
    const simulation=(await app.inject({method:'POST',url:'/api/simulator/test',headers,payload:{actionId:water.id,value:100,durationMinutes:5}})).json();
    expect((await command('verification.create',{actionId:water.id,outcome:'passed',measurement:120,evidenceIds:[simulation.evidence.id]})).result.code).toBe('measurement_mismatch');
    expect((await command('verification.create',{actionId:water.id,outcome:'passed',measurement:100,evidenceIds:[simulation.evidence.id]})).result.status).toBe('accepted');
  });
});
