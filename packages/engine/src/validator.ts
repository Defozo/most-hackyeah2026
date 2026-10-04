import type { Availability, DomainModel, Plan, PlanMetrics, ServiceTimeline, ValidationIssue, ValidationResult } from '../../contracts/src/index.js';
import { evaluateDependencies } from './dependencies.js';
import { availableQuantity, resourceMatches, resourceUnitNumber, stockQuantity, travelMinutes, unitAvailable, validateModel } from './model.js';

export function computeTimeline(model: DomainModel, plan: Pick<Plan, 'actions'>): ServiceTimeline[] {
  return model.services.map(service => {
    const intervals: ServiceTimeline['intervals'] = []; let minimumMinutes = 0, firstMinimumMinute: number | null = null, maxOutageMinutes = 0, currentOutage = 0;
    for (let t = 0; t < model.horizonMinutes; t += model.stepMinutes) {
      const action = plan.actions.find(a => a.serviceId === service.id && a.readyMinute <= t && a.endMinute >= t + model.stepMinutes);
      const mode = model.modes.find(m => m.id === action?.modeId), level = mode?.level ?? 0, meetsMinimum = level >= service.minimum;
      if (meetsMinimum) { minimumMinutes += model.stepMinutes; firstMinimumMinute ??= t; currentOutage = 0; } else { currentOutage += model.stepMinutes; maxOutageMinutes = Math.max(maxOutageMinutes, currentOutage); }
      const previous = intervals[intervals.length - 1];
      if (previous && previous.modeId === (mode?.id ?? null)) previous.endMinute = t + model.stepMinutes;
      else intervals.push({ startMinute: t, endMinute: t + model.stepMinutes, modeId: mode?.id ?? null, level, meetsMinimum });
    }
    return { serviceId: service.id, intervals, minimumMinutes, outageMinutes: model.horizonMinutes - minimumMinutes, firstMinimumMinute, maxOutageMinutes, toleranceExceeded: maxOutageMinutes > service.toleratedOutageMinutes };
  });
}
export function computeMetrics(model: DomainModel, actions: Plan['actions'], timeline = computeTimeline(model, { actions })): PlanMetrics {
  const minimumServiceMinutes = timeline.reduce((n, s) => n + s.minimumMinutes, 0), possibleServiceMinutes = model.services.length * model.horizonMinutes;
  const byPriority: Record<string, number> = {}; let normalizedShortfall = 0;
  for (const service of model.services) { const line = timeline.find(s => s.serviceId === service.id)!; byPriority[service.priority] = (byPriority[service.priority] ?? 0) + line.outageMinutes * service.weight; normalizedShortfall += line.intervals.reduce((n, i) => n + Math.max(0, 1 - i.level / service.minimum) * (i.endMinute - i.startMinute), 0); }
  let simultaneousMinimumFromMinute: number | null = null;
  for (let t = 0; t < model.horizonMinutes; t += model.stepMinutes) if (timeline.every(line => line.intervals.some(i => i.startMinute <= t && i.endMinute > t && i.meetsMinimum))) { simultaneousMinimumFromMinute = t; break; }
  return { minimumServiceMinutes, possibleServiceMinutes, outageServiceMinutes: possibleServiceMinutes - minimumServiceMinutes, simultaneousMinimumFromMinute, byPriority, normalizedShortfall, switches: actions.length };
}

/** Reconstructs every interval, requirement, stock and movement from the public plan, independently of MILP variables. */
export function validatePlan(model: DomainModel, plan: Plan): ValidationResult {
  const modelCheck = validateModel(model), issues = [...modelCheck.issues], warnings = [...modelCheck.warnings];
  const add = (code: string, message: string, subjectId?: string, minute?: number) => issues.push({ code, message, subjectId, minute });
  if (!modelCheck.valid) return { valid: false, issues, warnings };
  if (!plan || !Array.isArray(plan.actions) || !Array.isArray(plan.assumptions) || !Array.isArray(plan.timeline) || !plan.metrics || plan.actions.some(a => !a || typeof a.id!=='string' || !a.id || !Array.isArray(a.allocations) || a.allocations.some(x => !x) || !Array.isArray(a.predecessorIds) || a.predecessorIds.some(id=>typeof id!=='string') || !Array.isArray(a.conditions) || a.conditions.some(c=>typeof c!=='string')) || plan.assumptions.some(a => !a || typeof a.subjectId!=='string' || !['available','unavailable','unknown'].includes(a.state))) return { valid: false, issues: [{code:'plan_schema',message:'Niepoprawna struktura planu.'}], warnings };
  if (plan.modelId !== model.id || plan.modelRevision !== model.revision || plan.referenceTime !== model.referenceTime) add('stale_model', 'Plan powstał dla innej wersji danych.');
  if (plan.horizonMinutes !== model.horizonMinutes || plan.stepMinutes !== model.stepMinutes) add('time_grid', 'Plan używa innego horyzontu lub kroku.');
  const assumptions = Object.fromEntries(plan.assumptions.map(a => [a.subjectId, a.state])) as Record<string, Availability>;
  if (plan.assumptions.length > 0 && !plan.conditional) add('hidden_assumption', 'Plan z założeniami musi być oznaczony jako warunkowy.');
  const renewable = new Map<string, { start: number; end: number; quantity: number; location: string; actionId: string; unitIds:string[] }[]>();
  const consumed = new Map<string, number>(); const actionIds = new Set<string>();
  for (const action of plan.actions) {
    if (actionIds.has(action.id)) add('duplicate_action', 'Powtórzony identyfikator działania.', action.id); actionIds.add(action.id);
    const mode = model.modes.find(m => m.id === action.modeId), service = model.services.find(s => s.id === action.serviceId);
    if (!mode || !service || mode.serviceId !== service.id) { add('missing_mode', 'Nieznany tryb lub błędna usługa.', action.id); continue; }
    if(modelCheck.blockedFragments?.some(fragment=>fragment.kind==='mode'&&fragment.id===mode.id))add('blocked_mode','Czynność używa wyłączonego fragmentu modelu.',action.id);
    const procedure = model.procedures.find(p => p.id === action.procedureId && p.version === action.procedureVersion);
    if (!mode.approved || !procedure?.approved || mode.procedureId !== action.procedureId || mode.procedureVersion !== action.procedureVersion) add('unapproved_procedure', 'Działanie nie ma zatwierdzonej właściwej wersji procedury.', action.id);
    if (![action.startMinute, action.readyMinute, action.endMinute].every(Number.isFinite) || action.startMinute < 0 || action.readyMinute < action.startMinute + mode.setupMinutes - 1e-7 || action.endMinute <= action.readyMinute || action.endMinute > model.horizonMinutes) add('action_time', 'Niepoprawne przedziały lub zbyt krótkie przygotowanie.', action.id);
    if (![action.startMinute,action.readyMinute,action.endMinute].every(Number.isFinite) || action.startMinute<0 || action.endMinute>model.horizonMinutes) continue;
    if ([action.startMinute, action.readyMinute, action.endMinute].some(t => t % model.stepMinutes !== 0)) add('time_discretization', 'Działanie nie leży na zadanej siatce czasu.', action.id);
    if (action.readyMinute !== action.startMinute + Math.ceil(mode.setupMinutes / model.stepMinutes) * model.stepMinutes) add('setup_rounding', 'Czas przygotowania musi być zaokrąglony w górę.', action.id);
    for (const predecessor of mode.predecessors ?? []) if (!plan.actions.some(a => a.modeId === predecessor && a.readyMinute + model.stepMinutes <= action.startMinute)) add('predecessor', 'Brak ukończonego wcześniejszego kroku.', action.id);
    for (let minute = action.startMinute; minute < action.endMinute; minute += model.stepMinutes) {
      if (mode.dependencyId && (evaluateDependencies(model, minute, assumptions).states[mode.dependencyId] !== 'available' || evaluateDependencies(model, minute+model.stepMinutes-1e-7, assumptions).states[mode.dependencyId] !== 'available')) add('dependency', 'Warunek działania nie jest potwierdzony.', action.id, minute);
      const setup = minute < action.readyMinute;
      for (const requirement of mode.requirements.filter(r => r.type === 'person' || r.type === 'equipment')) {
        if (requirement.phase === 'setup' && !setup || requirement.phase === 'operation' && setup) continue;
        const allocations = action.allocations.filter(a => a.requirementId === requirement.id && a.startMinute <= minute && a.endMinute >= minute + model.stepMinutes);
        if (allocations.reduce((sum, a) => sum + a.quantity, 0) + 1e-6 < requirement.quantity) add('staff_or_equipment', `Niepełne zapotrzebowanie: ${requirement.id}.`, action.id, minute);
      }
    }
    for(const requirement of mode.requirements.filter(r=>r.type==='person'||r.type==='equipment')){
      let previous:string|undefined;
      for(let minute=action.startMinute;minute<action.endMinute;minute+=model.stepMinutes){const setup=minute<action.readyMinute,active=requirement.phase==='setup'?setup:requirement.phase==='operation'?!setup:true;if(!active){previous=undefined;continue;}
        const units=action.allocations.filter(a=>a.requirementId===requirement.id&&a.startMinute<=minute&&a.endMinute>=minute+model.stepMinutes).flatMap(a=>a.unitIds??(model.resources.find(r=>r.id===a.resourceId)?.quantity===1?[`${a.resourceId}#1`]:[])).sort().join('\n');
        if(previous!==undefined&&units!==previous)add('unit_transfer','Zmiana jednostek wewnątrz jednej czynności wymaga osobnego działania i potwierdzonego przekazania.',action.id,minute);previous=units;
      }
    }
    for (const allocation of action.allocations) {
      const resource = model.resources.find(r => r.id === allocation.resourceId), req = mode.requirements.find(r => r.id === allocation.requirementId);
      if (!resource || !req) { add('unknown_allocation', 'Przydział wskazuje nieznany zasób lub zapotrzebowanie.', action.id); continue; }
      if(modelCheck.blockedFragments?.some(fragment=>fragment.kind==='resource'&&fragment.id===resource.id))add('blocked_resource','Przydział używa zasobu zależnego od wyłączonego fragmentu.',resource.id);
      if (!resourceMatches(resource, req)) add('resource_compatibility', 'Zasób nie spełnia jednostki, kompetencji, zgodności lub mocy.', resource.id);
      if (![allocation.quantity,allocation.startMinute,allocation.endMinute].every(Number.isFinite) || allocation.quantity <= 0 || allocation.startMinute < action.startMinute || allocation.endMinute > action.endMinute || allocation.endMinute <= allocation.startMinute) add('allocation_time', 'Niepoprawny czas lub ilość przydziału.', resource.id);
      if (resource.type === 'consumable' || resource.type === 'energy') {
        if (!Number.isFinite(allocation.consumedQuantity) || allocation.consumedQuantity! < 0) add('stock_quantity', 'Brak poprawnego bilansu zużycia.', resource.id);
        const q = allocation.consumedQuantity ?? 0; consumed.set(resource.id, (consumed.get(resource.id) ?? 0) + q);
        if (q > 0 && (availableQuantity(model, resource, allocation.startMinute, assumptions, plan.id) <= 0 || allocation.endMinute > (resource.availableUntilMinute ?? Infinity))) add('stock_availability', 'Zapas nie jest potwierdzony i dostępny przez cały przydział.', resource.id);
      } else {
        if (!Number.isInteger(allocation.quantity)) add('integer_allocation', 'Przydział ludzi lub sprzętu nie jest całkowity.', resource.id);
        const unitIds=allocation.unitIds??(Math.floor(resource.quantity)===1?[`${resource.id}#1`]:[]);
        const validUnits=Array.isArray(unitIds)&&unitIds.length===allocation.quantity&&new Set(unitIds).size===unitIds.length&&unitIds.every(id=>resourceUnitNumber(resource,id)!==null);
        if(!validUnits)add('allocation_units','Przydział grupy wymaga różnych, poprawnych jednostek sprzętu zgodnych z ilością.',resource.id);
        const safeUnits=validUnits?unitIds:[];
        if([allocation.startMinute,allocation.endMinute].every(Number.isFinite)&&allocation.startMinute>=0&&allocation.endMinute<=model.horizonMinutes)for(let t=allocation.startMinute;t<allocation.endMinute;t+=model.stepMinutes)for(const unitId of safeUnits)if(!unitAvailable(model,resource,unitId,t,assumptions,plan.id))add('unit_unavailable',`Jednostka ${unitId} jest niedostępna lub zarezerwowana.`,resource.id,t);
        const entries = renewable.get(resource.id) ?? []; entries.push({ start: allocation.startMinute, end: allocation.endMinute, quantity: allocation.quantity, location: mode.location ?? service.location, actionId: action.id,unitIds:safeUnits }); renewable.set(resource.id, entries);
      }
    }
    for (const req of mode.requirements.filter(r => r.type === 'consumable' || r.type === 'energy')) {
      const duration = req.phase === 'setup' ? action.readyMinute - action.startMinute : req.phase === 'both' ? action.endMinute - action.startMinute : action.endMinute - action.readyMinute;
      const required = (req.consumptionPerMinute ?? 0) * duration + (req.setupConsumption ?? (req.consumptionPerMinute === undefined ? req.quantity : 0));
      const actual = action.allocations.filter(a => a.requirementId === req.id).reduce((s, a) => s + (a.consumedQuantity ?? 0), 0);
      if (Math.abs(required - actual) > 1e-5) add('stock_balance', `Niepoprawne zużycie: ${req.id}; wymagane ${required}, zapisane ${actual}.`, action.id);
      for(let minute=action.startMinute;minute<action.endMinute;minute+=model.stepMinutes){
        const setup=minute<action.readyMinute,active=req.phase==='setup'?setup:req.phase==='both'?true:!setup;
        const needed=(active?(req.consumptionPerMinute??0)*model.stepMinutes:0)+(minute===action.startMinute?(req.setupConsumption??(req.consumptionPerMinute===undefined?req.quantity:0)):0);
        const supplied=action.allocations.filter(a=>a.requirementId===req.id).reduce((sum,a)=>{const overlap=Math.max(0,Math.min(a.endMinute,minute+model.stepMinutes)-Math.max(a.startMinute,minute));return sum+(a.consumedQuantity??0)*overlap/(a.endMinute-a.startMinute);},0);
        if(!Number.isFinite(supplied)||Math.abs(needed-supplied)>1e-5)add('stock_timing',`Bilans zużycia ${req.id} nie zgadza się w przedziale od ${minute} min.`,action.id,minute);
      }
    }
  }
  for (const service of model.services) for (let t = 0; t < model.horizonMinutes; t += model.stepMinutes) {
    const active = plan.actions.filter(a => a.serviceId === service.id && a.startMinute <= t && a.endMinute > t);
    if (active.length > 1) add('service_overlap', 'Dwa równoczesne tryby tej samej usługi.', service.id, t);
    if (service.hardDeadlineMinute !== undefined && t+model.stepMinutes > service.hardDeadlineMinute && !active.some(a => a.readyMinute <= t && model.modes.find(m => m.id === a.modeId)?.level! >= service.minimum)) add('hard_deadline', 'Przekroczono twardy termin zapewnienia minimum.', service.id, t);
  }
  for (const [id, entries] of renewable) {
    const resource = model.resources.find(r => r.id === id)!;
    for (let t = 0; t < model.horizonMinutes; t += model.stepMinutes) { const quantity = entries.filter(e => e.start < t + model.stepMinutes && e.end > t).reduce((s, e) => s + e.quantity, 0); if (quantity > availableQuantity(model, resource, t, assumptions, plan.id) + 1e-6) add('resource_overlap', 'Niedostępność lub podwójne wykorzystanie zasobu.', id, t); }
    for(const unitId of new Set(entries.flatMap(e=>e.unitIds))){const ordered=entries.filter(e=>e.unitIds.includes(unitId)).sort((a,b)=>a.start-b.start);
      if(ordered[0]&&ordered[0].start<(resource.availableFromMinute??0)+travelMinutes(model,resource.location,ordered[0].location))add('initial_travel',`Brak czasu na dojazd jednostki ${unitId}.`,id);
      for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length;j++){
        if(ordered[j].start<ordered[i].end)add('unit_overlap',`Jednostka ${unitId} została równocześnie przydzielona do dwóch zapotrzebowań.`,id,ordered[j].start);
        if(ordered[i].location!==ordered[j].location&&ordered[j].start-ordered[i].end<travelMinutes(model,ordered[i].location,ordered[j].location))add('travel',`Brak czasu na przejazd jednostki ${unitId} pomiędzy zadaniami.`,id,ordered[j].start);
      }
    }
  }
  for (const [id, q] of consumed) { const resource = model.resources.find(r => r.id === id)!; if (q > stockQuantity(model, resource, assumptions, plan.id) + 1e-6) add('stock_exceeded', 'Zużycie przekracza potwierdzony zapas.', id); }
  for (const mode of model.modes) if (mode.autonomyMinutes !== undefined && plan.actions.filter(a => a.modeId === mode.id).reduce((s, a) => s + a.endMinute - a.readyMinute, 0) > mode.autonomyMinutes + 1e-6) add('autonomy', 'Przekroczona autonomia trybu.', mode.id);
  const timeline = computeTimeline(model, plan), metrics = computeMetrics(model, plan.actions, timeline);
  if (JSON.stringify(metrics) !== JSON.stringify(plan.metrics)) add('metrics_mismatch', 'Wskaźniki nie wynikają z harmonogramu.');
  if (JSON.stringify(timeline) !== JSON.stringify(plan.timeline)) add('timeline_mismatch', 'Oś czasu nie wynika z harmonogramu.');
  for (const line of timeline) if (line.toleranceExceeded) warnings.push({ code: 'outage_tolerance', subjectId: line.serviceId, message: `Przerwa ${line.maxOutageMinutes} min przekracza tolerancję usługi.` });
  return { valid: issues.length === 0, issues, warnings, blockedFragments:modelCheck.blockedFragments };
}
