import Dexie, { type Table } from 'dexie';
import type { Account, Command, Entity, Outbox, Snapshot, StoredSnapshot } from './types';

class DeviceDatabase extends Dexie {
  snapshots!: Table<StoredSnapshot, string>;
  accounts!: Table<Account, string>;
  outbox!: Table<Outbox, string>;
  proposals!: Table<{ id: string; scope: string; type: string; payload: Entity; createdAt: string }, string>;
  files!: Table<{ id: string; scope: string; blob: Blob; name: string; sha256: string; status: string }, [string,string]>;
  meta!: Table<{ key: string; value: any }, string>;
  constructor() {
    super('most-device-v1');
    this.version(1).stores({ snapshots: 'scope', accounts: 'scope', outbox: 'commandId,scope,status', proposals: 'id,scope,type', files: 'id,scope,status', meta: 'key' });
    this.version(2).stores({ scopedFiles: '[scope+id],scope,status' }).upgrade(async tx => {
      const files = await tx.table('files').toArray();
      if (files.length) await tx.table('scopedFiles').bulkPut(files);
    });
    this.version(3).stores({ files: null });
    this.files = this.table('scopedFiles');
  }
}
export const db = new DeviceDatabase();
export async function deviceId() { let id = (await db.meta.get('deviceId'))?.value; if (!id) { id = crypto.randomUUID(); await db.meta.put({ key: 'deviceId', value: id }); } return id as string; }
export async function saveSnapshot(scope: string, snapshot: Snapshot) {
  await db.transaction('rw', db.snapshots, db.meta, async () => {
    await db.snapshots.put({ scope, snapshot, savedAt: new Date().toISOString() });
    await db.meta.put({ key: `cursor:${scope}`, value: { serverEpoch: snapshot.serverEpoch, serverSeq: snapshot.serverSeq } });
  });
}
export async function enqueue(scope: string, snapshot: Snapshot, type: string, payload: Entity, dependsOn: string[] = []) {
  const now = new Date().toISOString();
  const pending = (await queueRows(scope)).filter(row=>['pending','waiting'].includes(row.status)&&!row.result?.resolvedAt&&row.command.serverEpoch===snapshot.serverEpoch);
  const previous = pending.at(-1)?.commandId;
  const dependencies = [...new Set([...dependsOn,...(previous?[previous]:[])])];
  const command: Command = { commandId: crypto.randomUUID(), deviceId: await deviceId(), organizationId: snapshot.organizationId, baseRevision: snapshot.revision, serverEpoch: snapshot.serverEpoch, dependsOn:dependencies, type, schemaVersion: 1, payload };
  await db.transaction('rw', db.outbox, db.proposals, async () => {
    await db.outbox.add({ commandId: command.commandId, scope, command, status: 'pending', createdAt: now });
    await db.proposals.add({ id: command.commandId, scope, type, payload, createdAt: now });
  });
  return command;
}
export async function savePlan(scope: string, plan: Entity, model: Entity) {
  await db.proposals.put({ id: plan.id, scope, type: 'local.plan', payload: { plan, model }, createdAt: new Date().toISOString() });
}
export async function queueRows(scope: string) { return db.outbox.where('scope').equals(scope).sortBy('createdAt'); }
export async function localPlans(scope: string) {
  return (await db.proposals.where('scope').equals(scope).toArray())
    .filter(p => p.type === 'local.plan')
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export async function exportDevice(scope: string) {
  const [snapshot, outbox, proposals, files] = await Promise.all([db.snapshots.get(scope), queueRows(scope), db.proposals.where('scope').equals(scope).toArray(), db.files.where('scope').equals(scope).toArray()]);
  const attachments = await Promise.all(files.map(async file => ({ id: file.id, name: file.name, sha256: file.sha256, status: file.status, mime: file.blob.type, base64: btoa(Array.from(new Uint8Array(await file.blob.arrayBuffer()), n => String.fromCharCode(n)).join('')) })));
  return { format: 'most-device-export', version: 1, createdAt: new Date().toISOString(), scope, snapshot, outbox, proposals, attachments };
}
export function download(name: string, data: string | Blob, type = 'application/json') { const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export async function fileHash(file: Blob) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join(''); }
