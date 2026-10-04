import loadHighs from 'highs';
import type { HighsSolution } from 'highs';
import type { DomainModel, Plan, PlanAction, SolveOptions } from '../../contracts/src/index.js';
import { evaluateDependencies } from './dependencies.js';
import { availableQuantity, resourceMatches, stockQuantity, travelMinutes, unitAvailable, validateModel } from './model.js';
import { computeMetrics, computeTimeline, validatePlan } from './validator.js';

type Term = [string, number];
type Assignment = { name: string; mode: number; requirement: number; resource: number; t: number; consumable: boolean; unitId?: string };
type Built = { modeIds:string[]; binaries: string[]; generals: string[]; bounds: string[]; rows: string[]; objectives: { name: string; terms: Term[] }[]; assignments: Assignment[]; x: string[][]; y: string[][]; starts: string[][] };
const modules = new Map<string, ReturnType<typeof loadHighs>>();
const clock = () => performance.now();
const expression = (terms: Term[]) => {
  const combined = new Map<string, number>(); for (const [name, c] of terms) combined.set(name, (combined.get(name) ?? 0) + c);
  const meaningful = [...combined].filter(([, c]) => Math.abs(c) > 1e-12);
  return meaningful.length ? meaningful.map(([name,c]) => `${c >= 0 ? '+' : '-'} ${Math.abs(c).toFixed(9).replace(/\.?0+$/, '') || '0'} ${name}`).join(' ') : '0 dummy';
};

export function buildMilp(model: DomainModel, options: SolveOptions = {}): Built {
  const n = model.horizonMinutes / model.stepMinutes, d = model.stepMinutes, assumptions = options.assumptions ?? {};
  const blockedModes=new Set((validateModel(model).blockedFragments??[]).filter(fragment=>fragment.kind==='mode').map(fragment=>fragment.id));
  // Preserve every service and its hard deadlines, removing only unusable modes
  // from numerical compilation. Their original parameters remain in the model.
  model={...model,modes:model.modes.filter(mode=>!blockedModes.has(mode.id)&&mode.approved&&model.procedures.some(p=>p.id===mode.procedureId&&p.version===mode.procedureVersion&&p.approved)&&(!mode.dependencyId||Array.from({length:n},(_,t)=>t).some(t=>evaluateDependencies(model,t*d,assumptions).states[mode.dependencyId!]==='available'&&evaluateDependencies(model,(t+1)*d-1e-7,assumptions).states[mode.dependencyId!]==='available')))};
  const built: Built = { modeIds:model.modes.map(mode=>mode.id),binaries: ['dummy'], generals: [], bounds: ['dummy = 0'], rows: [], objectives: [], assignments: [], x: [], y: [], starts: [] };
  // No useful plan needs more interchangeable units than all matching mode
  // requirements combined. Add slots blocked by named future reservations so
  // symmetry reduction never removes the free units needed later in the horizon.
  const units=model.resources.map(resource=>{if(resource.type==='consumable'||resource.type==='energy')return [];const demand=model.modes.flatMap(mode=>mode.requirements).filter(req=>resourceMatches(resource,req)).reduce((sum,req)=>sum+Math.ceil(req.quantity),0),held=new Set(model.reservations.filter(r=>r.resourceId===resource.id).flatMap(r=>r.unitIds??[])).size;return Array.from({length:Math.min(Math.floor(resource.quantity),demand+held)},(_,i)=>`${resource.id}#${i+1}`);});
  const row = (terms: Term[], op: '<=' | '>=' | '=', rhs: number) => built.rows.push(` c${built.rows.length}: ${expression(terms)} ${op} ${rhs}`);
  for (let mi = 0; mi < model.modes.length; mi++) {
    const mode = model.modes[mi], setup = Math.ceil(mode.setupMinutes / d);
    const x = Array.from({ length: n }, (_, t) => `x_${mi}_${t}`), y = Array.from({ length: n }, (_, t) => `y_${mi}_${t}`), starts = Array.from({ length: n }, (_, t) => `b_${mi}_${t}`);
    built.x.push(x); built.y.push(y); built.starts.push(starts); built.binaries.push(...x, ...y, ...starts);
    const approved = !blockedModes.has(mode.id) && mode.approved && model.procedures.some(p => p.id === mode.procedureId && p.version === mode.procedureVersion && p.approved);
    for (let t = 0; t < n; t++) {
      if (!approved || mode.dependencyId && (evaluateDependencies(model, t * d, assumptions).states[mode.dependencyId] !== 'available' || evaluateDependencies(model, (t+1) * d - 1e-7, assumptions).states[mode.dependencyId] !== 'available')) built.bounds.push(`${x[t]} = 0`);
      if (t === 0) row([[starts[t],1],[x[t],-1]], '=', 0);
      else { row([[starts[t],1],[x[t],-1],[x[t-1],1]], '>=', 0); row([[starts[t],1],[x[t],-1]], '<=', 0); row([[starts[t],1],[x[t-1],1]], '<=', 1); }
      row([[y[t],1],[x[t],-1]], '<=', 0);
      const recent = starts.slice(Math.max(0, t-setup+1), t+1);
      if (setup > 0) { for (const b of recent) row([[y[t],1],[b,1]], '<=', 1); row([[y[t],1],[x[t],-1],...recent.map(b => [b,1] as Term)], '>=', 0); }
      else row([[y[t],1],[x[t],-1]], '=', 0);
    }
    if (mode.autonomyMinutes !== undefined) row(y.map(name => [name,d]), '<=', Math.floor(mode.autonomyMinutes/d)*d);
  }
  for (const service of model.services) {
    const mis = model.modes.map((m,i) => m.serviceId === service.id ? i : -1).filter(i => i>=0);
    for (let t = 0; t < n; t++) { row(mis.map(mi => [built.x[mi][t],1]), '<=', 1); if (service.hardDeadlineMinute !== undefined && (t+1)*d > service.hardDeadlineMinute) row(mis.filter(mi => model.modes[mi].level >= service.minimum).map(mi => [built.y[mi][t],1]), '>=', 1); }
  }
  for (let mi = 0; mi < model.modes.length; mi++) {
    const mode = model.modes[mi], service = model.services.find(s => s.id === mode.serviceId)!, location = mode.location ?? service.location;
    for (const predecessor of mode.predecessors ?? []) {
      const pi = model.modes.findIndex(m => m.id === predecessor);
      if(pi<0){for(let t=0;t<n;t++)row([[built.starts[mi][t],1]],'<=',0);continue;}
      for (let t = 0; t < n; t++) row([[built.starts[mi][t],1], ...built.y[pi].slice(0,t).map(name => [name,-1] as Term)], '<=', 0);
    }
    for (let qi = 0; qi < mode.requirements.length; qi++) {
      const req = mode.requirements[qi], consumable = req.type === 'consumable' || req.type === 'energy';
      for (let t = 0; t < n; t++) {
        const demand: Term[] = req.phase === 'setup' ? [[built.x[mi][t],1],[built.y[mi][t],-1]] : req.phase === 'operation' || consumable && !req.phase ? [[built.y[mi][t],1]] : [[built.x[mi][t],1]];
        const terms: Term[] = [];
        for (let ri = 0; ri < model.resources.length; ri++) {
          const resource = model.resources[ri];
          if (!resourceMatches(resource, req) || availableQuantity(model,resource,t*d,assumptions) <= 0 || !consumable && t*d < (resource.availableFromMinute ?? 0) + travelMinutes(model, resource.location, location)) continue;
          if(consumable){const name=`a_${mi}_${qi}_${ri}_${t}`;terms.push([name,1]);built.assignments.push({name,mode:mi,requirement:qi,resource:ri,t,consumable});built.bounds.push(`0 <= ${name} <= ${stockQuantity(model,resource,assumptions)}`);}
          else for(const [ui,unitId] of units[ri].entries())if(unitAvailable(model,resource,unitId,t*d,assumptions)){const name=`a_${mi}_${qi}_${ri}_${ui}_${t}`;terms.push([name,1]);built.assignments.push({name,mode:mi,requirement:qi,resource:ri,t,consumable,unitId});built.binaries.push(name);}
        }
        if (consumable) row([...terms, ...demand.map(([name,c]) => [name,-c*(req.consumptionPerMinute ?? 0)*d] as Term), [built.starts[mi][t], -(req.setupConsumption ?? (req.consumptionPerMinute === undefined ? req.quantity : 0))]], '=', 0);
        else row([...terms,...demand.map(([name,c]) => [name,-c*req.quantity] as Term)], '=', 0);
      }
    }
  }
  // A contiguous procedure cannot silently exchange the physical people or
  // equipment assigned to one requirement. A transfer needs a new action;
  // setup-only and operation-only requirements retain their phase boundaries.
  for(let mi=0;mi<model.modes.length;mi++)for(let qi=0;qi<model.modes[mi].requirements.length;qi++){
    const req=model.modes[mi].requirements[qi];if(req.type==='consumable'||req.type==='energy')continue;
    const phase=(t:number):Term[]=>req.phase==='setup'?[[built.x[mi][t],1],[built.y[mi][t],-1]]:req.phase==='operation'?[[built.y[mi][t],1]]:[[built.x[mi][t],1]];
    const assigned=built.assignments.filter(a=>a.mode===mi&&a.requirement===qi),unitIds=new Set(assigned.map(a=>a.unitId!));
    if(unitIds.size<=req.quantity)continue;
    for(const unitId of unitIds){const byTime=new Map(assigned.filter(a=>a.unitId===unitId).map(a=>[a.t,a.name]));
      for(let t=1;t<n;t++){const current=byTime.get(t),previous=byTime.get(t-1);if(!current&&!previous)continue;const difference:Term[]=[...(current?[[current,1] as Term]:[]),...(previous?[[previous,-1] as Term]:[])],active=[...phase(t),...phase(t-1)];row([...difference,...active],'<=',2);row([...difference.map(([name,c])=>[name,-c] as Term),...active],'<=',2);}
    }
  }
  for (let ri = 0; ri < model.resources.length; ri++) {
    const resource = model.resources[ri], assigned = built.assignments.filter(a => a.resource === ri);
    if (resource.type === 'consumable' || resource.type === 'energy') row(assigned.map(a => [a.name,1]), '<=', stockQuantity(model,resource,assumptions));
    else {
      for (let t = 0; t < n; t++) row(assigned.filter(a => a.t===t).map(a => [a.name,1]), '<=', availableQuantity(model,resource,t*d,assumptions));
      const loc = (mi: number) => model.modes[mi].location ?? model.services.find(s => s.id === model.modes[mi].serviceId)!.location;
      for(const unitId of units[ri]){const unitAssignments=assigned.filter(a=>a.unitId===unitId);
        if(Math.floor(resource.quantity)>1)for(let t=0;t<n;t++)row(unitAssignments.filter(a=>a.t===t).map(a=>[a.name,1]),'<=',1);
        for (let i = 0; i < unitAssignments.length; i++) for (let j = i+1; j < unitAssignments.length; j++) {
          let a = unitAssignments[i], b = unitAssignments[j]; if (a.t>b.t) [a,b]=[b,a];
          if (loc(a.mode) !== loc(b.mode) && (b.t-a.t-1)*d < travelMinutes(model,loc(a.mode),loc(b.mode))) row([[a.name,1],[b.name,1]], '<=', 1);
        }
      }
    }
  }
  const priorities = [...new Set(model.services.map(s => s.priority))].sort((a,b) => a-b);
  for (const priority of priorities) {
    const terms: Term[] = [];
    for (const service of model.services.filter(s => s.priority === priority)) model.modes.forEach((mode,mi) => { if (mode.serviceId === service.id && mode.level >= service.minimum) for (const name of built.y[mi]) terms.push([name,-d*service.weight]); });
    built.objectives.push({ name: `minimum_priority_${priority}`, terms });
  }
  built.objectives.push({ name: 'normalized_shortfall', terms: model.modes.flatMap((m,mi) => built.y[mi].map(name => [name,-d*Math.min(1,m.level/model.services.find(s=>s.id===m.serviceId)!.minimum)] as Term)) });
  built.objectives.push({ name: 'normalized_resource_use', terms: built.assignments.map(a => [a.name, a.consumable ? 1/Math.max(0.001,model.resources[a.resource].quantity) : d/Math.max(1,model.resources[a.resource].quantity)] as Term) });
  built.objectives.push({ name: 'switches', terms: built.starts.flat().map(name => [name,1] as Term) });
  return built;
}

function emptyPlan(model: DomainModel, options: SolveOptions): Plan {
  const actions: PlanAction[] = [], safeGrid = Number.isFinite(model.horizonMinutes) && model.horizonMinutes > 0 && Number.isFinite(model.stepMinutes) && model.stepMinutes > 0 && Array.isArray(model.services), timeline = safeGrid ? computeTimeline(model,{actions}) : [];
  return { id: `plan-${globalThis.crypto.randomUUID()}`, modelId: model.id, modelRevision: model.revision, referenceTime: model.referenceTime, horizonMinutes: model.horizonMinutes, stepMinutes: model.stepMinutes, createdAt: new Date().toISOString(), status: 'no_solution', approvalStatus: 'draft', conditional: Object.keys(options.assumptions ?? {}).length>0, assumptions: Object.entries(options.assumptions ?? {}).map(([subjectId,state]) => ({subjectId,state})), actions, timeline, metrics: computeMetrics(model,actions,timeline), validation: {valid:false,issues:[],warnings:[]}, diagnostics: [], solver: { name:'HiGHS', stages:[], budgetMs: options.budgetMs ?? 5000, timings:{initializationMs:0,buildMs:0,solveMs:0,validationMs:0,totalMs:0}, completeHierarchy:false }, analysisScope:['Dyskretny model MILP, wspólny budżet wszystkich etapów.', 'Czasy przygotowania w górę do kroku; zapasy w dół do 0,001 jednostki.', 'Nieznane zasoby wyłącznie w jawnych wariantach warunkowych.', 'Obsada i wyposażenie rozliczane w każdym przedziale; zużycie ma osobny bilans.'] };
}

function extract(model: DomainModel, built: Built, solution: HighsSolution): PlanAction[] {
  model={...model,modes:built.modeIds.map(id=>model.modes.find(mode=>mode.id===id)!)};
  const value = (name: string) => { const column = solution.Columns?.[name]; return column && 'Primal' in column ? column.Primal : 0; }, actions: PlanAction[] = [], d = model.stepMinutes, n = model.horizonMinutes/d;
  for (let mi = 0; mi < model.modes.length; mi++) {
    const mode = model.modes[mi];
    for (let t = 0; t < n; t++) {
      if (value(built.x[mi][t]) < 0.5) continue;
      const start = t; while (t+1<n && value(built.x[mi][t+1])>0.5) t++; const end=t+1;
      const ready = start+Math.ceil(mode.setupMinutes/d); if (ready>=end) continue;
      const action: PlanAction = { id:`action-${mode.id}-${start}`,serviceId:mode.serviceId,modeId:mode.id,procedureId:mode.procedureId,procedureVersion:mode.procedureVersion,startMinute:start*d,readyMinute:ready*d,endMinute:end*d,allocations:[],predecessorIds:[],status:'proposed',conditions:['Potwierdź fizyczną dostępność zasobów i aktualność warunków przed rozpoczęciem.'] };
      for (const a of built.assignments.filter(a => a.mode===mi && a.t>=start && a.t<end && value(a.name)>1e-7)) {
        const q = Math.round(value(a.name)*1e9)/1e9, resourceId = model.resources[a.resource].id, requirementId = mode.requirements[a.requirement].id;
        const previous = action.allocations.findLast(x => x.resourceId===resourceId && x.requirementId===requirementId && x.endMinute===a.t*d && (a.consumable ? Math.abs((x.consumedQuantity??0)*d/(x.endMinute-x.startMinute)-q)<1e-8 : x.quantity===q&&x.unitIds?.[0]===a.unitId));
        if (previous) { previous.endMinute=(a.t+1)*d; if(a.consumable) { previous.consumedQuantity=(previous.consumedQuantity??0)+q; previous.quantity=previous.consumedQuantity; } }
        else action.allocations.push({resourceId,requirementId,quantity:q,startMinute:a.t*d,endMinute:(a.t+1)*d,...(a.consumable?{consumedQuantity:q}:{unitIds:[a.unitId!]})});
      }
      action.ownerId=action.allocations.find(a=>model.resources.find(r=>r.id===a.resourceId)?.type==='person')?.resourceId;
      actions.push(action);
    }
  }
  actions.sort((a,b)=>a.startMinute-b.startMinute || a.serviceId.localeCompare(b.serviceId));
  for (const action of actions) action.predecessorIds = (model.modes.find(m=>m.id===action.modeId)?.predecessors??[]).flatMap(modeId=>actions.filter(a=>a.modeId===modeId && a.readyMinute+model.stepMinutes<=action.startMinute).map(a=>a.id));
  return actions;
}

export async function solvePlan(model: DomainModel, options: SolveOptions = {}): Promise<Plan> {
  const started=clock(), check=validateModel(model), safeModel = check.valid ? model : { ...model, id:model?.id??'invalid', revision:model?.revision??0, referenceTime:model?.referenceTime??'', services:[],modes:[],horizonMinutes:0,stepMinutes:1 } as DomainModel, plan=emptyPlan(safeModel,options), timings=plan.solver.timings;
  if(!check.valid){plan.status='invalid_model';plan.validation=check;plan.diagnostics=check.issues.map(i=>i.message);timings.totalMs=clock()-started;return plan;}
  plan.validation.blockedFragments=check.blockedFragments;plan.diagnostics.push(...check.warnings.filter(w=>w.code==='fragment_excluded').map(w=>w.message));
  if(options.budgetMs!==undefined&&!Number.isFinite(options.budgetMs)){plan.status='no_solution';plan.diagnostics.push('Budżet obliczeń musi być skończoną liczbą milisekund.');timings.totalMs=clock()-started;return plan;}
  if(options.signal?.aborted){plan.status='cancelled';return plan;}
  try {
    const init=clock(), key=options.wasmUrl??'default';
    if(!modules.has(key)) modules.set(key,loadHighs(options.wasmUrl?{locateFile:()=>options.wasmUrl!}:{}));
    const highs=await modules.get(key)!;timings.initializationMs=clock()-init;
    const building=clock(), built=buildMilp(model,options);timings.buildMs=clock()-building;
    const frozen:string[]=[], budget=Math.max(0,options.budgetMs??5000);let best:Plan|undefined;
    // Parent workers use this boundary for a real wall-clock watchdog. HiGHS's
    // internal time_limit alone also permits LP parsing and native return overhead.
    if(options.onSolverStart){timings.totalMs=clock()-started;options.onSolverStart(structuredClone(plan));}
    // An empty schedule is a useful incumbent only after the independent
    // validator checks all hard deadlines and other public plan constraints.
    const emptyValidationStart=clock(),emptyValidation=validatePlan(model,plan);timings.validationMs+=clock()-emptyValidationStart;
    if(emptyValidation.valid){best={...plan,status:'feasible',validation:emptyValidation};if(options.onProgress){timings.totalMs=clock()-started;options.onProgress(structuredClone(best));}}
    for(const objective of built.objectives){
      if(options.signal?.aborted||timings.solveMs>=budget) break;
      const lp=`Minimize\n obj: ${expression(objective.terms)}\nSubject To\n${[...built.rows,...frozen].join('\n')}\nBounds\n${built.bounds.join('\n')}\nBinary\n${built.binaries.join(' ')}\n${built.generals.length?`General\n${built.generals.join(' ')}\n`:''}End`;
      const solving=clock(), solution=highs.solve(lp,{output_flag:false,log_to_console:false,time_limit:Math.max(0.001,(budget-timings.solveMs)/1000),mip_rel_gap:0,mip_abs_gap:0,random_seed:0});
      const elapsed=clock()-solving;timings.solveMs+=elapsed;plan.solver.stages.push({name:objective.name,status:solution.Status,objective:solution.ObjectiveValue,elapsedMs:elapsed});
      if(solution.Status==='Infeasible'){if(!best)plan.status='infeasible';break;}
      if(solution.Columns){
        const candidate={...plan,actions:extract(model,built,solution)};candidate.timeline=computeTimeline(model,candidate);candidate.metrics=computeMetrics(model,candidate.actions,candidate.timeline);
        const validationStart=clock();candidate.validation=validatePlan(model,candidate);timings.validationMs+=clock()-validationStart;
        if(candidate.validation.valid){best=candidate;if(options.onProgress){timings.totalMs=clock()-started;options.onProgress(structuredClone({...candidate,status:'feasible',solver:{...candidate.solver,completeHierarchy:false}}));}}else plan.diagnostics.push(...candidate.validation.issues.map(i=>`${i.code}: ${i.message}`));
      }
      if(solution.Status!=='Optimal')break;
      if(!best)break;
      const objectiveValue=objective.terms.reduce((sum,[name,c])=>sum+c*(solution.Columns[name]?.Primal??0),0);
      frozen.push(` lex${frozen.length}: ${expression(objective.terms)} <= ${objectiveValue+1e-7}`);
    }
    plan.solver.completeHierarchy=plan.solver.stages.length===built.objectives.length&&plan.solver.stages.every(s=>s.status==='Optimal');
    if(best){plan.actions=best.actions;plan.timeline=best.timeline;plan.metrics=best.metrics;plan.validation=best.validation;plan.status=plan.solver.completeHierarchy?'optimal':'feasible';}
    else if(plan.status!=='infeasible') {plan.validation=validatePlan(model,plan);if(plan.validation.valid){plan.status='feasible';plan.diagnostics.push('Brak znalezionego dodatniego przydziału; niezależnie sprawdzony plan niedostępności.');}}
    if(options.signal?.aborted&&!best)plan.status='cancelled';
    if(!plan.solver.completeHierarchy)plan.diagnostics.push('Nie udowodniono optimum pełnej hierarchii. Zachowano wyłącznie niezależnie sprawdzony wynik.');
    for(const line of plan.timeline)if(line.outageMinutes>0)plan.diagnostics.push(`${model.services.find(s=>s.id===line.serviceId)!.name}: ${line.outageMinutes} min poniżej minimum.`);
  } catch(error){plan.status='no_solution';plan.diagnostics.push(`Błąd obliczeń: ${error instanceof Error?error.message:String(error)}`);}
  timings.totalMs=clock()-started;return plan;
}
