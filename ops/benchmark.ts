import { writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createDemoModel } from '../packages/scenarios/src/index.ts';
import { evaluateDependencies, solvePlan, validatePlan } from '../packages/engine/src/index.ts';
import type { Dependency, DomainModel } from '../packages/contracts/src/index.ts';

const samples: number[] = [];
const graph = createDemoModel();
graph.dependencies = Array.from({length:100}, (_, i): Dependency => ({
  id: `bench-${i}`, name: `Element ${i}`, kind: i < 20 ? 'leaf' : 'and', state: 'available', confidence: 'confirmed',
  inputs: i < 20 ? [] : Array.from({length: i < 80 ? 4 : 3}, (__, j) => `bench-${i-j-1}`),
}));
// 60 * 4 + 20 * 3 = 300 directed edges, all to preceding nodes.
for (let i=0;i<105;i++) { const start=performance.now(); evaluateDependencies(graph); if(i>=5) samples.push(performance.now()-start); }
samples.sort((a,b)=>a-b);
const scaling: any[] = [];
for (const copies of [1,2,4,8]) {
  const original=createDemoModel(); const model=structuredClone(original);
  const fields=['services','modes','resources','dependencies','procedures','verificationContracts','uncertainties'] as const;
  for (const field of fields) (model[field] as any[]) = [];
  for(let copy=0;copy<copies;copy++) {
    const ids=new Set(fields.flatMap(field => original[field].map((item: any)=>item.id)));
    const clone=JSON.parse(JSON.stringify(original), (_,value) => typeof value==='string'&&ids.has(value)?`${value}__${copy}`:value) as DomainModel;
    for(const field of fields) (model[field] as any[]).push(...clone[field]);
  }
  const start=performance.now(); const plan=await solvePlan(model,{budgetMs:5000});
  scaling.push({services:model.services.length,modes:model.modes.length,resources:model.resources.length,intervals:model.horizonMinutes/model.stepMinutes,status:plan.status,valid:validatePlan(model,plan).valid,metrics:plan.metrics,timings:plan.solver.timings,wallMs:performance.now()-start});
}
const report={at:new Date().toISOString(),hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),platform:platform(),release:release(),node:process.version},availability:{nodes:100,edges:300,repetitions:samples.length,warmup:5,p50Ms:samples[49],p95Ms:samples[94],maxMs:samples[99],targetP95Ms:300,passed:samples[94]<300},scaling,scope:'Pomiary lokalnego komputera. Nie są pomiarem telefonu ani czasu decyzji użytkownika.'};
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/benchmark.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
