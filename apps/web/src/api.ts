import { db, queueRows, saveSnapshot } from './db';
import type { Account, Entity, Snapshot } from './types';
export class ApiError extends Error { constructor(message: string, public status: number, public detail: Entity = {}) { super(message); } }
let csrfToken = '';
export function setCsrf(token: string) { csrfToken = token; }
export interface ApiOptions { timeoutMs?: number; signal?: AbortSignal }
export async function api(path: string, method = 'GET', body?: unknown, options: ApiOptions = {}): Promise<any> {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Limit odpowiedzi musi być dodatnią liczbą milisekund.');
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(path, { method, credentials: 'same-origin', signal: controller.signal, cache: 'no-store', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('json') ? await response.json() : { message: await response.text() };
    if (!response.ok) throw new ApiError(result.message || result.error || `Serwer zwrócił błąd ${response.status}`, response.status, result);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError(`Serwer nie odpowiedział w ciągu ${timeoutMs / 1000} s. Możesz ponowić próbę; lokalne dane i kolejka pozostają na urządzeniu.`, 0, { code: 'REQUEST_TIMEOUT', timeoutMs });
    if (controller.signal.aborted) throw new ApiError('Przerwano oczekiwanie na serwer. Lokalne dane i wybrany plik pozostają zachowane.', 0, { code: 'REQUEST_ABORTED' });
    throw new ApiError('Brak odpowiedzi serwera. Lokalne dane i kolejka pozostają na urządzeniu.', 0);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export async function snapshotWithHistory(scope: string): Promise<Snapshot> {
  const [snapshot,stored] = await Promise.all([api('/api/snapshot') as Promise<Snapshot>,db.snapshots.get(scope)]);
  const previous = stored?.snapshot.serverEpoch===snapshot.serverEpoch ? stored.snapshot : undefined;
  const events: Entity[] = [...(previous?.events||[])]; let cursor = previous?.historyCursor || 0, hasMore = true;
  for(let page=0;hasMore&&page<10;page++) {
    const changes = await api(`/api/changes?serverEpoch=${encodeURIComponent(snapshot.serverEpoch)}&after=${cursor}`);
    events.push(...changes.events); cursor=changes.nextCursor; hasMore=changes.hasMore;
  }
  return {...snapshot,events,historyCursor:cursor,historyIncomplete:hasMore};
}
export async function synchronize(account: Account) {
  const me = await api('/api/auth/me');
  if (me.user.id !== account.user.id || me.user.organizationId !== account.user.organizationId) throw new ApiError('Zalogowano inne konto. Kolejka nie została wysłana.', 401);
  setCsrf(me.csrfToken);
  const snapshot = await snapshotWithHistory(account.scope);
  await saveSnapshot(account.scope, snapshot);
  const rows = await queueRows(account.scope);
  if (account.serverEpoch && snapshot.serverEpoch !== account.serverEpoch) {
    await db.transaction('rw', db.outbox, async () => { for (const row of rows.filter(r => r.status === 'pending' || r.status === 'waiting')) await db.outbox.update(row.commandId, { status: 'conflict', result: { code: 'SERVER_EPOCH_CHANGED', message: 'Serwer odtworzono. Potwierdź stan fizyczny i rozstrzygnij komendę. Nie powtórzono działania.' } }); });
    return { snapshot, epochChanged: true, count: 0, me };
  }
  let count = 0;
  for (const file of (await db.files.where('scope').equals(account.scope).toArray()).filter(f => f.status === 'pending')) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const uploaded = await api('/api/evidence', 'POST', { filename: file.name, mimeType: file.blob.type || 'application/octet-stream', base64: btoa(binary) });
    if (uploaded.id !== file.id && uploaded.hash !== file.sha256 && uploaded.sha256 !== file.sha256) throw new ApiError('Serwer zwrócił inny identyfikator dowodu. Komenda pozostaje lokalnie.', 502);
    await db.files.update([account.scope,file.id], { status: 'complete' });
  }
  for (const row of rows.filter(r => r.status === 'pending' || r.status === 'waiting')) {
    const dependencies = await Promise.all(row.command.dependsOn.map(id => db.outbox.get(id)));
    if (dependencies.some(dep => dep && ['rejected','conflict'].includes(dep.status))) {
      await db.outbox.update(row.commandId,{status:'conflict',result:{code:'PREDECESSOR_NOT_ACCEPTED',message:'Poprzednia komenda nie została przyjęta. Sprawdź skutki i rozstrzygnij także tę zależną czynność.'}});
      continue;
    }
    if (dependencies.some(dep => dep?.status !== 'accepted')) continue;
    const response = await api('/api/commands', 'POST', { commands: [row.command] });
    const result = response.results?.[0];
    if (!result) throw new ApiError('Serwer nie zwrócił wyniku komendy. Zachowano ją do ponowienia.', 502);
    await db.transaction('rw', db.outbox, db.proposals, async () => {
      const accepted = result.status === 'accepted' || result.status === 'duplicate';
      await db.outbox.update(row.commandId, { status: accepted ? 'accepted' : result.status, result });
      if (accepted) await db.proposals.delete(row.commandId);
    });
    count++;
  }
  const fresh = await snapshotWithHistory(account.scope);
  await saveSnapshot(account.scope, fresh);
  return { snapshot: fresh, epochChanged: false, count, me };
}
