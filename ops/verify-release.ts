import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';

export async function verifyRelease(directory = 'apps/web/dist') {
  const root=resolve(directory);
  const manifest=JSON.parse(await readFile(resolve(root,'release-manifest.json'),'utf8'));
  const failures:string[]=[];
  for(const entry of manifest.files) {
    const path=resolve(root,entry.path); const rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel)) { failures.push(`Nieprawidłowa ścieżka: ${entry.path}`); continue; }
    try { const data=await readFile(path); if(data.length!==entry.size || createHash('sha256').update(data).digest('hex')!==entry.sha256) failures.push(`Zmieniony plik: ${entry.path}`); }
    catch { failures.push(`Brak pliku: ${entry.path}`); }
  }
  return {valid:failures.length===0,files:manifest.files.length,failures,version:manifest.version};
}
