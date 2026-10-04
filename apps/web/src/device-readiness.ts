import type { Entity } from './types';

export const requiresOfflineCache=(path:string)=>/\.(?:js|css|html|svg|woff2|wasm)$/.test(path)&&path!=='/sw.js'&&!/^\/workbox-/.test(path);

/** Readiness is a current observation, never a permanent property of a device. */
export async function preparedDeviceIssues(prepared:Entity|null,context:{serverEpoch:string;modelRevision:number;offlineUntil:string;now?:number},hasCachedPath:(path:string)=>Promise<boolean>):Promise<string[]>{
  if(!prepared)return [];
  const now=context.now??Date.now(),issues:string[]=[];
  const validDate=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>now;
  if(!prepared.signatureVerified)issues.push('Podpis pakietu nie został potwierdzony. Przygotuj urządzenie ponownie.');
  if(!validDate(prepared.manifest?.expiresAt))issues.push('Podpisany pakiet wygasł lub nie ma poprawnej daty ważności.');
  if(!validDate(context.offlineUntil)||!validDate(prepared.offlineExpiresAt))issues.push('Dostęp offline wygasł. Połącz urządzenie z serwerem i przygotuj je ponownie.');
  if(prepared.serverEpoch!==context.serverEpoch)issues.push('Serwer został odtworzony. Pakiet wymaga ponownego przygotowania i uzgodnienia epoki.');
  if(prepared.modelRevision!==context.modelRevision)issues.push('Model ma nowszą wersję niż sprawdzony pakiet. Przygotuj urządzenie ponownie.');
  const application=prepared.manifest?.application;
  if(!application?.complete||!Array.isArray(application.files)||!application.files.some((file:Entity)=>file.path==='/highs.wasm'))issues.push('Pakiet aplikacji jest niekompletny. Przygotuj pełne wydanie ponownie.');
  else{
    const paths=application.files.map((file:Entity)=>String(file.path)).filter(requiresOfflineCache);
    const missing=(await Promise.all(paths.map(async(path:string)=>await hasCachedPath(path)?null:path))).filter(Boolean);
    if(missing.length)issues.push(`Brak wymaganej kopii offline: ${missing.join(', ')}. Pamięć aplikacji jest niekompletna; przygotuj urządzenie ponownie.`);
  }
  return issues;
}
