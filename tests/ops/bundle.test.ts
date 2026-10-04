import { describe,it,expect } from 'vitest';
import { generateKeyPairSync,createHash,sign } from 'node:crypto';
import { verifySignedBundle } from '../../ops/bundle.ts';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
function bundle() {
  const data=Buffer.from(JSON.stringify({organizationId:'org',serverEpoch:'epoch',serverSeq:4}));
  const manifest={keyId:createHash('sha256').update(publicKey).digest('hex').slice(0,16),organizationId:'org',userId:'test',serverEpoch:'epoch',serverSeq:4,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),files:[{path:'snapshot.json',sha256:createHash('sha256').update(data).digest('hex'),size:data.length}]};
  const bytes=Buffer.from(JSON.stringify(manifest));
  return {algorithm:'Ed25519',manifest,manifestBytes:bytes.toString('base64'),signature:sign(null,bytes,keys.privateKey).toString('base64'),files:[{path:'snapshot.json',encoding:'base64',content:data.toString('base64')}]};
}
describe('Pakiet sprawdzany względem wcześniej zaufanego klucza',()=>{
  it('akceptuje nienaruszony podpisany snapshot',()=>expect(verifySignedBundle(bundle(),publicKey).valid).toBe(true));
  it('odrzuca podmienioną zawartość pliku',()=>{const b=bundle();b.files[0].content=Buffer.from('zmienione').toString('base64');expect(()=>verifySignedBundle(b,publicKey)).toThrow('integralność');});
  it('odrzuca brak pliku',()=>{const b=bundle();b.files=[];expect(()=>verifySignedBundle(b,publicKey)).toThrow('Niekompletny');});
  it('odrzuca inny klucz',()=>{const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();expect(()=>verifySignedBundle(bundle(),other)).toThrow('podpis');});
  it('odrzuca wygasły pakiet',()=>expect(()=>verifySignedBundle(bundle(),publicKey,Date.now()+120000)).toThrow('ważność'));
  it('nie ufa niepodpisanemu widokowi manifestu',()=>{const b=bundle();b.manifest.organizationId='attacker';expect(verifySignedBundle(b,publicKey).organizationId).toBe('org');});
  it('wykrywa podmianę WASM także przy poprawnym podpisie danych',()=>{
    const root=mkdtempSync(join(tmpdir(),'most-bundle-assets-'));try{
      const b:any=bundle();const names=['index.html','highs.wasm','sw.js'];
      b.manifest.application={complete:true,files:names.map(path=>{const data=Buffer.from(`synthetic ${path}`);writeFileSync(join(root,path),data);return{path:'/'+path,size:data.length,sha256:createHash('sha256').update(data).digest('hex')};})};
      const bytes=Buffer.from(JSON.stringify(b.manifest));b.manifestBytes=bytes.toString('base64');b.signature=sign(null,bytes,keys.privateKey).toString('base64');
      expect(verifySignedBundle(b,publicKey,Date.now(),root).applicationVerified).toBe(true);
      writeFileSync(join(root,'highs.wasm'),'tampered');expect(()=>verifySignedBundle(b,publicKey,Date.now(),root)).toThrow('integralność aplikacji');
    }finally{for(const path of ['index.html','highs.wasm','sw.js'])rmSync(join(root,path),{force:true});rmdirSync(root);}
  });
  it('nie potwierdza całej aplikacji na podstawie samego snapshotu',()=>expect(()=>verifySignedBundle(bundle(),publicKey,Date.now(),'.')).toThrow('kompletnego wydania'));
});
