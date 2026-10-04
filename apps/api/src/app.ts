import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Type } from '@sinclair/typebox';
import argon2 from 'argon2';
import { randomBytes, randomUUID, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createDemoModel } from '../../../packages/scenarios/src/index.js';
import { validatePlan, validateModel, evaluateDependencies, minimalCutSets } from '../../../packages/engine/src/index.js';
import { type Command } from '../../../packages/contracts/src/index.js';
import { Store, type User, emptyState, canonical, now, sha256 } from './store.js';
import { DomainError, executeCommand, requireRole } from './domain.js';
import { previewImport, validateFilename } from './imports.js';
import { runSolver } from './solver.js';
import { adaptersRoutes } from './integrations.js';
import { modelSchema, planSchema } from './validation.js';
import { registerPublicDemo, assertPublicDemoStore } from './public-demo.js';

declare module 'fastify' {
  interface FastifyInstance { store: Store }
  interface FastifyRequest { user: User; csrfToken: string; sessionExpiry: string }
}
export interface AppOptions { dataDir?: string; trustedOrigins?: string[]; secureCookies?: boolean; seedDemo?: boolean; staticDir?: string; store?: Store; signingKey?: string; logger?: boolean; publicDemo?: boolean }
const credentialSchema = Type.Object({ username: Type.String({ minLength: 3, maxLength: 80, pattern: '^[a-zA-Z0-9._@-]+$' }), password: Type.String({ minLength: 12, maxLength: 200 }) });
const commandSchema = Type.Object({ commandId: Type.String({ minLength: 8, maxLength: 150 }), deviceId: Type.String({ minLength: 3, maxLength: 150 }), organizationId: Type.String({ maxLength: 150 }), baseRevision: Type.Integer({ minimum: 0 }), serverEpoch: Type.String({ maxLength: 100 }), dependsOn: Type.Array(Type.String({ maxLength: 150 }), { maxItems: 30 }), type: Type.String({ maxLength: 80 }), schemaVersion: Type.Literal(1), payload: Type.Record(Type.String(), Type.Unknown()), createdAt: Type.Optional(Type.String()) }, { additionalProperties: false });
const escape = (value: any) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function seedDemo(store: Store, organizationId: string, name = 'MOST Demo') {
  const model = createDemoModel(); model.organizationId = organizationId; model.referenceTime = now();
  model.allocationScopes = [];
  for (const contract of model.verificationContracts) if (!contract.verifierRoles.includes('administrator')) contract.verifierRoles.push('administrator');
  const state = emptyState(organizationId, name, model);
  state.incidents.push({ id: 'demo-incident', name: 'Ćwiczenie: utrata zasilania i routera', title: 'Ćwiczenie: utrata zasilania i routera', kind: 'exercise', status: 'open', openedAt: now() });
  state.contacts = [{ id: 'verified-duty', label: 'Dyżurny ćwiczenia', channel: 'Radio, kanał ćwiczenia 1', verifiedAt: now(), source: 'Zatwierdzony katalog demonstracyjny' }];
  store.create(state); return state;
}
export function initializeEmpty(store:Store,organizationId:string,name='Organizacja MOST') {
  const model=createDemoModel(); model.id=randomUUID();model.organizationId=organizationId;model.name=name;model.synthetic=false;model.referenceTime=now();model.services=[];model.modes=[];model.resources=[];model.dependencies=[];model.procedures=[];model.verificationContracts=[];model.reservations=[];model.uncertainties=[];model.travelTimes=[];model.allocationScopes=[];
  const state=emptyState(organizationId,name,model);store.create(state);return state;
}
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token'], serializers: { req: req => ({ method: req.method, url: req.url?.split('?')[0] }) } } : false, bodyLimit: 8 * 1024 * 1024, trustProxy: false });
  const store = options.store ?? new Store(options.dataDir ?? process.env.DATA_DIR ?? 'data'); app.decorate('store', store);
  const publicDemo = options.publicDemo === true;
  if (publicDemo) assertPublicDemoStore(store);
  const origins = options.trustedOrigins ?? (process.env.APP_ORIGIN ?? 'http://localhost:8080').split(',').map(x => x.trim());
  const secureCookies = options.secureCookies ?? origins.every(o => o.startsWith('https:'));
  const signingKey = options.signingKey ?? process.env.MOST_SIGNING_PRIVATE_KEY;
  const seedSynthetic = options.seedDemo ?? process.env.DEMO_MODE !== 'false';
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 600, timeWindow: 60_000, hook: 'preHandler',
    allowList: request => !request.url.split('?')[0].startsWith('/api/'),
    keyGenerator: request => request.user ? `api:${request.user.organizationId}:${request.user.id}` : `anonymous:${normalizeIP(request.ip)}`,
    errorResponseBuilder: (_request, context) => new DomainError('rate_limited', `Zbyt wiele żądań. Spróbuj ponownie za ${Math.max(1, Math.ceil(context.ttl / 1000))} s.`, 429),
  });
  app.decorateRequest('user', null as unknown as User); app.decorateRequest('csrfToken', ''); app.decorateRequest('sessionExpiry', '');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'same-origin'); reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    const url = request.url.split('?')[0];
    if (publicDemo && request.method === 'GET' && ['/', '/index.html'].includes(url) && !request.cookies.most_session) return reply.redirect('/demo');
    if (!url.startsWith('/api/')) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!request.headers.origin || !origins.includes(request.headers.origin)) throw new DomainError('invalid_origin', 'Żądanie pochodzi spoza zaufanego adresu aplikacji.', 403);
    }
    const publicRoute = ['/api/auth/status','/api/auth/bootstrap','/api/auth/login','/api/session','/api/health/live','/api/health/ready', ...(publicDemo ? ['/api/auth/demo'] : [])].includes(url);
    const sessionToken = request.cookies.most_session;
    if (sessionToken) {
      const session = store.db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND s.epoch=? AND u.active=1').get(sha256(sessionToken), now(), store.epoch) as any;
      if (session) { request.user = store.user(session); request.csrfToken = session.csrf; request.sessionExpiry = session.expires_at; }
    }
    if (!publicRoute && !request.user) throw new DomainError('unauthenticated', 'Zaloguj się ponownie. Lokalna kolejka pozostaje zachowana.', 401);
    if (request.user && !['GET','HEAD'].includes(request.method) && !['/api/auth/bootstrap','/api/auth/login'].includes(url) && request.headers['x-csrf-token'] !== request.csrfToken) throw new DomainError('csrf_failed', 'Sesja wymaga odświeżenia tokenu zabezpieczającego.', 403);
  });
  app.setErrorHandler((error: any, _request, reply) => {
    const status = error.statusCode ?? 500;
    reply.code(status).send({ code: error.code ?? 'internal_error', message: status >= 500 ? 'Nie udało się wykonać operacji. Zapis nie został potwierdzony.' : error.message, ...(error.details ? { details: error.details } : {}) });
  });
  function session(reply: any, user: User) {
    const token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(24).toString('base64url'), expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
    store.db.prepare('INSERT INTO sessions(id_hash,user_id,csrf,expires_at,epoch) VALUES (?,?,?,?,?)').run(sha256(token), user.id, csrfToken, expiresAt, store.epoch);
    reply.setCookie('most_session', token, { path: '/', httpOnly: true, secure: secureCookies, sameSite: 'strict', maxAge: 8 * 3600 });
    return { user, csrfToken, serverEpoch: store.epoch, offlineExpiresAt: expiresAt, bootstrapRequired: false };
  }
  if (publicDemo) registerPublicDemo(app, store, session, seedDemo);
  app.get('/api/auth/status', () => ({ needsBootstrap: !publicDemo && (store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count === 0, bootstrapRequired: !publicDemo && (store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count === 0 }));
  app.get('/api/session', request => request.user ? { user: request.user, csrfToken: request.csrfToken, serverEpoch: store.epoch, offlineExpiresAt: request.sessionExpiry, bootstrapRequired: false } : { user: null, bootstrapRequired: (store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count === 0 });
  app.get('/api/auth/me', request => ({ user: request.user, csrfToken: request.csrfToken, serverEpoch: store.epoch, offlineExpiresAt: request.sessionExpiry }));
  app.post('/api/auth/bootstrap', { config: { rateLimit: { max: 5, timeWindow: 60_000, hook: 'onRequest', keyGenerator: request => `bootstrap:${normalizeIP(request.ip)}` } }, schema: { body: Type.Intersect([credentialSchema, Type.Object({ displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), organizationName: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })) })]) } }, async (request, reply) => {
    if (publicDemo) throw new DomainError('public_demo', 'Otwórz /demo, aby uruchomić własne ćwiczenie.', 403);
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip)||['forwarded','x-forwarded-for','x-real-ip','x-forwarded-host','x-forwarded-proto'].some(header=>request.headers[header]!==undefined)) throw new DomainError('local_bootstrap_only', 'Pierwsze konto utwórz bezpośrednio na serwerze, przed udostępnieniem przez LAN lub proxy.', 403);
    if ((store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count) throw new DomainError('already_initialized', 'Instalacja ma już administratora.', 409);
    const body = request.body as any; const hash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    const user: User = { id: randomUUID(), organizationId: randomUUID(), username: body.username, displayName: body.displayName ?? body.username, role: 'administrator', active: true };
    store.db.transaction(() => {
      if ((store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count) throw new DomainError('already_initialized', 'Instalacja ma już administratora.', 409);
      const state = seedSynthetic?seedDemo(store, user.organizationId, body.organizationName ?? 'MOST: organizacja demonstracyjna'):initializeEmpty(store,user.organizationId,body.organizationName??'Organizacja MOST');
      for (const service of state.model.services) { service.ownerId = user.id; service.deputyId = user.id; }
      store.save(state);
      store.db.prepare('INSERT INTO users(id,organization_id,username,display_name,role,password_hash) VALUES (?,?,?,?,?,?)').run(user.id, user.organizationId, user.username, user.displayName, user.role, hash);
      store.event(state, user.id, 'organization.bootstrap', { userId: user.id, synthetic: state.model.synthetic });
    })();
    return session(reply, user);
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: 60_000, hook: 'onRequest', keyGenerator: request => `login:${normalizeIP(request.ip)}` } }, schema: { body: credentialSchema } }, async (request, reply) => {
    if (publicDemo) throw new DomainError('public_demo', 'Otwórz /demo, aby uruchomić własne ćwiczenie.', 403);
    const body = request.body as any; const row = store.db.prepare('SELECT * FROM users WHERE username=?').get(body.username) as any;
    const valid = row && await argon2.verify(row.password_hash, body.password);
    if (!valid || !row.active) throw new DomainError('invalid_credentials', 'Nieprawidłowy login lub hasło.', 401);
    return session(reply, store.user(row));
  });
  app.post('/api/auth/logout', (request, reply) => { if (request.cookies.most_session) store.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(sha256(request.cookies.most_session)); reply.clearCookie('most_session', { path: '/' }); return { loggedOut: true }; });
  app.get('/api/users', request => { requireRole(request.user, ['administrator','coordinator']); return { users: store.users(request.user.organizationId) }; });
  app.post('/api/users', { schema: { body: Type.Intersect([credentialSchema, Type.Object({ displayName: Type.String({ minLength: 1, maxLength: 100 }), role: Type.Union(['administrator','coordinator','owner','operator','observer'].map(x => Type.Literal(x))) })]) } }, async request => {
    requireRole(request.user, ['administrator']); const body = request.body as any;
    const hash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    const user = { id: randomUUID(), organizationId: request.user.organizationId, username: body.username, displayName: body.displayName, role: body.role, active: true };
    store.db.transaction(() => { if (store.db.prepare('SELECT id FROM users WHERE username=?').get(user.username)) throw new DomainError('username_exists', 'Login jest już zajęty.', 409); store.db.prepare('INSERT INTO users(id,organization_id,username,display_name,role,password_hash) VALUES (?,?,?,?,?,?)').run(user.id, user.organizationId, user.username, user.displayName, user.role, hash); store.event(store.read(user.organizationId), request.user.id, 'user.created', { userId: user.id, role: user.role }); })(); return { user };
  });
  app.patch('/api/users/:id', { schema: { body: Type.Object({ role: Type.Optional(Type.Union(['administrator','coordinator','owner','operator','observer'].map(x => Type.Literal(x)))), active: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) } }, request => {
    requireRole(request.user, ['administrator']); const body = request.body as any, id = (request.params as any).id;
    const row = store.db.prepare('SELECT * FROM users WHERE id=? AND organization_id=?').get(id, request.user.organizationId) as any;
    if (!row) throw new DomainError('not_found', 'Nie znaleziono konta.', 404);
    if (row.role === 'administrator' && (body.active === false || body.role && body.role !== 'administrator') && (store.db.prepare("SELECT COUNT(*) AS count FROM users WHERE organization_id=? AND role='administrator' AND active=1").get(request.user.organizationId) as any).count <= 1) throw new DomainError('last_administrator', 'Nie można wyłączyć ostatniego administratora.', 409);
    store.db.transaction(() => { store.db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(body.role ?? row.role, body.active === undefined ? row.active : Number(body.active), id); store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); store.event(store.read(request.user.organizationId), request.user.id, 'user.updated', { userId: id, ...body }); })(); return { user: store.user(store.db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
  });
  app.get('/api/devices', request => { requireRole(request.user, ['administrator']); return { devices: store.db.prepare('SELECT * FROM devices WHERE organization_id=?').all(request.user.organizationId) }; });
  app.post('/api/devices/:id/revoke', request => { requireRole(request.user, ['administrator']); store.db.prepare('UPDATE devices SET revoked=1 WHERE id=? AND organization_id=?').run((request.params as any).id, request.user.organizationId); return { revoked: true }; });
  app.get('/api/snapshot', request => store.snapshot(request.user));
  app.get('/api/changes', request => {
    const query = request.query as any; const epoch = query.serverEpoch ?? query.epoch; const after = Number(query.after ?? query.serverSeq ?? 0);
    if (epoch !== store.epoch || !Number.isSafeInteger(after) || after < 0 || after > store.sequence) throw new DomainError('snapshot_required', 'Pobierz nowy snapshot. Zachowaj lokalną kolejkę.', 409);
    return store.db.transaction(() => {
      const events = (store.db.prepare('SELECT * FROM events WHERE organization_id=? AND seq>? ORDER BY seq LIMIT 501').all(request.user.organizationId, after) as any[]).map(row => ({ serverSeq: row.seq, serverEpoch: row.epoch, organizationId: row.organization_id, authorId: row.actor_id, type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at, hash: row.hash, previousHash: row.previous_hash }));
      return { serverEpoch: store.epoch, serverSeq: store.sequence, events: events.slice(0, 500), hasMore: events.length > 500, nextCursor: events.length > 500 ? events[499].serverSeq : store.sequence };
    })();
  });
  app.post('/api/commands', { schema: { body: Type.Object({ commands: Type.Array(commandSchema, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }) } }, request => {
    const results = (request.body as { commands: Command[] }).commands.map(command => { try { return executeCommand(store, request.user, command); } catch (error) { if (!(error instanceof DomainError)) throw error; return { commandId: command.commandId, status: error.statusCode === 409 ? 'conflict' : 'rejected', code: error.code, message: error.message, details: error.details }; } });
    return { results, serverEpoch: store.epoch, serverSeq: store.sequence };
  });
  function directCommand(request: FastifyRequest, type: string, payload: any) {
    const state = store.read(request.user.organizationId); const body = request.body as any;
    return executeCommand(store, request.user, { commandId: body.commandId ?? randomUUID(), deviceId: body.deviceId ?? 'web-direct', organizationId: request.user.organizationId, baseRevision: body.baseRevision ?? state.revision, serverEpoch: body.serverEpoch ?? store.epoch, dependsOn: [], type, schemaVersion: 1, payload });
  }
  const solverBody = Type.Object({ model: Type.Optional(modelSchema), horizonMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), stepMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), budgetMs: Type.Optional(Type.Number({minimum:100,maximum:30000})), assumptions: Type.Optional(Type.Record(Type.String(),Type.Union(['available','unavailable','unknown'].map(value=>Type.Literal(value))))) }, { additionalProperties: false });
  app.post('/api/plans/solve', { schema: { body: solverBody } }, async request => {
    const body = request.body as any ?? {}; const model = structuredClone(body.model ?? store.read(request.user.organizationId).model);
    if (body.horizonMinutes !== undefined) model.horizonMinutes = body.horizonMinutes; if (body.stepMinutes !== undefined) model.stepMinutes = body.stepMinutes;
    return await runSolver(model, { budgetMs: body.budgetMs, assumptions: body.assumptions });
  });
  app.post('/api/plans/rank', { schema: { body: solverBody } }, async request => { const body = request.body as any ?? {}; return runSolver(body.model ?? store.read(request.user.organizationId).model, { budgetMs: body.budgetMs }, 'rank'); });
  app.post('/api/plans/validate', { schema: { body: Type.Object({model:Type.Optional(modelSchema),plan:planSchema}) } }, request => { const body = request.body as any; return validatePlan(body.model ?? store.read(request.user.organizationId).model, body.plan); });
  app.post('/api/plans/approve', request => directCommand(request, 'plan.approve', request.body));
  app.post('/api/verifications', request => directCommand(request, 'verification.create', request.body));
  app.get('/api/model/analysis', request => { const model = store.read(request.user.organizationId).model; return { validation: validateModel(model), availability: evaluateDependencies(model), cutSets: model.dependencies.filter((d: any) => d.kind !== 'leaf').map((d: any) => ({ dependencyId: d.id, ...minimalCutSets(model, d.id, { limit: 256 }) })) }; });
  app.post('/api/import/preview', {schema:{body:Type.Object({format:Type.Optional(Type.String({maxLength:30})),model:Type.Optional(Type.Unknown()),filename:Type.Optional(Type.String({maxLength:200})),content:Type.Optional(Type.Union([Type.String({maxLength:5_000_000}),Type.Record(Type.String(),Type.Unknown())])),base64:Type.Optional(Type.String({maxLength:7_000_000})),entity:Type.Optional(Type.String({maxLength:100}))})}}, async request => {
    requireRole(request.user, ['administrator','coordinator','owner']); const state = store.read(request.user.organizationId);
    const preview = await previewImport(state, request.body); store.db.prepare('INSERT INTO import_previews(id,organization_id,user_id,revision,content,expires_at) VALUES (?,?,?,?,?,?)').run(preview.id, request.user.organizationId, request.user.id, state.revision, JSON.stringify(preview), new Date(Date.now() + 3600_000).toISOString());
    return preview;
  });
  app.post('/api/import/commit', request => {
    requireRole(request.user, ['administrator','coordinator','owner']); const body = request.body as any;
    const row = store.db.prepare('SELECT * FROM import_previews WHERE id=? AND organization_id=? AND user_id=? AND expires_at>?').get(body.previewId, request.user.organizationId, request.user.id, now()) as any;
    if (!row) throw new DomainError('preview_expired', 'Podgląd wygasł lub należy do innego konta.', 409);
    const preview = JSON.parse(row.content); if (preview.type !== 'model') throw new DomainError('draft_only', 'Szkic dokumentu wymaga ręcznej edycji i zatwierdzenia modelu.');
    if (row.revision !== store.read(request.user.organizationId).revision) throw new DomainError('revision_conflict', 'Stan zmienił się od wykonania podglądu.', 409);
    return directCommand(request, 'model.replace', { model: preview.model });
  });
  app.post('/api/evidence', { schema: { body: Type.Object({ filename: Type.String({ maxLength: 200 }), mimeType: Type.String({ maxLength: 120 }), base64: Type.String({ maxLength: 7_000_000 }) }, { additionalProperties: false }) } }, request => {
    requireRole(request.user, ['administrator','coordinator','owner','operator']); const body = request.body as any;
    const filename = validateFilename(body.filename); if (!/^(application\/(pdf|json|octet-stream|vnd.openxmlformats-officedocument.wordprocessingml.document)|text\/(plain|csv)|image\/(png|jpeg|webp))$/.test(body.mimeType)) throw new DomainError('unsupported_media', 'Nieobsługiwany format dowodu.');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) throw new DomainError('invalid_base64', 'Nieprawidłowa zawartość pliku.');
    const bytes = Buffer.from(body.base64, 'base64'); if (bytes.length > 5 * 1024 * 1024 || bytes.length === 0) throw new DomainError('invalid_size', 'Dowód musi mieć od 1 bajtu do 5 MiB.', 413);
    return store.putEvidence(request.user.organizationId, filename, body.mimeType, bytes);
  });
  app.get('/api/evidence/:hash', (request, reply) => {
    const hash = (request.params as any).hash; if (!store.evidenceComplete(request.user.organizationId, hash)) throw new DomainError('missing_evidence', 'Plik nie istnieje lub jego hash się nie zgadza.', 404);
    const row = store.db.prepare('SELECT * FROM evidence WHERE hash=? AND organization_id=?').get(hash, request.user.organizationId) as any;
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`); reply.type(row.media_type); return readFileSync(join(store.evidenceDir, hash));
  });
  app.post('/api/register/test', { schema: { body: Type.Object({ actionId: Type.String({ maxLength: 250 }), value: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }) } }, request => {
    requireRole(request.user, ['administrator','coordinator','owner','operator']); const body = request.body as any; const state = store.read(request.user.organizationId), action = state.actions.find(a => a.id === body.actionId);
    if (!action || !['started','completed'].includes(action.status)) throw new DomainError('action_not_started', 'Rozpocznij właściwą czynność przed testem rejestru.', 409);
    if (!['administrator','coordinator'].includes(request.user.role) && action.ownerId !== request.user.id) throw new DomainError('not_assigned', 'To zadanie ma innego wykonawcę.', 403);
    const mode = state.model.modes.find((m: any) => m.id === action.modeId), contract = state.model.verificationContracts.find((c: any) => c.id === mode?.verificationContractId);
    if (!contract || contract.simulated || !/rejestr|register/i.test(contract.title + contract.metric)) throw new DomainError('wrong_contract', 'Ta czynność nie dotyczy lokalnego rejestru.');
    const record = { id: randomUUID(), organizationId: request.user.organizationId, incidentId: action.incidentId, actionId: action.id, value: body.value, createdAt: now() };
    store.db.prepare('INSERT INTO register_records(id,organization_id,incident_id,action_id,value,created_at) VALUES (?,?,?,?,?,?)').run(record.id, record.organizationId, record.incidentId, record.actionId, record.value, record.createdAt);
    const readBack = store.db.prepare('SELECT * FROM register_records WHERE id=? AND organization_id=?').get(record.id, request.user.organizationId) as any;
    const readBackVerified = readBack.value === record.value;
    const evidence = store.putEvidence(request.user.organizationId, `register-test-${record.id}.json`, 'application/json', Buffer.from(JSON.stringify({ record, readBackVerified, testedAt: now(), scope: 'Rzeczywisty zapis i odczyt lokalnego rejestru SQLite. Syntetyczny rekord, bez danych mieszkańca.' })));
    return { record, readBackVerified, evidence };
  });
  app.get('/api/register', request => ({ records: store.db.prepare('SELECT id,incident_id,action_id,value,created_at FROM register_records WHERE organization_id=? ORDER BY created_at DESC LIMIT 1000').all(request.user.organizationId) }));
  app.post('/api/simulator/test', { schema: { body: Type.Object({ actionId: Type.String({ maxLength: 250 }), value: Type.Number({ minimum: 0 }), durationMinutes: Type.Optional(Type.Number({ minimum: 0.01, maximum: 120 })) }, { additionalProperties: false }) } }, request => {
    requireRole(request.user, ['administrator','coordinator','owner','operator']); const body = request.body as any; const state = store.read(request.user.organizationId), action = state.actions.find(a => a.id === body.actionId);
    if (!state.model.synthetic || !action || !['started','completed'].includes(action.status)) throw new DomainError('simulation_unavailable', 'Symulator służy wyłącznie rozpoczętym czynnościom syntetycznego ćwiczenia.', 409);
    if (!['administrator','coordinator'].includes(request.user.role) && action.ownerId !== request.user.id) throw new DomainError('not_assigned', 'To zadanie ma innego wykonawcę.', 403);
    const mode = state.model.modes.find((m: any) => m.id === action.modeId), contract = state.model.verificationContracts.find((c: any) => c.id === mode?.verificationContractId);
    if (!contract?.simulated) throw new DomainError('real_test_required', 'Ta czynność wymaga rzeczywistego testu rejestru.');
    const result = { actionId: action.id, contractId: contract.id, contractVersion: contract.version, simulated: true, simulation: action.serviceId === 'water' ? 'Syntetyczny pomiar przepływu pompy' : 'Syntetyczne przekazanie i potwierdzenie meldunku radiowego', measuredValue: body.value, unit: contract.unit, durationMinutes: body.durationMinutes ?? 5, meetsMinimum: body.value >= contract.minimum, observedAt: now(), limitation: 'Symulator nie komunikuje się z radiem ani pompą. Wynik nie potwierdza działania fizycznego urządzenia.' };
    const evidence = store.putEvidence(request.user.organizationId, `simulator-${randomUUID()}.json`, 'application/json', Buffer.from(JSON.stringify(result)));
    return { result, evidence };
  });
  app.get('/api/bundle/key', () => {
    if (!signingKey) throw new DomainError('signing_unavailable', 'Klucz podpisujący nie został dostarczony przez psst.', 503);
    const publicKey = createPublicKey(createPrivateKey(signingKey)); const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return { algorithm: 'Ed25519', keyId: sha256(publicPem).slice(0, 16), publicKey: publicPem, publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), trust: 'Zaufaj temu kluczowi niezależną drogą przed incydentem. Podpis nie dowodzi prawdziwości danych.' };
  });
  app.get('/api/bundle', request => {
    if (!signingKey) throw new DomainError('signing_unavailable', 'Klucz podpisujący nie został dostarczony przez psst.', 503);
    const snapshot = store.snapshot(request.user), files: any[] = [{ path: 'snapshot.json', encoding: 'base64', content: Buffer.from(JSON.stringify(snapshot)).toString('base64') }];
    for (const evidence of snapshot.evidence) if (evidence.complete) files.push({ path: `evidence/${evidence.hash}`, encoding: 'base64', content: readFileSync(join(store.evidenceDir, evidence.hash)).toString('base64') });
    const publicPem = createPublicKey(createPrivateKey(signingKey)).export({ type: 'spki', format: 'pem' }).toString();
    let application:any={complete:false,files:[],reason:'release_manifest_missing'};
    const releaseFile=join(staticDir,'release-manifest.json');
    if(existsSync(releaseFile)) {
      const release=JSON.parse(readFileSync(releaseFile,'utf8'));
      if(!Array.isArray(release.files)||!release.files.some((file:any)=>file.path==='highs.wasm')||!release.files.some((file:any)=>file.path==='index.html')) throw new DomainError('release_incomplete','Manifest aplikacji nie obejmuje wymaganych plików.',409);
      const assets=release.files.map((file:any)=>{
        if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.includes('\\')||file.path.split('/').includes('..')||!file.path||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0) throw new DomainError('release_invalid','Nieprawidłowy manifest plików aplikacji.',409);
        const filePath=join(staticDir,file.path); if(!existsSync(filePath))throw new DomainError('release_incomplete','Brakuje pliku aplikacji objętego manifestem.',409);
        const content=readFileSync(filePath); if(content.length!==file.size||sha256(content)!==file.sha256)throw new DomainError('release_changed','Plik aplikacji różni się od zamrożonego wydania. Wykonaj pełny build.',409);
        return {path:`/${file.path}`,sha256:file.sha256,size:file.size};
      });
      if(new Set(assets.map((file:any)=>file.path)).size!==assets.length)throw new DomainError('release_invalid','Manifest powtarza pliki aplikacji.',409);
      application={complete:true,version:release.version,builtAt:release.builtAt,files:assets};
    }
    const manifest = { schemaVersion: 1, id: randomUUID(), organizationId: request.user.organizationId, userId: request.user.id, serverEpoch: store.epoch, serverSeq: snapshot.serverSeq, modelRevision: snapshot.model.revision, createdAt: now(), expiresAt: request.sessionExpiry, keyId: sha256(publicPem).slice(0, 16), scope: ['application-assets','model','procedures','organization-events','evidence'], application, files: files.map(file => { const bytes = Buffer.from(file.content, 'base64'); return { path: file.path, sha256: sha256(bytes), size: bytes.length }; }) };
    const manifestBytes = Buffer.from(canonical(manifest)); return { manifest, manifestBytes: manifestBytes.toString('base64'), signature: sign(null, manifestBytes, createPrivateKey(signingKey)).toString('base64'), algorithm: 'Ed25519', files, warning: 'Podpis potwierdza pochodzenie i integralność wobec wcześniej zaufanego klucza, nie prawdziwość informacji.' };
  });
  app.get('/api/incidents/:id/report', (request, reply) => {
    const snapshot = store.snapshot(request.user); const incident = snapshot.incidents.find(i => i.id === (request.params as any).id); if (!incident) throw new DomainError('not_found', 'Nie znaleziono incydentu.', 404);
    const plans = snapshot.plans.filter(p => p.incidentId === incident.id), actions = snapshot.actions.filter(a => a.incidentId === incident.id), observations = snapshot.observations.filter(o => !o.incidentId || o.incidentId === incident.id), verifications = snapshot.verifications.filter(v => actions.some(a => a.id === v.actionId));
    const report = { schemaVersion: 1, generatedAt: now(), organizationId: snapshot.organizationId, incident, serverEpoch: snapshot.serverEpoch, serverSeq: snapshot.serverSeq, modelRevision: snapshot.model.revision, model: snapshot.model, observations, assessments: snapshot.assessments, plans, actions, verifications, executionClock: snapshot.executionClock, readinessTrials: snapshot.readinessTrials.filter((trial:any)=>trial.incidentId===incident.id), evidence: snapshot.evidence, allocations: snapshot.allocations, localAllocations: snapshot.localAllocations ?? [], gaps: [...snapshot.evidence.filter(e => !e.complete).map(e => `Brak dowodu ${e.hash}`), ...actions.filter(a => !verifications.some(v => v.actionId === a.id && v.current)).map(a => `Brak aktualnego potwierdzenia czynności ${a.id}`)], synthetic: snapshot.model.synthetic, physicalScope: snapshot.model.synthetic ? 'Parametry i sprzęt demonstracji są syntetyczne. Zapis i odczyt rejestru aplikacji są rzeczywiste.' : 'Raport organizacji obejmuje zapisane czynności, pomiary i ich dowody. Zakres potwierdzenia wynika z kontraktów testów i aktualności wyników.', forecasting: 'Prognoza, zatwierdzenie planu, wykonanie i potwierdzenie wyniku są odrębnymi stanami.' };
    const format = (request.query as any).format ?? 'json';
    if (format === 'csv') {
      const quote=(value:any)=>{ const raw=typeof value==='object'?JSON.stringify(value):String(value??''); return '"'+(/^[=+@\-\t\r\n]/.test(raw)?"'"+raw:raw).replace(/"/g,'""')+'"'; };
      const rows:any[][]=[];
      for(const [type,collection] of Object.entries({observation:observations,assessment:report.assessments,plan:plans,action:actions,verification:verifications,readiness_trial:report.readinessTrials,evidence:report.evidence,allocation:report.allocations,local_allocation:report.localAllocations})) for(const entry of collection as any[]) rows.push([type,entry.id??entry.hash,entry.serviceId,entry.planId,entry.status??entry.outcome??entry.verificationStatus,entry.observedAt??entry.approvedAt??entry.createdAt,entry.measuredValue??entry.measuredLevel,entry.unit,entry.source,entry]);
      for(const plan of plans) for(const line of plan.timeline) rows.push(['service_timeline',line.serviceId,line.serviceId,plan.id,'model_prediction',plan.referenceTime,line.minimumMinutes,'service-minutes','independent-validator',line]);
      for(const gap of report.gaps) rows.push(['gap','','','','unconfirmed','','','','',gap]);
      reply.type('text/csv; charset=utf-8'); return '\uFEFFrecord_type,id,service_id,plan_id,status,time,value,unit,source,details\r\n'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
    }
    if (format === 'html') {
      reply.type('text/html; charset=utf-8'); return `<!doctype html><html lang="pl"><meta charset="utf-8"><title>MOST: raport</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;color:#142733}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbc7d0;padding:8px;text-align:left}pre{white-space:pre-wrap}h2{margin-top:32px}@media print{body{margin:12px}}</style><h1>MOST: ${escape(incident.name)}</h1><p>${escape(report.generatedAt)}. Model ${escape(report.modelRevision)}. ${report.synthetic ? 'Dane syntetyczne.' : ''}</p><p>${escape(report.forecasting)}</p><p>${escape(report.executionClock.description)}</p><h2>Wyniki planowania</h2>${plans.map(p => `<h3>${escape(p.id)}: ${escape(p.status)} / ${escape(p.approvalStatus)}</h3><p>Minimum: ${escape(p.metrics.minimumServiceMinutes)} z ${escape(p.metrics.possibleServiceMinutes)} usługominut. Przerwy: ${escape(p.metrics.outageServiceMinutes)}.</p><p>Horyzont: ${p.horizonMinutes} min, krok: ${p.stepMinutes} min. ${escape(p.analysisScope.join('; '))}</p>`).join('')}<h2>Wykonanie i testy</h2><table><tr><th>Czynność</th><th>Wykonanie</th><th>Potwierdzenie</th></tr>${actions.map(a => `<tr><td>${escape(a.modeId)}</td><td>${escape(a.status)}</td><td>${verifications.filter(v => v.actionId === a.id).map(v => escape(v.outcome) + (v.current ? ' (aktualne)' : ' (historyczne lub niepotwierdzone)')).join(', ') || 'Brak testu'}</td></tr>`).join('')}</table><h2>Przygotowanie i próby znanego dobrego stanu</h2>${report.readinessTrials.map((t:any)=>`<p>${escape(t.modeId)}: przygotowanie danych ${escape(t.preparationMinutes)} min, uruchomienie ${escape(t.observedSetupMinutes)} min, wynik ${escape(t.measuredLevel)} ${escape(t.unit)}. ${t.current ? 'Aktualny dowód.' : 'Dowód historyczny.'} ${t.requiresModelReview ? 'Parametry wymagają przeglądu.' : ''} Źródło: ${escape(t.source)}.</p>`).join('') || '<p>Nie zapisano zatwierdzonej próby.</p>'}<h2>Meldunki i źródła</h2>${observations.map(o => `<p><strong>${escape(o.source)}</strong>, ${escape(o.observedAt)}: ${escape(o.original)} [${escape(o.verificationStatus)}]</p>`).join('')}<h2>Braki</h2><ul>${report.gaps.map(g => `<li>${escape(g)}</li>`).join('')}</ul><h2>Zakres dowodu</h2><p>${escape(report.physicalScope)}</p><h2>Parametry i dowody</h2><pre>${escape(JSON.stringify({ evidence: report.evidence, verifications, allocations: report.allocations, localAllocations: report.localAllocations, readinessTrials: report.readinessTrials }, null, 2))}</pre></html>`;
    }
    return report;
  });
  app.get('/api/events', (request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const emit = () => { if (Date.parse(request.sessionExpiry) <= Date.now() || !store.db.prepare('SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.epoch=? AND s.expires_at>? AND u.active=1').get(sha256(request.cookies.most_session??''),store.epoch,now())) { reply.raw.end(); return; } reply.raw.write(`event: cursor\ndata: ${JSON.stringify({ serverEpoch: store.epoch, serverSeq: store.sequence })}\n\n`); };
    emit(); const interval = setInterval(emit, 5000); request.raw.on('close', () => clearInterval(interval));
  });
  app.get('/api/health/live', () => ({ live: true }));
  app.get('/api/health/ready', (_request, reply) => { try { store.db.prepare('SELECT 1').get(); return { ready: true, schemaVersion: 1, serverEpoch: store.epoch, integrations: { ai: process.env.AI_PROVIDER ?? 'none', publicImport: process.env.PUBLIC_IMPORT_ENABLED === 'true', signingConfigured: Boolean(signingKey) } }; } catch { reply.code(503); return { ready: false }; } });
  adaptersRoutes(app);
  const staticDir = resolve(options.staticDir ?? 'apps/web/dist');
  if (existsSync(staticDir)) { await app.register(fastifyStatic, { root: staticDir, prefix: '/', setHeaders: (res, path) => { if (/\.(js|css|wasm|woff2)$/.test(path)) res.header('Cache-Control', 'public,max-age=86400'); } }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') || publicDemo && request.url.startsWith('/materialy/') ? reply.code(404).send({ code: 'not_found' }) : reply.sendFile('index.html')); }
  app.addHook('onClose', async () => { if (!options.store) store.close(); });
  return app;
}
