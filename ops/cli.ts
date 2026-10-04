import { mkdir, readFile, writeFile, cp, access } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { Store } from '../apps/api/src/store.ts';
import { createDemoModel } from '../packages/scenarios/src/index.ts';
import { solvePlan, validatePlan } from '../packages/engine/src/index.ts';
import { verifyRelease } from './verify-release.ts';
import { verifySignedBundle } from './bundle.ts';

const [command, argument] = process.argv.slice(2);
const dataDir=resolve(process.env.DATA_DIR || 'data');
async function verifyBackup(directory: string) {
  const root=resolve(directory); const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1||manifest.complete!==true||!Array.isArray(manifest.files)) throw new Error('Niekompletny manifest kopii.');
  const names=new Set<string>();
  for(const f of manifest.files) {
    const path=resolve(root,f.path); const rel=relative(root,path);
    if(!rel||rel.startsWith('..')||isAbsolute(rel)||names.has(f.path)) throw new Error('Nieprawidłowa ścieżka lub duplikat w kopii.');
    names.add(f.path);
    const bytes=await readFile(path);
    if(bytes.length!==f.size || createHash('sha256').update(bytes).digest('hex')!==f.sha256) throw new Error(`Naruszona integralność: ${f.path}`);
  }
  if(!names.has('most.sqlite')) throw new Error('Brak bazy w manifeście.');
  return manifest;
}
async function restoreTest(directory:string) {
  const started=Date.now(); const manifest=await verifyBackup(directory);
  const target=resolve('artifacts/private',`restore-${randomUUID()}`); await mkdir(target,{recursive:true});
  for(const f of manifest.files) { const path=resolve(target,f.path); await mkdir(resolve(path,'..'),{recursive:true}); await cp(resolve(directory,f.path),path,{errorOnExist:true,force:false}); }
  const store=new Store(target); const checks: {name:string;passed:boolean;detail?:unknown}[]=[];
  try {
    checks.push({name:'SQLite integrity_check',passed:store.db.pragma('integrity_check',{simple:true})==='ok'});
    checks.push({name:'Relacje kluczy obcych',passed:(store.db.pragma('foreign_key_check') as unknown[]).length===0});
    const evidence=store.db.prepare('SELECT hash,organization_id FROM evidence').all() as any[];
    checks.push({name:'Kompletność wszystkich dowodów wskazanych przez bazę',passed:evidence.every(e=>store.evidenceComplete(e.organization_id,e.hash))});
    const beforeEpoch=store.epoch; store.restoreEpoch(true);
    checks.push({name:'Nowa epoka i wyczyszczone sesje',passed:store.epoch!==beforeEpoch&&(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n===0});
    const organizations=store.db.prepare('SELECT id FROM organizations').all() as any[];
    checks.push({name:'Organizacja istnieje',passed:organizations.length>0});
    const sourcePath=process.argv[4];const source=sourcePath?JSON.parse(await readFile(resolve(sourcePath),'utf8')):null;let dataLoss:unknown=null;
    for(const org of organizations) {
      const state=store.read(org.id);
      if(source?.organizationId===org.id&&source.serverEpoch===manifest.serverEpoch){const missing=source.observationIds.filter((id:string)=>!state.observations.some((o:any)=>o.id===id));dataLoss={sourceAt:source.at,sourceServerSeq:source.serverSeq,backupServerSeq:manifest.serverSeq,eventGap:source.serverSeq-manifest.serverSeq,missingObservationIds:missing,missingObservations:missing.length,scope:'Pomiar wobec wskazanego aktualnego źródła. Nie obejmuje niewysłanych danych urządzeń.'};}
      checks.push({name:`Izolacja, przegląd kont i zasobów: ${org.id}`,passed:state.recovery.isolated&&!state.recovery.accountsReviewed&&!state.recovery.resourcesReconciled&&(state.model.resources??[]).every((r:any)=>r.reconciliationRequired===true)});
      checks.push({name:'Odczyt incydentu',passed:(state.incidents??[]).length>0});
      checks.push({name:'Odczyt zatwierdzonej procedury',passed:state.model.procedures.some((p:any)=>p.approved&&p.steps.length>0)});
      // A calculation in the isolated copy is a proposal. Quarantine stays intact.
      const plan=await solvePlan(state.model,{budgetMs:5000});
      checks.push({name:'Przeliczenie i niezależna walidacja planu',passed:['optimal','feasible'].includes(plan.status)&&validatePlan(state.model,plan).valid,detail:{status:plan.status,serviceMinutes:plan.metrics.minimumServiceMinutes}});
      const marker=randomUUID();
      store.db.transaction(()=>{const current=store.read(org.id);const timestamp=new Date().toISOString();current.observations.push({id:marker,incidentId:current.incidents[0]?.id,subjectId:current.model.resources[0]?.id,authorId:'isolated-restore-test',original:'Syntetyczny meldunek próby odtworzenia',source:'restore-test',observedAt:timestamp,receivedAt:timestamp,kind:'observation',verificationStatus:'unverified',evidenceIds:[]});store.save(current);store.event(current,'restore-test','restore.test.observation',{id:marker});})();
      checks.push({name:'Zapis i ponowny odczyt testowego meldunku',passed:store.read(org.id).observations.some((o:any)=>o.id===marker)});
    }
    const result={passed:checks.every(c=>c.passed),startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),elapsedMs:Date.now()-started,backupCreatedAt:manifest.createdAt,backupServerSeq:manifest.serverSeq,newEpoch:store.epoch,isolatedDirectory:target,dataLoss,checks,limits:'Próba nie promuje instancji. Czas obejmuje odtworzenie techniczne, nie fizyczny przegląd ani wznowienie usługi. Utrata danych jest mierzona wyłącznie po dostarczeniu aktualnej metryki źródła.'};
    await mkdir('artifacts',{recursive:true}); await writeFile('artifacts/restore-test.json',JSON.stringify(result,null,2));
    return result;
  } finally {store.close();}
}
try {
  if(command==='preflight') {
    const checks:any={node:process.version,nodeSupported:process.versions.node.startsWith('24.'),aiProvider:process.env.AI_PROVIDER??'none',signingKeyConfigured:Boolean(process.env.MOST_SIGNING_PRIVATE_KEY)};
    try { checks.signingKeyValid=createPublicKey(process.env.MOST_SIGNING_PRIVATE_KEY||'').asymmetricKeyType==='ed25519'; } catch { checks.signingKeyValid=false; }
    const store=new Store(dataDir); checks.sqlite=store.db.pragma('integrity_check',{simple:true}); checks.schemaVersion=store.meta('schemaVersion'); store.close();
    try {checks.release=await verifyRelease();} catch {checks.release={valid:false,reason:'Wykonaj pnpm build-offline'};}
    console.log(JSON.stringify(checks,null,2)); if(!checks.nodeSupported||!checks.signingKeyValid||checks.sqlite!=='ok'||!checks.release.valid) process.exitCode=1;
  } else if(command==='seed-demo') {
    const output=resolve(argument||'artifacts/scenario-demo.json'); await mkdir(resolve(output,'..'),{recursive:true});
    const model=createDemoModel(); await writeFile(output,JSON.stringify(model,null,2));
    console.log(`Zapisano syntetyczny model: ${output}. Importuj po utworzeniu konta; nowa instalacja demonstracyjna używa tego scenariusza automatycznie.`);
  } else if(command==='backup') {
    const store=new Store(dataDir); try {const target=resolve(argument||`backups/${new Date().toISOString().replaceAll(':','-')}`); await access(target).then(()=>{throw new Error('Katalog kopii już istnieje. Wybierz nową ścieżkę.');},()=>{}); console.log(JSON.stringify(await store.backup(target),null,2));} finally {store.close();}
  } else if(command==='restore-test') {
    if(!argument) throw new Error('Podaj ścieżkę kopii: pnpm restore-test backups/<nazwa>'); const result=await restoreTest(resolve(argument));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
  } else if(command==='verify-bundle') {
    if(!argument) { const result=await verifyRelease(); console.log(JSON.stringify(result,null,2)); if(!result.valid)process.exitCode=1; }
    else { const path=resolve(argument);const raw=JSON.parse(await readFile(path,'utf8'));
      if(raw.files&&raw.complete!==undefined) { const result=await verifyBackup(resolve(path,'..')); console.log(JSON.stringify({valid:true,files:result.files.length})); }
      else { const publicKeyPath=process.argv[4]; if(!publicKeyPath)throw new Error('Podaj wcześniej zaufany klucz publiczny: pnpm verify-bundle pakiet.json trusted-key.pem [katalog-wydania]');console.log(JSON.stringify(verifySignedBundle(raw,await readFile(resolve(publicKeyPath),'utf8'),Date.now(),process.argv[5]),null,2)); }
    }
  } else throw new Error('Polecenia: preflight, seed-demo, backup [nowy-katalog], restore-test <katalog>, verify-bundle [manifest.json]');
} catch(error) {console.error(error instanceof Error?error.message:'Operacja nie powiodła się');process.exitCode=1;}
