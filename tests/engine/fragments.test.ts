import {describe,it,expect} from 'vitest';
import {createDemoModel} from '../../packages/scenarios/src/index.js';
import {evaluateDependencies,solvePlan,validateModel,validatePlan} from '../../packages/engine/src/index.js';
import type {DomainModel,Plan} from '../../packages/contracts/src/index.js';

describe('local invalid fragments never suppress independent services or hard constraints',()=>{
  it.each(['cycle','missing'] as const)('isolates a %s even through an OR with a healthy input',async kind=>{
    const m=createDemoModel(),baseline=await solvePlan(m,{budgetMs:30000}),battery=m.dependencies.find(d=>d.id==='radio-battery')!;
    battery.kind='or';battery.inputs=['fiber',kind==='cycle'?'radio-battery':'missing-input'];
    const check=validateModel(m);expect(check.valid).toBe(true);expect(check.blockedFragments).toEqual(expect.arrayContaining([expect.objectContaining({kind:'mode',id:'coord-radio'})]));expect(evaluateDependencies(m).states['radio-battery']).toBe('unknown');
    const p=await solvePlan(m,{budgetMs:30000});expect(p.status).toBe('optimal');expect(p.metrics.minimumServiceMinutes).toBe(195);expect(p.actions.some(a=>a.modeId==='coord-radio')).toBe(false);expect(p.timeline.find(s=>s.serviceId==='coordination')!.outageMinutes).toBe(120);expect(p.validation.valid).toBe(true);expect(p.validation.blockedFragments?.length).toBeGreaterThan(0);
    expect(validatePlan(m,baseline).issues.map(i=>i.code)).toContain('blocked_mode');
  });
  const localFailures:[string,(m:DomainModel)=>void][]=[
    ['missing procedure',m=>{m.procedures=m.procedures.filter(p=>p.id!==m.modes[0].procedureId);}],
    ['missing contract',m=>{m.verificationContracts=m.verificationContracts.filter(c=>c.id!==m.modes[0].verificationContractId);}],
    ['missing predecessor',m=>{m.modes[0].predecessors=['absent'];}],
    ['cyclic predecessors',m=>{m.modes[0].predecessors=[m.modes[0].id];}],
    ['missing setup parameter',m=>{m.modes[0].setupMinutes=undefined as any;}],
    ['nonfinite mode level',m=>{m.modes[0].level=NaN;}],
    ['malformed approval',m=>{m.modes[0].approved='false' as any;}],
    ['malformed procedure steps',m=>{m.procedures[0].steps=null as any;}],
    ['malformed verifier roles',m=>{m.verificationContracts[0].verifierRoles=null as any;}],
    ['nonfinite contract validity',m=>{m.verificationContracts[0].validityMinutes=NaN;}],
    ['nonfinite contract threshold',m=>{m.verificationContracts[0].minimum=Infinity;}],
  ];
  it.each(localFailures)('excludes a mode with %s and keeps the original invalid data visible',async(_,corrupt)=>{
    const m=createDemoModel();corrupt(m);const validation=validateModel(m);expect(validation.valid).toBe(true);expect(validation.blockedFragments).toEqual(expect.arrayContaining([expect.objectContaining({kind:'mode',id:'help-local'})]));
    const p=await solvePlan(m,{budgetMs:30000});expect(p.validation.valid).toBe(true);expect(p.metrics.minimumServiceMinutes).toBe(205);expect(p.actions.some(a=>a.modeId==='help-local')).toBe(false);expect(p.validation.warnings.some(w=>w.code==='fragment_excluded')).toBe(true);
  });
  it('propagates exclusion to dependent actions while retaining an unaffected replacement resource',async()=>{
    const m=createDemoModel();m.modes[0].predecessors=['missing'];m.modes[1].predecessors=['help-local'];
    expect(validateModel(m).blockedFragments?.filter(f=>f.kind==='mode').map(f=>f.id)).toEqual(expect.arrayContaining(['help-local','coord-radio']));
    const generator=m.resources.find(r=>r.id==='generator-1')!;generator.dependencyId='missing-generator-condition';m.resources.push({...generator,id:'replacement',dependencyId:undefined});
    const p=await solvePlan(m,{budgetMs:30000});expect(p.metrics.minimumServiceMinutes).toBe(90);expect(p.validation.valid).toBe(true);expect(p.actions.flatMap(a=>a.allocations).some(a=>a.resourceId==='generator-1')).toBe(false);
    const forged=structuredClone(p),allocation=forged.actions.flatMap(a=>a.allocations).find(a=>a.resourceId==='replacement')!;allocation.resourceId='generator-1';allocation.unitIds=['generator-1#1'];expect(validatePlan(m,forged).issues.map(i=>i.code)).toContain('blocked_resource');
  });
  it('retains the hard service deadline when its only usable mode is excluded',async()=>{
    const m=createDemoModel();m.modes[1].dependencyId='absent';m.services.find(s=>s.id==='coordination')!.hardDeadlineMinute=10;
    const progress:Plan[]=[];const p=await solvePlan(m,{budgetMs:30000,onProgress:value=>progress.push(value)});expect(p.status).toBe('infeasible');expect(p.validation.valid).toBe(false);expect(progress).toEqual([]);expect(p.timeline.some(s=>s.serviceId==='coordination')).toBe(true);
  });
  it('publishes a checked empty incumbent before work, and never labels it optimal',async()=>{
    const m=createDemoModel(),progress:Plan[]=[];const p=await solvePlan(m,{budgetMs:0,onProgress:value=>progress.push(value)});expect(progress[0].status).toBe('feasible');expect(progress[0].validation.valid).toBe(true);expect(progress[0].actions).toEqual([]);expect(p.status).toBe('feasible');expect(p.solver.completeHierarchy).toBe(false);
  });
});
