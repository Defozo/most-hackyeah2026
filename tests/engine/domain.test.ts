import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createDemoModel, createScenario, domainScenarios } from '../../packages/scenarios/src/index.js';
import { computeMetrics, computeTimeline, evaluateDependencies, minimalCutSets, rankUncertainties as rankWithBudget, solvePlan as solveWithBudget, validateAllocationScope, validateModel, validatePlan } from '../../packages/engine/src/index.js';
import type { Availability, DomainModel, Plan, RankingResult } from '../../packages/contracts/src/index.js';

// Oracle tests prove mathematical correctness, independent of a busy host's five-second deadline.
const solvePlan=(...args:Parameters<typeof solveWithBudget>)=>solveWithBudget(args[0],{budgetMs:30000,...args[1]});
const rankUncertainties=(...args:Parameters<typeof rankWithBudget>)=>rankWithBudget(args[0],{budgetMs:30000,...args[1]});
let coldStartPlan:Plan;
// Cold startup is measured separately from the mathematical oracle corpus. A busy
// host may legitimately exhaust the product's unchanged 5 s limit on its first solve.
beforeAll(async()=>{coldStartPlan=await solveWithBudget(createDemoModel());console.info('MOST cold solver',JSON.stringify({status:coldStartPlan.status,minimumServiceMinutes:coldStartPlan.metrics.minimumServiceMinutes,budgetMs:coldStartPlan.solver.budgetMs,timings:coldStartPlan.solver.timings}));});

it('cold startup preserves the actual five-second budget and only returns a verified incumbent',()=>{
  expect(coldStartPlan.solver.budgetMs).toBe(5000);expect(coldStartPlan.validation.valid).toBe(true);expect(['optimal','feasible']).toContain(coldStartPlan.status);
  if(coldStartPlan.status==='optimal'){expect(coldStartPlan.metrics.minimumServiceMinutes).toBe(310);expect(coldStartPlan.solver.completeHierarchy).toBe(true);}else expect(coldStartPlan.solver.completeHierarchy).toBe(false);
  let spent=0;for(const stage of coldStartPlan.solver.stages){expect(spent).toBeLessThan(5000);spent+=stage.elapsedMs;}
});

describe('versioned independent domain expectations', () => {
  for (const scenario of domainScenarios()) it(`${scenario.id}: ${scenario.title}`, async () => {
    const {model,expected}=scenario;
    if(expected.validModel!==undefined)expect(validateModel(model).valid).toBe(expected.validModel);
    if(expected.dependency){expect(evaluateDependencies(model).states[expected.dependency[0]]).toBe(expected.dependency[1]);return;}
    const plan=await solvePlan(model);
    if(expected.status)expect(plan.status).toBe(expected.status);
    if(expected.minimumMinutes!==undefined){expect(plan.validation.issues).toEqual([]);expect(plan.metrics.minimumServiceMinutes).toBe(expected.minimumMinutes);}
    if(expected.noResourceId)expect(plan.actions.flatMap(a=>a.allocations).some(a=>a.resourceId===expected.noResourceId)).toBe(false);
  });
});

describe('dependency semantics and complete small-graph oracle',()=>{
  it('router and supply are common failure points; both uplinks must fail',()=>{
    const result=minimalCutSets(createDemoModel(),'digital-connection');
    expect(result.complete).toBe(true);expect(result.sets).toEqual([['grid-power'],['router'],['fiber','lte']]);
  });
  it('AND and OR use three-state truth tables',()=>{
    fc.assert(fc.property(fc.constantFrom<Availability>('available','unavailable','unknown'),fc.constantFrom<Availability>('available','unavailable','unknown'),(a,b)=>{
      const m=createDemoModel();m.dependencies=[{id:'a',name:'a',kind:'leaf',inputs:[],state:a,confidence:'confirmed'},{id:'b',name:'b',kind:'leaf',inputs:[],state:b,confidence:'confirmed'},{id:'and',name:'and',kind:'and',inputs:['a','b']},{id:'or',name:'or',kind:'or',inputs:['a','b']}];
      const evaluated=evaluateDependencies(m).states;
      expect(evaluated.and).toBe(a==='unavailable'||b==='unavailable'?'unavailable':a==='available'&&b==='available'?'available':'unknown');
      expect(evaluated.or).toBe(a==='available'||b==='available'?'available':a==='unavailable'&&b==='unavailable'?'unavailable':'unknown');
    }),{numRuns:50});
  });
  it('minimal cut sets agree with all 16 combinations, including shared leaves',()=>{
    fc.assert(fc.property(fc.array(fc.constantFrom<'and'|'or'>('and','or'),{minLength:3,maxLength:3}),kinds=>{
      const m=createDemoModel();m.dependencies=['a','b','c','d'].map(id=>({id,name:id,kind:'leaf',inputs:[],state:'available',confidence:'confirmed'}));
      m.dependencies.push({id:'left',name:'left',kind:kinds[0],inputs:['a','b']},{id:'right',name:'right',kind:kinds[1],inputs:['b','c','d']},{id:'root',name:'root',kind:kinds[2],inputs:['left','right']});
      const brute:string[][]=[];
      for(let mask=1;mask<16;mask++){const failures=['a','b','c','d'].filter((_,i)=>mask&(1<<i));const assumptions=Object.fromEntries(['a','b','c','d'].map(id=>[id,failures.includes(id)?'unavailable':'available'])) as Record<string,Availability>;if(evaluateDependencies(m,0,assumptions).states.root==='unavailable')brute.push(failures);}
      const minimal=brute.filter(s=>!brute.some(o=>o.length<s.length&&o.every(x=>s.includes(x)))).map(s=>s.join(',')).sort();
      expect(minimalCutSets(m,'root').sets.map(s=>s.join(',')).sort()).toEqual(minimal);
    }),{numRuns:30});
  });
  it('a bounded analysis never claims complete enumeration',()=>{expect(minimalCutSets(createDemoModel(),'digital-connection',{limit:2}).complete).toBe(false);});
  it('every partial cut set is still a sufficient failure set',()=>{
    const m=createDemoModel();m.dependencies=[...['a','b','c','d'].map(id=>({id,name:id,kind:'leaf' as const,inputs:[],state:'available' as const,confidence:'confirmed' as const})),{id:'ab',name:'ab',kind:'and',inputs:['a','b']},{id:'cd',name:'cd',kind:'and',inputs:['c','d']},{id:'root',name:'root',kind:'or',inputs:['ab','cd']}];
    for(let limit=1;limit<25;limit++)for(const cut of minimalCutSets(m,'root',{limit}).sets){const assumptions=Object.fromEntries(['a','b','c','d'].map(id=>[id,cut.includes(id)?'unavailable':'available'])) as Record<string,Availability>;expect(evaluateDependencies(m,0,assumptions).states.root).toBe('unavailable');}
  });
  it('battery end is a forecast boundary, not an observed physical failure',()=>{const m=createDemoModel();expect(evaluateDependencies(m,120).states['radio-battery']).toBe('unknown');});
  it('external identifiers never access inherited object properties',()=>{const m=createDemoModel();m.dependencies=[{id:'__proto__',name:'bad-looking but valid ID',kind:'leaf',inputs:[],state:'available',confidence:'confirmed'},{id:'constructor',name:'constructor',kind:'and',inputs:['__proto__']}];expect(evaluateDependencies(m).states.constructor).toBe('available');});
});

describe('independent validation and safety boundaries',()=>{
  const canonicalize=(m:DomainModel,p:Plan)=>{p.timeline=computeTimeline(m,p);p.metrics=computeMetrics(m,p.actions,p.timeline);return p;};
  it('rejects forged metrics and forged timeline',async()=>{const m=createDemoModel(),p=await solvePlan(m);p.timeline[0].intervals[0].meetsMinimum=true;expect(validatePlan(m,p).issues.some(i=>i.code==='timeline_mismatch')).toBe(true);p.metrics.normalizedShortfall=0;expect(validatePlan(m,p).issues.some(i=>i.code==='metrics_mismatch')).toBe(true);});
  it('rejects double assignment even if the timeline is recomputed',async()=>{const m=createDemoModel(),p=await solvePlan(m),a=p.actions.find(a=>a.serviceId==='water')!;a.allocations.find(x=>x.resourceId==='person-4')!.resourceId='person-1';expect(validatePlan(m,canonicalize(m,p)).issues.map(i=>i.code)).toContain('resource_overlap');});
  it('rejects missing equipment, shortened preparation, excess stock and old revisions',async()=>{
    const m=createDemoModel(),p=await solvePlan(m);const water=p.actions.find(a=>a.serviceId==='water')!;water.allocations=water.allocations.filter(a=>a.resourceId!=='generator-1');water.readyMinute=5;p.modelRevision=0;water.allocations.find(a=>a.resourceId==='fuel-1')!.consumedQuantity=100;
    const codes=validatePlan(m,canonicalize(m,p)).issues.map(i=>i.code);expect(codes).toContain('stale_model');expect(codes).toContain('action_time');expect(codes).toContain('staff_or_equipment');expect(codes).toContain('stock_exceeded');
  });
  it('unreconciled restore resources cannot be scheduled',async()=>{const m=createDemoModel();m.resources.forEach(r=>r.reconciliationRequired=true);const p=await solvePlan(m);expect(p.validation.valid).toBe(true);expect(p.actions).toEqual([]);});
  it('local authority checks identity, resources, revision and trusted time',async()=>{const m=createDemoModel(),p=await solvePlan(m),scope=m.allocationScopes[0];expect(validateAllocationScope(m,p,scope,'coordinator',m.referenceTime).valid).toBe(true);expect(validateAllocationScope(m,p,scope,'operator',m.referenceTime).valid).toBe(false);expect(validateAllocationScope(m,p,scope,'coordinator',m.referenceTime,false).valid).toBe(false);scope.resourceIds=[];expect(validateAllocationScope(m,p,scope,'coordinator',m.referenceTime).valid).toBe(false);});
  it('malformed public data is rejected without exceptions',async()=>{for(const broken of [{},null,{...createDemoModel(),stepMinutes:0},{...createDemoModel(),modes:[{id:'bad'}]}]){expect(()=>validateModel(broken as DomainModel)).not.toThrow();expect((await solvePlan(broken as DomainModel)).status).toBe('invalid_model');}});
  it('rejects global non-finite parameters and malformed model structure before planning',async()=>{
    const corruptions:((m:DomainModel)=>void)[]=[m=>{m.services[0].toleratedOutageMinutes=NaN;},m=>{m.services[0].hardDeadlineMinute=Infinity;},m=>{m.dependencies[0].state='invalid' as any;},m=>{m.uncertainties=null as any;},m=>{m.allocationScopes[0].validUntil='invalid';}];
    for(const corrupt of corruptions){const m=createDemoModel();corrupt(m);expect(()=>validateModel(m)).not.toThrow();expect(validateModel(m).valid).toBe(false);expect((await solvePlan(m)).status).toBe('invalid_model');}
  });
  it('rejects non-finite action and allocation intervals without entering an unbounded loop',async()=>{
    const m=createDemoModel(),original=await solvePlan(m);
    for(const value of [NaN,Infinity,-Infinity]){const p=structuredClone(original);p.actions[0].endMinute=value;expect(validatePlan(m,p).issues.map(i=>i.code)).toContain('action_time');const a=structuredClone(original);a.actions[0].allocations[0].startMinute=value;expect(validatePlan(m,a).issues.map(i=>i.code)).toContain('allocation_time');}
    const malformed=structuredClone(original);delete (malformed.actions[0] as any).conditions;expect(validatePlan(m,malformed).issues[0].code).toBe('plan_schema');
  });
  it('rounds an off-grid battery boundary down and hard deadline down',async()=>{const m=createDemoModel();m.dependencies.find(d=>d.id==='radio-battery')!.availableUntilMinute=62;expect((await solvePlan(m)).metrics.minimumServiceMinutes).toBe(250);m.services[2].hardDeadlineMinute=29;expect((await solvePlan(m)).status).toBe('infeasible');});
  it('uses confirmed stock arrivals only after delivery and rejects early consumption',async()=>{
    const m=createDemoModel();m.resources.find(r=>r.id==='fuel-1')!.availableFromMinute=20;const p=await solvePlan(m);expect(p.status).toBe('optimal');expect(p.metrics.minimumServiceMinutes).toBe(290);expect(p.actions.find(a=>a.serviceId==='water')!.startMinute).toBe(20);expect(p.validation.valid).toBe(true);
    const a=p.actions.find(a=>a.serviceId==='water')!,fuel=a.allocations.find(r=>r.resourceId==='fuel-1')!;fuel.startMinute=0;expect(validatePlan(m,p).issues.map(i=>i.code)).toContain('stock_availability');
  });
  it('combines separately confirmed batches without manufacturing an early delivery',async()=>{
    const m=createDemoModel(),first=m.resources.find(r=>r.id==='fuel-1')!;first.quantity=0.5;m.resources.push({...structuredClone(first),id:'fuel-delivery',quantity:2,availableFromMinute:50});const p=await solvePlan(m);expect(p.validation.issues).toEqual([]);expect(p.actions.flatMap(a=>a.allocations).filter(a=>a.resourceId==='fuel-delivery').every(a=>a.startMinute>=50)).toBe(true);expect(p.metrics.minimumServiceMinutes).toBe(310);
  });
  it('a manual plan cannot postpone recorded consumption to a later delivery',async()=>{
    const m=createDemoModel(),p=await solvePlan(m),water=p.actions.find(a=>a.serviceId==='water')!;
    const fuel=water.allocations.filter(a=>a.resourceId==='fuel-1');for(const allocation of fuel){allocation.startMinute=115;allocation.endMinute=120;}
    expect(validatePlan(m,p).issues.map(i=>i.code)).toContain('stock_timing');
    expect(validatePlan(m,p).issues.map(i=>i.code)).not.toContain('stock_balance');
  });
  it('expired planned end without physical release never frees exclusive equipment',async()=>{const m=createDemoModel();m.reservations.push({id:'reserved',planId:'prior-plan',resourceId:'generator-1',quantity:1,status:'reserved',startMinute:-30,endMinute:-5});const p=await solvePlan(m);expect(p.metrics.minimumServiceMinutes).toBe(220);expect(p.validation.valid).toBe(true);});
  it('travel between staffed tasks cannot be replaced with instantaneous switching',async()=>{
    const m=createDemoModel();m.horizonMinutes=30;m.services=m.services.slice(0,2);m.services.forEach((s,i)=>{s.priority=1;s.minimum=1;s.location=i?'remote':'centrum';});m.modes=m.modes.slice(0,2);m.modes.forEach((mode,i)=>{mode.setupMinutes=0;mode.level=1;mode.location=i?'remote':'centrum';mode.dependencyId=undefined;mode.requirements=[{id:mode.id+'-staff',type:'person',quantity:1,unit:'osoba'}];});m.resources=m.resources.slice(0,1);m.travelTimes=[{from:'centrum',to:'remote',minutes:10},{from:'remote',to:'centrum',minutes:10}];m.services[1].hardDeadlineMinute=20;
    const p=await solvePlan(m);expect(p.validation.issues).toEqual([]);expect(p.metrics.minimumServiceMinutes).toBe(20);expect(p.actions.find(a=>a.modeId==='coord-radio')!.startMinute).toBeLessThanOrEqual(20);
  });
});

describe('solver hierarchy, uncertainty and bounded work',()=>{
  it('uncertain fourth person outranks irrelevant LTE without fabricated probabilities',async()=>{const r=await rankUncertainties(createScenario('uncertain-person'));expect(r.complete).toBe(true);expect(r.items[0].subjectIds).toEqual(['person-4']);expect(r.items[0].improvementServiceMinutes).toBe(90);expect(r.items.find(i=>i.id==='check-lte')!.improvementServiceMinutes).toBe(0);expect(r.items[0].approximate).toBe(false);});
  it('shared rank budget reports unexamined alternatives explicitly',async()=>{const r=await rankUncertainties(createDemoModel(),{budgetMs:0});expect(r.complete).toBe(false);expect(r.unexaminedIds).toHaveLength(2);});
  it('dependent uncertainty groups enumerate mixed combinations within the same budget',async()=>{
    const m=createDemoModel();m.uncertainties.forEach(u=>u.groupId='crew-and-link');const r=await rankUncertainties(m),group=r.items.find(i=>i.id==='group-crew-and-link')!;expect(group.variants).toHaveLength(4);expect(group.unexaminedCombinationCount).toBe('0');expect(r.complete).toBe(true);expect(group.variants!.every(v=>v.plan.validation.valid)).toBe(true);
    const limited=await rankUncertainties(m,{budgetMs:0});expect(limited.items.find(i=>i.id==='group-crew-and-link')!.unexaminedCombinationCount).toBe('4');expect(limited.unexaminedIds).toContain('group-crew-and-link');
  });
  it('zero budget and cancellation are not infeasibility or optimum',async()=>{const m=createDemoModel(),p=await solvePlan(m,{budgetMs:0});expect(p.status).toBe('feasible');expect(p.validation.valid).toBe(true);expect(p.solver.completeHierarchy).toBe(false);const c=new AbortController();c.abort();expect((await solvePlan(m,{signal:c.signal})).status).toBe('cancelled');});
  it('non-finite budgets never disable the bounded solver',async()=>{for(const budgetMs of [NaN,Infinity]){const p=await solvePlan(createDemoModel(),{budgetMs});expect(p.status).toBe('no_solution');expect(p.solver.stages).toHaveLength(0);const ranked=await rankUncertainties(createDemoModel(),{budgetMs});expect(ranked.complete).toBe(false);expect(ranked.items.every(i=>!i.availablePlan&&!i.unavailablePlan)).toBe(true);}});
  it('an exhausted solve budget does not restart at later objective levels or variants',async()=>{
    const budgetMs=0.001,m=createDemoModel();m.uncertainties.forEach(u=>u.groupId='bounded');const ranked=await rankUncertainties(m,{budgetMs});
    const plans=ranked.items.flatMap(i=>[i.availablePlan,i.unavailablePlan,...(i.variants??[]).map(v=>v.plan)]).filter((p):p is Plan=>Boolean(p));
    const unique=[...new Map(plans.map(p=>[p.id,p])).values()];expect(unique).toHaveLength(1);expect(unique[0].solver.stages).toHaveLength(1);expect(unique[0].solver.completeHierarchy).toBe(false);expect(ranked.complete).toBe(false);expect(ranked.unexaminedIds.length).toBeGreaterThan(0);
  });
  it('publishes only independent checked incumbents without premature optimum claims',async()=>{
    const m=createDemoModel(),events:string[]=[],incumbents:Plan[]=[];
    const result=await solvePlan(m,{onSolverStart:()=>events.push('started'),onProgress:plan=>{events.push('incumbent');incumbents.push(plan);}});
    expect(events[0]).toBe('started');expect(incumbents.length).toBeGreaterThan(0);expect(incumbents.every(p=>p.status==='feasible'&&!p.solver.completeHierarchy&&validatePlan(m,p).valid)).toBe(true);expect(result.status).toBe('optimal');
    expect(incumbents[0].actions).toEqual([]);expect(incumbents[0].solver.stages).toHaveLength(0);expect(incumbents.some(p=>p.solver.stages.length===1)).toBe(true);expect(result.solver.stages.length).toBeGreaterThan(1);
  });
  it('publishes immutable partial uncertainty rankings with explicit unexamined questions',async()=>{
    const m=createDemoModel(),snapshots:RankingResult[]=[];
    const result=await rankUncertainties(m,{onRankingProgress:snapshot=>snapshots.push(snapshot)});
    expect(snapshots[0].items).toEqual([]);expect(snapshots[0].complete).toBe(false);expect(snapshots[0].unexaminedIds).toEqual(m.uncertainties.map(u=>u.id));
    expect(snapshots[1].items).toHaveLength(1);expect(snapshots[1].complete).toBe(false);expect(snapshots[1].unexaminedIds).toEqual([m.uncertainties[1].id]);
    expect(snapshots.at(-1)?.complete).toBe(true);expect(snapshots.at(-1)?.items.map(i=>i.id)).toEqual(result.items.map(i=>i.id));
  });
  it('finds actions that have no value alone but enable a valuable successor',async()=>{const m=createDemoModel();m.modes[1].level=0;m.modes[0].predecessors=['coord-radio'];const p=await solvePlan(m);expect(p.validation.issues).toEqual([]);expect(p.actions.some(a=>a.modeId==='coord-radio')).toBe(true);expect(p.actions.find(a=>a.modeId==='help-local')!.startMinute).toBe(10);expect(p.timeline.find(t=>t.serviceId==='help')!.minimumMinutes).toBe(95);});
  it('small schedules agree with exhaustive enumeration',async()=>{
    const m=createDemoModel();m.horizonMinutes=20;m.services=m.services.slice(0,2);m.services.forEach(s=>{s.priority=1;s.minimum=1;});m.modes=m.modes.slice(0,2);m.modes.forEach(mode=>{mode.setupMinutes=5;mode.level=1;mode.dependencyId=undefined;mode.requirements=[{id:`${mode.id}-staff`,type:'person',quantity:1,unit:'osoba'}];});m.resources=m.resources.slice(0,1);
    let oracle=0;for(let code=0;code<81;code++){let v=code,previous=0,score=0;for(let t=0;t<4;t++){const current=v%3;v=Math.floor(v/3);if(current!==0&&current===previous)score+=5;previous=current;}oracle=Math.max(oracle,score);}
    const p=await solvePlan(m);expect(p.status).toBe('optimal');expect(p.metrics.minimumServiceMinutes).toBe(oracle);expect(p.validation.valid).toBe(true);
  });
});
