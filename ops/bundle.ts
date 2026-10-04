import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export function verifySignedBundle(bundle: any, trustedPublicKey: string, now=Date.now(), applicationRoot?:string) {
  if(bundle?.algorithm!=='Ed25519'||typeof bundle.manifestBytes!=='string'||typeof bundle.signature!=='string'||!Array.isArray(bundle.files)) throw new Error('Niepoprawny format podpisanego pakietu.');
  const publicKey=createPublicKey(trustedPublicKey);
  const publicPem=publicKey.export({type:'spki',format:'pem'}).toString();
  const keyId=createHash('sha256').update(publicPem).digest('hex').slice(0,16);
  const bytes=Buffer.from(bundle.manifestBytes,'base64');
  if(!verify(null,bytes,publicKey,Buffer.from(bundle.signature,'base64'))) throw new Error('Niepoprawny podpis manifestu.');
  const manifest=JSON.parse(bytes.toString('utf8'));
  if(manifest.keyId!==keyId) throw new Error('Pakiet nie pochodzi od zaufanego klucza.');
  if(!Number.isFinite(Date.parse(manifest.expiresAt))||Date.parse(manifest.expiresAt)<=now) throw new Error('Pakiet utracił ważność.');
  if(!Number.isFinite(Date.parse(manifest.createdAt))||Date.parse(manifest.createdAt)>now+60000) throw new Error('Niepewny czas pakietu.');
  if(!Array.isArray(manifest.files)||manifest.files.length!==bundle.files.length) throw new Error('Niekompletny wykaz plików.');
  const paths=new Set<string>();
  for(const entry of manifest.files) {
    if(!/^(snapshot\.json|evidence\/[a-f0-9]{64})$/.test(entry.path)||paths.has(entry.path)) throw new Error('Niedozwolona ścieżka lub duplikat.');
    paths.add(entry.path);
    const files=bundle.files.filter((f:any)=>f.path===entry.path);
    if(files.length!==1||files[0].encoding!=='base64') throw new Error(`Brak lub duplikat pliku ${entry.path}.`);
    const contents=Buffer.from(files[0].content,'base64');
    if(contents.length!==entry.size||createHash('sha256').update(contents).digest('hex')!==entry.sha256) throw new Error(`Naruszona integralność ${entry.path}.`);
  }
  if(!paths.has('snapshot.json'))throw new Error('Brak snapshotu.');
  const snapshot=JSON.parse(Buffer.from(bundle.files.find((f:any)=>f.path==='snapshot.json').content,'base64').toString());
  if(snapshot.organizationId!==manifest.organizationId||snapshot.serverEpoch!==manifest.serverEpoch||snapshot.serverSeq!==manifest.serverSeq)throw new Error('Snapshot nie zgadza się z zakresem manifestu.');
  let applicationVerified=false;
  if(applicationRoot){
    const app=manifest.application;
    if(!app?.complete||!Array.isArray(app.files)||!app.files.some((f:any)=>f.path==='/index.html')||!app.files.some((f:any)=>f.path==='/highs.wasm')||!app.files.some((f:any)=>f.path==='/sw.js'))throw new Error('Pakiet nie obejmuje kompletnego wydania aplikacji offline.');
    const root=resolve(applicationRoot),seen=new Set<string>();
    for(const file of app.files){
      if(typeof file.path!=='string'||!file.path.startsWith('/')||file.path.includes('\\')||file.path.includes('?')||file.path.includes('#')||file.path.split('/').includes('..')||seen.has(file.path))throw new Error('Nieprawidłowa ścieżka aplikacji.');
      seen.add(file.path);const full=resolve(root,'.'+file.path),rel=relative(root,full);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Plik poza wydaniem aplikacji.');
      const content=readFileSync(full);if(content.length!==file.size||createHash('sha256').update(content).digest('hex')!==file.sha256)throw new Error(`Naruszona integralność aplikacji: ${file.path}.`);
    }applicationVerified=true;
  }
  return {valid:true,keyId,organizationId:manifest.organizationId,userId:manifest.userId,expiresAt:manifest.expiresAt,files:manifest.files.length,applicationVerified,scope:applicationVerified?'application-and-data':'embedded-data-only'};
}
