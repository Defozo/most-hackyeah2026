/** Technical comparison, never a claim about human decision time or a user study. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDemoModel } from '../packages/scenarios/src/index.ts';
import { solvePlan, validatePlan, validateAllocationScope, computeTimeline, computeMetrics } from '../packages/engine/src/index.ts';
import type { Plan } from '../packages/contracts/src/index.ts';

const releaseManifestHash=await readFile('apps/web/dist/release-manifest.json').then(bytes=>createHash('sha256').update(bytes).digest('hex')).catch(()=>null);
const sourceFiles=['packages/contracts/src/index.ts','packages/scenarios/src/index.ts',...['dependencies','fragments','model','solver','uncertainty','validator'].map(name=>`packages/engine/src/${name}.ts`)],sourceDigest=createHash('sha256');for(const file of sourceFiles)sourceDigest.update(file).update(await readFile(file));const implementationSourceHash=sourceDigest.digest('hex');
const initial=createDemoModel(),scope=initial.allocationScopes[0],baseline=await solvePlan(initial);
const withoutDaniel=structuredClone(initial);withoutDaniel.resources.find(r=>r.id==='person-4')!.state='unavailable';
const plannedShortage=await solvePlan(withoutDaniel);
const precomputationPassed=baseline.validation.valid&&plannedShortage.validation.valid&&baseline.metrics.minimumServiceMinutes===310&&plannedShortage.metrics.minimumServiceMinutes===220;
const fallback:Plan={...structuredClone(baseline),id:'precomputed-unavailable-fallback',actions:[],status:'feasible',diagnostics:['Jawny pusty plan: brak utrzymanych usług.'],solver:{...baseline.solver,stages:[],completeHierarchy:false}};
fallback.timeline=computeTimeline(initial,fallback);fallback.metrics=computeMetrics(initial,[],fallback.timeline);fallback.validation=validatePlan(initial,fallback);
const saved=[{name:'Cztery osoby',plan:baseline},{name:'Brak Daniela',plan:plannedShortage},{name:'Jawny wariant braku działań',plan:fallback}];
const cases=[];
for(const lostPerson of ['person-1','person-2']){
  const model=structuredClone(initial);model.resources.find(r=>r.id===lostPerson)!.state='unavailable';
  const repetitions=[];
  for(let iteration=0;iteration<5;iteration++){
    const selectionStart=performance.now();
    const existing=saved.map(candidate=>({...candidate,validation:validatePlan(model,candidate.plan),scopeValidation:validateAllocationScope(model,candidate.plan,scope,'coordinator',model.referenceTime)}));
    const valid=existing.filter(p=>p.validation.valid&&p.scopeValidation.valid).sort((a,b)=>{for(const priority of [1,2]){const difference=a.plan.metrics.byPriority[priority]-b.plan.metrics.byPriority[priority];if(Math.abs(difference)>1e-6)return difference;}return a.plan.metrics.normalizedShortfall-b.plan.metrics.normalizedShortfall;});
    const storedSelectionMs=performance.now()-selectionStart,solveStart=performance.now(),fresh=await solvePlan(model),freshElapsedMs=performance.now()-solveStart;
    const freshScopeValidation=validateAllocationScope(model,fresh,scope,'coordinator',model.referenceTime),freshValidation=validatePlan(model,fresh);
    const passed=fresh.validation.valid&&['optimal','feasible'].includes(fresh.status)&&freshValidation.valid&&freshScopeValidation.valid&&fresh.metrics.minimumServiceMinutes===205&&valid[0]?.plan.metrics.minimumServiceMinutes===0;
    repetitions.push({iteration,passed,storedSelectionMs,freshElapsedMs,storedCandidates:existing.map(p=>({name:p.name,minimumServiceMinutes:p.plan.metrics.minimumServiceMinutes,valid:p.validation.valid&&p.scopeValidation.valid,rejectionCodes:[...new Set([...p.validation.issues,...p.scopeValidation.issues].map(i=>i.code))]})),selectedStored:valid[0]?{name:valid[0].name,minimumServiceMinutes:valid[0].plan.metrics.minimumServiceMinutes}:null,fresh:{status:fresh.status,requestedBudgetMs:fresh.solver.budgetMs,minimumServiceMinutes:fresh.metrics.minimumServiceMinutes,byPriority:fresh.metrics.byPriority,serviceIds:fresh.actions.map(a=>a.serviceId),timings:fresh.solver.timings,validation:freshValidation,scopeValidation:freshScopeValidation},additionalMinimumServiceMinutes:valid[0]?fresh.metrics.minimumServiceMinutes-valid[0].plan.metrics.minimumServiceMinutes:null});
  }
  cases.push({lostPerson,resourcePool:scope.resourceIds,allowedModes:scope.modeIds,authorizedUser:scope.authorizedUserId,modelRevision:model.revision,repetitions});
}
await mkdir('artifacts',{recursive:true});
const passed=precomputationPassed&&cases.every(row=>row.repetitions.every(attempt=>attempt.passed));
const result={at:new Date().toISOString(),releaseManifestHash,implementationSourceHash,sourceFiles,kind:'technical-comparison',humanParticipants:0,measuresHumanDecisionTime:false,passed,precomputation:{passed:precomputationPassed,plans:[baseline,plannedShortage].map(plan=>({id:plan.id,status:plan.status,requestedBudgetMs:plan.solver.budgetMs,metrics:plan.metrics,timings:plan.solver.timings,validation:plan.validation}))},scope:'Obie ścieżki używają tej samej zmienionej obsady, puli, horyzontu i lokalnego upoważnienia. Każdy zapisany oraz nowy plan przechodzi ten sam niezależny walidator.',limits:['Zestaw zapisanych wariantów jest jawnie ograniczony do normalnej obsady, planowanej nieobecności Daniela i braku działań.','Większy wcześniej obliczony zestaw może zawierać równie dobry wariant. Wynik mierzy korzyść przeliczenia poza tym zestawem.','Czas technicznego wyboru wariantu nie jest czasem zadania użytkownika.','Bezpośredni silnik otrzymuje budżet 5 s; rzeczywisty limit Workera i jego narzut mierzy osobny benchmark-worker.json.','Wszystkie zaplanowane próby są zachowane, także gdy nie spełnią oczekiwania.','Syntetyczny model nie potwierdza wykonalności w terenie.'],cases};
await writeFile('artifacts/offline-plan-comparison.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({passed,cases:cases.length,repetitionsPerCase:5,additionalMinimumServiceMinutes:cases.flatMap(row=>row.repetitions.map(attempt=>attempt.additionalMinimumServiceMinutes)),artifact:'artifacts/offline-plan-comparison.json'}));if(!passed)process.exitCode=1;
