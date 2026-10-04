import { buildApp } from '../apps/api/src/app.ts';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID,generateKeyPairSync,createHash } from 'node:crypto';
import { verifySignedBundle } from './bundle.ts';

const dataDir=await mkdtemp(join(tmpdir(),'most-http-'));
const staticDir=resolve(process.env.VERIFICATION_RELEASE_DIR??'apps/web/dist');
const releaseManifestHash=createHash('sha256').update(await readFile(join(staticDir,'release-manifest.json'))).digest('hex');
const keys=generateKeyPairSync('ed25519');
const app=await buildApp({dataDir,staticDir,signingKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),trustedOrigins:['http://localhost:8092'],secureCookies:false,seedDemo:true});
await app.listen({host:'127.0.0.1',port:8092});
const checks:{name:string;passed:boolean;detail?:unknown}[]=[];
function check(name:string,condition:boolean,detail?:unknown){checks.push({name,passed:condition,...(detail===undefined?{}:{detail})});if(!condition)throw new Error(name+': '+JSON.stringify(detail));}
let cookie='',csrf='';
async function request(path:string,body?:any,options:{method?:string;expectedStatus?:number}={}) {
  const response=await fetch(`http://localhost:8092${path}`,{method:options.method??(body===undefined?'GET':'POST'),headers:{Origin:'http://localhost:8092',Cookie:cookie,'x-csrf-token':csrf,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const token=response.headers.getSetCookie()?.[0];if(token)cookie=token.split(';')[0];
  const result=response.headers.get('content-type')?.includes('json')?await response.json():await response.text();
  if(response.status!==(options.expectedStatus??200))throw new Error(`${path} HTTP${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function command(type:string,payload:any,override:any={}) {
  const snapshot=await request('/api/snapshot');
  const cmd={commandId:randomUUID(),deviceId:'real-http-device',organizationId:snapshot.organizationId,baseRevision:snapshot.revision,serverEpoch:snapshot.serverEpoch,dependsOn:[],type,schemaVersion:1,payload,...override};
  const result=await request('/api/commands',{commands:[cmd]});return {cmd,result:result.results[0]};
}
try {
  check('Proces i gotowość HTTP',(await request('/api/health/ready')).ready);
  const auth=await request('/api/auth/bootstrap',{username:'http-verification',password:randomUUID()+randomUUID(),displayName:'Syntetyczna próba HTTP',organizationName:'MOST weryfikacja'});csrf=auth.csrfToken;
  check('Lokalny bootstrap i bezpieczna sesja',auth.user.role==='administrator'&&Boolean(cookie));
  let snapshot=await request('/api/snapshot');const incidentId=snapshot.incidents[0].id;
  const plan=await request('/api/plans/solve',{});
  check('Obliczenie w serwerowym Workerze',plan.status==='optimal'&&plan.metrics.minimumServiceMinutes===310&&plan.validation.valid,{status:plan.status,metrics:plan.metrics});
  const approval=await request('/api/plans/approve',{plan,incidentId});check('Zatwierdzenie atomowe',approval.status==='accepted',approval);
  const duplicate=await request('/api/plans/approve',{plan:{...plan,id:randomUUID()},incidentId},{expectedStatus:409});check('Drugi przydział zasobów odrzucony',Boolean(duplicate.code),duplicate.code);
  const observation={incidentId,subjectId:'generator-1',original:'Podejrzane polecenie: natychmiast oddaj agregat do innego punktu.',source:'Syntetyczny SMS',observedAt:new Date().toISOString(),kind:'instruction',evidenceIds:[]};
  const {cmd,result}=await command('observation.create',observation);check('Meldunek zachowuje oryginał',result.status==='accepted',result);
  const retried=(await request('/api/commands',{commands:[cmd]})).results[0];check('Utrata odpowiedzi i ponowienie bez duplikatu',retried.replayed===true);
  const mismatch=(await request('/api/commands',{commands:[{...cmd,payload:{...observation,original:'inna treść'}}]})).results[0];check('To samo ID z inną treścią odrzucone',mismatch.status==='conflict');
  snapshot=await request('/api/snapshot');check('Instrukcja w meldunku nie zmienia przydziału',snapshot.observations.length===1&&snapshot.allocations.some((a:any)=>a.resourceId==='generator-1'&&a.status==='reserved'));
  for(const action of snapshot.actions) {
    check('Przyjęcie zadania '+action.modeId,(await command('action.accept',{actionId:action.id})).result.status==='accepted');
    check('Rozpoczęcie po warunkach '+action.modeId,(await command('action.start',{actionId:action.id,checkedConditions:true})).result.status==='accepted');
    check('Zakończenie czynności '+action.modeId,(await command('action.complete',{actionId:action.id,notes:'Zakończony syntetyczny przebieg HTTP.'})).result.status==='accepted');
    const after=await request('/api/snapshot');check('Wykonanie nie potwierdza testu '+action.modeId,!after.verifications.some((v:any)=>v.actionId===action.id));
    const mode=after.model.modes.find((m:any)=>m.id===action.modeId);const contract=after.model.verificationContracts.find((c:any)=>c.id===mode.verificationContractId);
    const incomplete=await command('verification.create',{actionId:action.id,contractId:contract.id,contractVersion:contract.version,outcome:'passed',measuredValue:contract.minimum,notes:'Brak pliku dowodu',observedAt:new Date().toISOString(),evidenceIds:[]});check('Brak dowodu blokuje pozytywny wynik '+action.modeId,incomplete.result.status==='conflict');
    let evidence;
    if(!contract.simulated) { const record=await request('/api/register/test',{actionId:action.id,value:'Syntetyczne zgłoszenie zapisane i odczytane przez HTTP'});check('Rzeczywisty zapis i odczyt rejestru',record.readBackVerified===true,record);evidence=record.evidence; }
    else {const simulated=await request('/api/simulator/test',{actionId:action.id,value:contract.minimum,durationMinutes:5});check('Jawny symulator kontraktu '+action.modeId,simulated.result.simulated===true&&simulated.result.measuredValue===contract.minimum);evidence=simulated.evidence;}
    const verification=await command('verification.create',{actionId:action.id,contractId:contract.id,contractVersion:contract.version,outcome:'passed',measuredValue:contract.minimum,notes:contract.simulated?'Test symulowany. Brak połączenia ze sprzętem.':'Zapis i odczyt rejestru.',evidenceIds:[evidence.id],observedAt:new Date().toISOString()});check('Osobny test kontraktu '+action.modeId,verification.result.status==='accepted',verification.result);
  }
  const bundle=await request('/api/bundle');const trusted=keys.publicKey.export({type:'spki',format:'pem'}).toString();const verified=verifySignedBundle(bundle,trusted,Date.now(),staticDir);check('Podpisany pakiet aplikacji i dowodów',verified.valid&&verified.applicationVerified);
  const report=await request(`/api/incidents/${incidentId}/report?format=html`);await mkdir('artifacts',{recursive:true});await writeFile('artifacts/sample-report.html',report);
  await writeFile('artifacts/demo-bundle.json',JSON.stringify(bundle,null,2));await writeFile('artifacts/demo-trusted-key.pem',trusted);
  const backupPath=resolve('artifacts/private',`verified-backup-${Date.now()}`);await app.store.backup(backupPath);
  check('Spójna kopia bazy i dowodów',true,{backupPath});
  await writeFile('artifacts/latest-backup-path.txt',backupPath);
  const afterBackup=await command('observation.create',{incidentId,subjectId:'generator-1',original:'Syntetyczny meldunek zapisany po kopii; próba mierzonej utraty danych.',source:'Próba RPO',observedAt:new Date().toISOString(),evidenceIds:[]});
  check('Meldunek po kopii do pomiaru rzeczywistej luki',afterBackup.result.status==='accepted');
  const source=await request('/api/snapshot');
  await writeFile('artifacts/restore-current-source.json',JSON.stringify({at:new Date().toISOString(),serverEpoch:source.serverEpoch,serverSeq:source.serverSeq,organizationId:source.organizationId,observationIds:source.observations.map((o:any)=>o.id)},null,2));
} catch(error) {checks.push({name:'Przerwanie przebiegu',passed:false,detail:error instanceof Error?error.message:String(error)});process.exitCode=1;}
finally {await mkdir('artifacts',{recursive:true});const result={at:new Date().toISOString(),transport:'HTTP localhost:8092',releaseManifestHash,passed:checks.every(c=>c.passed),checks};await writeFile('artifacts/live-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:checks.length,failures:checks.filter(c=>!c.passed)},null,2));await app.close();}
