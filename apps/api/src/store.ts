import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { modelStructureIssues, modelProvenanceIssues } from './validation.js';
import { validateModel } from '../../../packages/engine/src/index.js';

export const now = () => new Date().toISOString();
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: any): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export type Role = 'administrator' | 'coordinator' | 'owner' | 'operator' | 'observer';
export interface User { id: string; organizationId: string; username: string; displayName: string; role: Role; active: boolean; }
export interface State {
  organizationId: string; organizationName: string; revision: number; model: any;
  incidents: any[]; observations: any[]; assessments: any[]; plans: any[]; actions: any[];
  verifications: any[]; allocations: any[]; allocationScopes: any[]; evidence: any[];
  contacts: any[]; recovery: { isolated: boolean; accountsReviewed: boolean; resourcesReconciled: boolean };
  [key: string]: any;
}
export function emptyState(organizationId: string, name: string, model: any): State {
  return { organizationId, organizationName: name, revision: 1, model, incidents: [], observations: [], assessments: [], plans: [], actions: [], verifications: [], allocations: [], localAllocations: [], allocationScopes: [], evidence: [], contacts: [], readinessTrials: [], recovery: { isolated: false, accountsReviewed: true, resourcesReconciled: true } };
}
export class Store {
  db: Database.Database; dataDir: string; evidenceDir: string;
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir); this.evidenceDir = join(this.dataDir, 'evidence');
    mkdirSync(this.evidenceDir, { recursive: true });
    this.db = new Database(join(this.dataDir, 'most.sqlite'));
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    const existingTables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row => row.name);
    const storedVersion = existingTables.includes('metadata') ? this.meta('schemaVersion') : undefined;
    const pragmaVersion = this.db.pragma('user_version',{simple:true});
    if (storedVersion !== '1' && existingTables.length || ![0,1].includes(Number(pragmaVersion))) { this.db.close(); throw new Error(`Unsupported database schema ${storedVersion ?? 'unversioned'} (SQLite ${pragmaVersion}); explicit migration is required. Existing data was not overwritten.`); }
    try { this.db.transaction(() => {
    if (!existingTables.length) this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at TEXT NOT NULL, epoch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (organization_id TEXT NOT NULL, command_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(organization_id, command_id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL REFERENCES organizations(id), epoch TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (hash TEXT NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(hash, organization_id));
      CREATE TABLE IF NOT EXISTS import_previews (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS register_records (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), incident_id TEXT NOT NULL, action_id TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), organization_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen TEXT NOT NULL, PRIMARY KEY(id,user_id));
      CREATE TABLE IF NOT EXISTS integration_usage (day TEXT NOT NULL, provider TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, budget REAL NOT NULL DEFAULT 0, PRIMARY KEY(day, provider));
    `);
    if (!this.meta('serverEpoch')) this.setMeta('serverEpoch', randomUUID());
    if (!existingTables.length) this.setMeta('schemaVersion', '1');
    const requiredColumns: Record<string,string[]> = {
      metadata:['key','value'],organizations:['id','state'],users:['id','organization_id','username','display_name','role','password_hash','active'],
      sessions:['id_hash','user_id','csrf','expires_at','epoch'],commands:['organization_id','command_id','user_id','device_id','hash','result','created_at'],
      events:['seq','organization_id','epoch','actor_id','type','payload','created_at','previous_hash','hash'],evidence:['hash','organization_id','name','media_type','size','created_at'],
      import_previews:['id','organization_id','user_id','revision','content','expires_at'],register_records:['id','organization_id','incident_id','action_id','value','created_at'],
      devices:['id','user_id','organization_id','revoked','last_seen'],integration_usage:['day','provider','count','budget'],
    };
    for (const [table, required] of Object.entries(requiredColumns)) {
      const columns = new Set((this.db.pragma(`table_info(${table})`) as {name:string}[]).map(column=>column.name));
      if (required.some(column=>!columns.has(column))) throw new Error(`Database schema 1 is incomplete: ${table}. Explicit migration or recovery is required.`);
    }
    this.db.pragma('user_version = 1');
    })(); } catch (error) { this.db.close(); throw error; }
  }
  meta(key: string) { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as any)?.value as string | undefined; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  get epoch() { return this.meta('serverEpoch')!; }
  get sequence() { return (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as any).seq as number; }
  read(organizationId: string): State {
    const row = this.db.prepare('SELECT state FROM organizations WHERE id=?').get(organizationId) as any;
    if (!row) throw new Error('Organization not found');
    const state = JSON.parse(row.state);
    if (state.organizationId !== organizationId || !Number.isSafeInteger(state.revision) || state.revision < 1 || modelStructureIssues(state.model).length || ['incidents','observations','assessments','plans','actions','verifications','allocations','allocationScopes','contacts'].some(key=>!Array.isArray(state[key]))) throw new Error('Stored organization schema is invalid; explicit migration or recovery is required.');
    return state;
  }
  save(state: State) { this.db.prepare('UPDATE organizations SET state=? WHERE id=?').run(JSON.stringify(state), state.organizationId); }
  create(state: State) { this.db.prepare('INSERT INTO organizations(id,state) VALUES (?,?)').run(state.organizationId, JSON.stringify(state)); }
  user(row: any): User { return { id: row.id, organizationId: row.organization_id, username: row.username, displayName: row.display_name, role: row.role, active: Boolean(row.active) }; }
  users(organizationId: string) { return (this.db.prepare('SELECT * FROM users WHERE organization_id=? ORDER BY display_name').all(organizationId) as any[]).map(r => this.user(r)); }
  event(state: State, actorId: string, type: string, payload: any) {
    const previous = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get() as any;
    const createdAt = now(); const previousHash = previous?.hash ?? '';
    const data = { organizationId: state.organizationId, serverEpoch: this.epoch, actorId, type, payload, createdAt, previousHash };
    const hash = sha256(canonical(data));
    const insert = this.db.prepare('INSERT INTO events(organization_id,epoch,actor_id,type,payload,created_at,previous_hash,hash) VALUES (?,?,?,?,?,?,?,?)').run(state.organizationId, this.epoch, actorId, type, JSON.stringify(payload), createdAt, previousHash, hash);
    return { ...data, hash, serverSeq: Number(insert.lastInsertRowid) };
  }
  snapshot(user: User) {
    return this.db.transaction(() => {
      const state = this.read(user.organizationId);
      const evidence = (this.db.prepare('SELECT * FROM evidence WHERE organization_id=?').all(user.organizationId) as any[]).map(row => { const complete = this.evidenceComplete(user.organizationId, row.hash); return { id: row.hash, hash: row.hash, sha256: row.hash, name: row.name, filename: row.name, mediaType: row.media_type, mimeType: row.media_type, size: row.size, complete, status: complete ? 'complete' : existsSync(join(this.evidenceDir, row.hash)) ? 'corrupt' : 'missing' }; });
      for (const id of new Set([...state.observations, ...state.verifications].flatMap(o => o.evidenceIds ?? []))) if (!evidence.some(e => e.id === id)) evidence.push({ id, hash: id, sha256: id, name: 'Oczekujący załącznik', filename: 'Oczekujący załącznik', mediaType: 'application/octet-stream', mimeType: 'application/octet-stream', size: 0, complete: false, status: 'pending' });
      const verifications = state.verifications.map(v => ({ ...v, current: v.outcome === 'passed' && !v.invalidatedAt && Date.parse(v.validUntil) > Date.now() && v.evidenceIds.every((id: string) => evidence.some(e => e.id === id && e.complete)) }));
      const readinessTrials = (state.readinessTrials ?? []).map((trial:any)=>({...trial,current:verifications.some(v=>v.id===trial.verificationId&&v.current),verificationValidUntil:verifications.find(v=>v.id===trial.verificationId)?.validUntil}));
      const executionClock={mode:state.model.synthetic?'accelerated_synthetic_exercises':'wall_clock',acceleratedOnlyForSyntheticExercises:true,description:state.model.synthetic?'Ćwiczenia na danych syntetycznych używają przyspieszonego zegara. Czas kliknięć nie jest pomiarem czasu instalacji. Incydenty rzeczywiste egzekwują czas harmonogramu.':'Wykonanie egzekwuje rzeczywisty czas harmonogramu i czas przygotowania.'};
      return { ...state, incident: state.incidents.find(i => i.status === 'open') ?? state.incidents[0] ?? null, verifications, readinessTrials, readinessIssues:modelProvenanceIssues(state.model), modelValidation:validateModel(state.model), localAllocations:state.localAllocations??[], executionClock, evidence, users: this.users(user.organizationId), serverEpoch: this.epoch, serverSeq: this.sequence, serverTime: now() };
    })();
  }
  putEvidence(org: string, name: string, mediaType: string, data: Buffer) {
    const hash = sha256(data); const path = join(this.evidenceDir, hash);
    if (!existsSync(path)) writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
    if (sha256(readFileSync(path))!==hash) throw new Error('Evidence storage integrity failure; the existing immutable object is corrupt.');
    this.db.prepare('INSERT OR IGNORE INTO evidence(hash,organization_id,name,media_type,size,created_at) VALUES (?,?,?,?,?,?)').run(hash, org, name, mediaType, data.length, now());
    return { id: hash, hash, name, mediaType, size: data.length, complete: true };
  }
  evidenceComplete(org: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    const row = this.db.prepare('SELECT hash FROM evidence WHERE organization_id=? AND hash=?').get(org, id);
    const file = join(this.evidenceDir, id);
    return Boolean(row && existsSync(file) && sha256(readFileSync(file)) === id);
  }
  restoreEpoch(isolated = true) {
    this.db.transaction(() => {
      this.setMeta('serverEpoch', randomUUID()); this.db.prepare('DELETE FROM sessions').run();
      const rows = this.db.prepare('SELECT id FROM organizations').all() as any[];
      for (const row of rows) {
        const state = this.read(row.id); state.revision++;
        state.recovery = { isolated, accountsReviewed: false, resourcesReconciled: false };
        for (const resource of state.model.resources ?? []) { resource.reconciliationRequired = true; }
        for (const plan of state.plans) plan.approvalStatus = 'needs_review';
        for (const action of state.actions) { action.needsReview = true; action.reviewReason = 'Nowa epoka wymaga potwierdzenia warunków fizycznych.'; delete action.conditionsValidatedAt; }
        for (const result of state.verifications) if (!result.invalidatedAt) { result.invalidatedAt = now(); result.invalidationReason = 'Nowa epoka serwera wymaga ponownego testu rezultatu.'; }
        for (const scope of state.allocationScopes) if (!scope.revokedAt) scope.reconciliationRequired = true;
        state.model.allocationScopes = state.allocationScopes.filter(scope=>!scope.revokedAt);
        this.save(state); this.event(state, 'system', 'server.restored', { isolated, accountsReviewRequired: true });
      }
    })();
  }
  async backup(targetDir: string) {
    const target = resolve(targetDir); mkdirSync(target, { recursive: true });
    const dbPath = join(target, 'most.sqlite');
    if (existsSync(dbPath)) throw new Error('Backup target already contains a database');
    await this.db.backup(dbPath);
    const snapshot = new Database(dbPath, { readonly: true });
    try {
      const referenced = snapshot.prepare('SELECT DISTINCT hash,size FROM evidence').all() as any[];
      const states = (snapshot.prepare('SELECT state FROM organizations').all() as any[]).map(row => JSON.parse(row.state));
      for (const state of states) for (const id of new Set([...state.observations, ...state.verifications].flatMap(o => o.evidenceIds ?? []))) if (!referenced.some(row => row.hash === id)) throw new Error(`Incomplete backup: missing evidence metadata ${id}`);
      const files: { path: string; sha256: string; size: number }[] = [];
      mkdirSync(join(target, 'evidence'), { recursive: true });
      for (const row of referenced) {
        if (!/^[a-f0-9]{64}$/.test(row.hash)) throw new Error('Invalid evidence identifier in backup');
        const source = join(this.evidenceDir, row.hash);
        if (!existsSync(source)) throw new Error(`Incomplete backup: missing evidence ${row.hash}`);
        const data = readFileSync(source);
        if (sha256(data) !== row.hash || data.length !== row.size) throw new Error(`Incomplete backup: corrupt evidence ${row.hash}`);
        copyFileSync(source, join(target, 'evidence', row.hash));
        files.push({ path: `evidence/${row.hash}`, sha256: row.hash, size: data.length });
      }
      const dbBytes = readFileSync(dbPath); files.unshift({ path: 'most.sqlite', sha256: sha256(dbBytes), size: dbBytes.length });
      const epoch = (snapshot.prepare('SELECT value FROM metadata WHERE key=?').get('serverEpoch') as any)?.value;
      const seq = (snapshot.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as any).seq;
      const manifest = { schemaVersion: 1, createdAt: now(), serverEpoch: epoch, serverSeq: seq, complete: true, files };
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
      return manifest;
    } finally { snapshot.close(); }
  }
  close() { this.db.close(); }
}
export const createStore = (dataDir: string) => new Store(dataDir);
export const openStore = createStore;
