import {describe,it,expect} from 'vitest';
import {createDemoModel} from '../../packages/scenarios/src/index.js';
import {solvePlan,validateModel,validatePlan,computeTimeline,computeMetrics} from '../../packages/engine/src/index.js';
import type {DomainModel,Plan,PlanAction} from '../../packages/contracts/src/index.js';

function groupedModel():DomainModel{
  const m=createDemoModel();m.horizonMinutes=60;m.allocationScopes=[];m.uncertainties=[];m.reservations=[];m.dependencies=[];
  m.services=m.services.map((s,i)=>({...s,id:`s${i}`,minimum:1,unit:'unit',priority:1,weight:1,location:`L${i}`}));
  m.modes=m.services.map((s,i)=>({...m.modes[0],id:`m${i}`,serviceId:s.id,name:s.name,level:1,dependencyId:undefined,setupMinutes:0,autonomyMinutes:5,location:s.location,predecessors:[],verificationContractId:`c${i}`,requirements:[{id:'equipment',type:'equipment',unit:'szt.',quantity:1}]}));
  m.verificationContracts=m.modes.map((mode,i)=>({...m.verificationContracts[0],id:`c${i}`,modeId:mode.id}));
  m.resources=[{...m.resources.find(r=>r.type==='equipment')!,id:'pair',quantity:2,location:'base',state:'available',confidence:'confirmed',unit:'szt.'}];
  m.travelTimes=[];for(const from of ['base','L0','L1','L2'])for(const to of ['base','L0','L1','L2'])if(from!==to)m.travelTimes.push({from,to,minutes:30});
  return m;
}
function action(model:DomainModel,index:number,start:number,unitId:string):PlanAction{
  const mode=model.modes[index];return {id:`manual-${index}`,serviceId:mode.serviceId,modeId:mode.id,procedureId:mode.procedureId,procedureVersion:mode.procedureVersion,startMinute:start,readyMinute:start,endMinute:start+5,allocations:[{resourceId:'pair',requirementId:'equipment',quantity:1,startMinute:start,endMinute:start+5,unitIds:[unitId]}],predecessorIds:[],conditions:[],status:'proposed'};
}
function withActions(model:DomainModel,template:Plan,actions:PlanAction[]):Plan{
  const plan=structuredClone(template);plan.actions=actions;plan.timeline=computeTimeline(model,plan);plan.metrics=computeMetrics(model,actions,plan.timeline);return plan;
}
describe('individual equipment units, routes and reservations',()=>{
  it('two units serve two remote sites, while a third site is physically unreachable in the horizon',async()=>{
    const m=groupedModel(),p=await solvePlan(m,{budgetMs:30000});
    // Each unit needs 30 minutes to leave base, works for five minutes, then
    // cannot reach another site before minute65, outside the60-minute horizon.
    expect(validateModel(m).valid).toBe(true);expect(p.status).toBe('optimal');expect(p.metrics.minimumServiceMinutes).toBe(10);expect(p.validation.valid).toBe(true);
    expect(new Set(p.actions.flatMap(a=>a.allocations.flatMap(r=>r.unitIds??[]))).size).toBe(2);
    const independent=withActions(m,p,[action(m,0,30,'pair#1'),action(m,1,30,'pair#2')]);expect(validatePlan(m,independent).valid).toBe(true);
    const impossible=withActions(m,p,[...independent.actions,action(m,2,35,'pair#1')]);expect(validatePlan(m,impossible).issues.map(i=>i.code)).toContain('travel');
    const duplicated=withActions(m,p,[action(m,0,30,'pair#1'),action(m,1,30,'pair#1')]);expect(validatePlan(m,duplicated).issues.map(i=>i.code)).toContain('unit_overlap');
    const excess=withActions(m,p,[...independent.actions,action(m,2,30,'pair#3')]);expect(validatePlan(m,excess).issues.map(i=>i.code)).toContain('allocation_units');expect(validatePlan(m,excess).issues.map(i=>i.code)).toContain('resource_overlap');
  });
  it('a named reservation excludes only its own unit and legacy quantities retain a stable conservative choice',async()=>{
    const m=groupedModel();m.reservations=[{id:'held',resourceId:'pair',planId:'older',quantity:1,startMinute:0,endMinute:60,status:'in_use',unitIds:['pair#1']}];
    const named=await solvePlan(m,{budgetMs:30000});expect(named.validation.valid).toBe(true);expect(named.metrics.minimumServiceMinutes).toBe(5);expect(named.actions.flatMap(a=>a.allocations).every(a=>a.unitIds?.[0]==='pair#2')).toBe(true);
    delete m.reservations[0].unitIds;const legacy=await solvePlan(m,{budgetMs:30000});expect(legacy.validation.valid).toBe(true);expect(legacy.metrics.minimumServiceMinutes).toBe(5);expect(legacy.actions.flatMap(a=>a.allocations).every(a=>a.unitIds?.[0]==='pair#1')).toBe(true);
  });
  it('keeps different physical units stable for the whole action and rejects a silent mid-action exchange',async()=>{
    const m=createDemoModel(),radio=m.resources.find(r=>r.id==='radio-1')!;radio.quantity=2;
    m.modes.find(mode=>mode.id==='help-local')!.requirements.push({id:'help-radio',type:'equipment',unit:radio.unit,quantity:1,tags:['radio'],phase:'both'});
    const p=await solvePlan(m,{budgetMs:30000});expect(p.validation.valid).toBe(true);expect(p.metrics.minimumServiceMinutes).toBe(310);
    const actions=p.actions.filter(a=>a.allocations.some(r=>r.resourceId===radio.id));expect(actions.length).toBe(2);
    const selected=actions.map(a=>new Set(a.allocations.filter(r=>r.resourceId===radio.id).flatMap(r=>r.unitIds??[])));expect(selected.every(s=>s.size===1)).toBe(true);expect([...selected[0]].some(id=>selected[1].has(id))).toBe(false);
    const forged=structuredClone(p),target=forged.actions.find(a=>a.id===actions[0].id)!,allocation=target.allocations.find(r=>r.resourceId===radio.id)!;
    const start=allocation.startMinute;expect(allocation.endMinute-start).toBeGreaterThan(m.stepMinutes);target.allocations.push({...allocation,startMinute:start+m.stepMinutes,unitIds:[allocation.unitIds![0].endsWith('#1')?'radio-1#2':'radio-1#1']});allocation.endMinute=start+m.stepMinutes;
    expect(validatePlan(m,forged).issues.some(i=>i.code==='unit_transfer')).toBe(true);
  });
  it('a shared cause disables affected equipment while an unaffected compatible replacement remains usable',async()=>{
    const m=createDemoModel(),generator=m.resources.find(r=>r.id==='generator-1')!;
    m.dependencies.push({id:'dry-room',name:'Pomieszczenie suche',kind:'leaf',inputs:[],state:'unavailable',confidence:'confirmed'});generator.dependencyId='dry-room';
    expect((await solvePlan(m,{budgetMs:30000})).metrics.minimumServiceMinutes).toBe(220);
    m.resources.push({...generator,id:'dry-generator',dependencyId:undefined});const replacement=await solvePlan(m,{budgetMs:30000});expect(replacement.metrics.minimumServiceMinutes).toBe(310);expect(replacement.validation.valid).toBe(true);expect(replacement.actions.flatMap(a=>a.allocations).some(a=>a.resourceId==='generator-1')).toBe(false);
    const forged=structuredClone(replacement),allocation=forged.actions.flatMap(a=>a.allocations).find(a=>a.resourceId==='dry-generator')!;allocation.resourceId='generator-1';allocation.unitIds=['generator-1#1'];expect(validatePlan(m,forged).valid).toBe(false);
  });
  it('legacy missing provenance is explicit, but malformed supplied provenance is rejected',()=>{
    const m=createDemoModel();delete m.services[0].provenance;expect(validateModel(m).valid).toBe(true);expect(validateModel(m).warnings.some(i=>i.code==='provenance_missing')).toBe(true);
    m.services[0].provenance={source:' ',checkedAt:'not a time'};expect(validateModel(m).issues.some(i=>i.code==='provenance_parameter')).toBe(true);
  });
});
