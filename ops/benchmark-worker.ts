/** Measures the production API Worker boundary, including its independent deadline. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { createDemoModel } from '../packages/scenarios/src/index.ts';
import { validatePlan } from '../packages/engine/src/index.ts';
import { runSolver } from '../apps/api/src/solver.ts';
import type { DomainModel, Plan } from '../packages/contracts/src/index.ts';

const budgetMs=5000,scaling:unknown[]=[];
const releaseManifestHash=await readFile('apps/web/dist/release-manifest.json').then(bytes=>createHash('sha256').update(bytes).digest('hex')).catch(()=>null);
const sourceFiles=['packages/contracts/src/index.ts','packages/scenarios/src/index.ts',...['dependencies','fragments','model','solver','uncertainty','validator'].map(name=>`packages/engine/src/${name}.ts`),'apps/api/src/solver.ts','apps/api/src/solver-worker.ts','apps/api/src/worker-bootstrap.mjs'],sourceDigest=createHash('sha256');for(const file of sourceFiles)sourceDigest.update(file).update(await readFile(file));const implementationSourceHash=sourceDigest.digest('hex');
for(const copies of [1,2,4,8]){
  const original=createDemoModel(),model=structuredClone(original);
  const fields=['services','modes','resources','dependencies','procedures','verificationContracts','uncertainties'] as const;
  const ids=new Set(fields.flatMap(field=>original[field].map(item=>item.id)));
  for(const field of fields)(model[field] as unknown[])=[];
  for(let copy=0;copy<copies;copy++){
    const clone=JSON.parse(JSON.stringify(original),(_,value)=>typeof value==='string'&&ids.has(value)?`${value}__${copy}`:value) as DomainModel;
    for(const field of fields)(model[field] as unknown[]).push(...clone[field]);
  }
  const started=performance.now();
  try{
    const plan:Plan=structuredClone(await runSolver(model,{budgetMs}));
    const wallMs=performance.now()-started,validation=validatePlan(model,plan);
    const observedSolveMs=plan.solver.timings.watchdogElapsedMs??plan.solver.timings.solveMs;
    const row={services:model.services.length,modes:model.modes.length,resources:model.resources.length,intervals:model.horizonMinutes/model.stepMinutes,requestedBudgetMs:budgetMs,status:plan.status,interruption:plan.solver.interruption??null,valid:validation.valid,validationIssues:validation.issues,metrics:plan.metrics,timings:plan.solver.timings,observedSolveMs,observedOverrunMs:Math.max(0,observedSolveMs-budgetMs),wallMs};
    scaling.push(row);console.log(JSON.stringify(row));
  }catch(error){const row={services:model.services.length,requestedBudgetMs:budgetMs,error:error instanceof Error?error.message:String(error),wallMs:performance.now()-started};scaling.push(row);console.error(JSON.stringify(row));process.exitCode=1;}
}
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/benchmark-worker.json',JSON.stringify({at:new Date().toISOString(),releaseManifestHash,implementationSourceHash,sourceFiles,hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),platform:platform(),release:release(),node:process.version},implementation:'Production API runSolver with a separate Node Worker watchdog. Initialization and LP build precede the shared solver deadline.',requestedBudgetMs:budgetMs,scaling,scope:'Local desktop measurement, not physical phone performance or human decision time. Raw native-solver measurement in benchmark.json remains historical pre-watchdog evidence. Observed overruns are reported explicitly; operating system and event-loop scheduling prevent a hard real-time guarantee.'},null,2));
