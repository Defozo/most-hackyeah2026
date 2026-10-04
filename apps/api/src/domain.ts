import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, Plan } from '../../../packages/contracts/src/index.js';
import { validateModel, validatePlan, computeMetrics, computeTimeline } from '../../../packages/engine/src/index.js';
import { Store, type State, type User, canonical, now, sha256 } from './store.js';
import { commandPayloadIssues } from './validation.js';
import { assessmentImpact } from './impact.js';

export class DomainError extends Error {
  constructor(public code: string, message: string, public statusCode = 400, public details?: any) { super(message); }
}
export function requireRole(user: User, roles: string[]) { if (!roles.includes(user.role)) throw new DomainError('forbidden', 'Brak uprawnień do tej czynności.', 403); }
const coordinators = ['administrator', 'coordinator'];
const editors = [...coordinators, 'owner'];
const workers = [...editors, 'operator'];
const must = (condition: any, code: string, message: string, status = 400) => { if (!condition) throw new DomainError(code, message, status); };
function item<T extends { id: string }>(list: T[], id: string): T { const found = list.find(x => x.id === id); if (!found) throw new DomainError('not_found', 'Nie znaleziono obiektu.', 404); return found; }
function text(value: any, max = 12000) { must(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'invalid_text', 'Pole tekstowe jest puste lub przekracza limit.'); return value.trim(); }
function date(value: any) { must(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'invalid_date', 'Nieprawidłowa data.'); return value; }
function allAllocations(state:State):any[] { return [...state.allocations,...(state.localAllocations??[])]; }
function samePhysicalUnits(first:any,second:any) { return first.resourceId===second.resourceId&&(!first.unitIds?.length||!second.unitIds?.length||first.unitIds.some((id:string)=>second.unitIds.includes(id))); }
function accelerated(state:State,incidentId:string) { return state.model.synthetic===true&&state.incidents.some(i=>i.id===incidentId&&i.kind==='exercise'); }
function executionClock(state:State,incidentId:string) { return { mode:accelerated(state,incidentId)?'accelerated_synthetic':'wall_clock', simulatedTiming:accelerated(state,incidentId), description:accelerated(state,incidentId)?'Przyspieszony zegar syntetycznego ćwiczenia. Odnotowane kliknięcia nie mierzą rzeczywistego czasu uruchomienia.':'Rzeczywisty czas rozpoczęcia, przygotowania i zakończenia według harmonogramu.' }; }
function checkScope(state:State,action:any,user:User,requireHolder=true) {
  if (!action.scopeId) return;
  const scope:any=item(state.allocationScopes,action.scopeId);
  must(!scope.revokedAt&&!scope.reconciliationRequired&&Date.parse(scope.validFrom)<=Date.now()&&Date.parse(scope.validUntil)>Date.now(),'scope_expired','Lokalne upoważnienie wygasło lub wymaga uzgodnienia.',409);
  if(requireHolder)must(scope.authorizedUserId===user.id,'scope_forbidden','Lokalną czynność wykonuje wskazany dysponent puli.',403);
}

function relevantActions(state: State, subjectId: string) {
  const impactedDependencies = new Set([subjectId]); let changed = true;
  while (changed) { changed = false; for (const dependency of state.model.dependencies) if (!impactedDependencies.has(dependency.id) && (dependency.inputs.some((id: string) => impactedDependencies.has(id)) || impactedDependencies.has(dependency.commonCauseId))) { impactedDependencies.add(dependency.id); changed = true; } }
  return state.actions.filter(action => {
    const mode = state.model.modes.find((m: any) => m.id === action.modeId);
    return action.serviceId === subjectId || action.modeId === subjectId || action.procedureId === subjectId || mode?.verificationContractId === subjectId || action.allocations.some((a: any) => a.resourceId === subjectId || impactedDependencies.has(state.model.resources.find((resource:any)=>resource.id===a.resourceId)?.dependencyId)) || impactedDependencies.has(mode?.dependencyId);
  });
}
export function invalidate(state: State, subjectId: string, reason: string) {
  for (const action of relevantActions(state, subjectId)) {
    action.needsReview = true; action.reviewReason = reason; action.conditionsValidatedAt = undefined;
    const plan = state.plans.find(p => p.id === action.planId); if (plan) plan.approvalStatus = 'needs_review';
    for (const result of state.verifications.filter(v => v.actionId === action.id && !v.invalidatedAt)) { result.invalidatedAt = now(); result.invalidationReason = reason; }
  }
}
function currentPlanModel(state: State, ownPlanId?: string) {
  const model = structuredClone(state.model);
  model.reservations = state.allocations.filter(a => a.planId !== ownPlanId && !['released','consumed'].includes(a.status));
  // Occupancy belongs to the accepted plan while validating that same plan.
  if (ownPlanId) for (const resource of model.resources) if (state.allocations.some(a => a.planId === ownPlanId && a.resourceId === resource.id)) {
    resource.occupied = false; resource.physicalReleaseConfirmed = true;
    for (const a of state.allocations.filter(a => a.planId === ownPlanId && a.resourceId === resource.id && a.status === 'consumed')) resource.quantity += a.actualConsumedQuantity ?? 0;
  }
  return model;
}
function validateAction(state: State, action: any, plan: Plan) {
  const model = structuredClone((plan as any).scopeId ? (plan as any).localModel : state.model), allocations=allAllocations(state);
  // Current procedures and service rules remain authoritative for a scoped plan too.
  for(const key of ['modes','procedures','verificationContracts','services','dependencies']) model[key]=structuredClone(state.model[key]);
  model.revision=state.model.revision;
  model.resources=model.resources.map((resource:any)=>{
    const current=state.model.resources.find((r:any)=>r.id===resource.id); if(!current)return resource;
    const effective={...structuredClone(current),quantity:Math.min(resource.quantity,current.quantity)};
    if(resource.state!=='available'||resource.confidence!=='confirmed'){effective.state=resource.state;effective.confidence=resource.confidence;}
    return effective;
  });
  model.reservations = allocations.filter(a => a.actionId !== action.id && !['released','consumed'].includes(a.status)).map(a => ({ ...a, planId: `held:${a.planId}` }));
  for (const resource of model.resources) if (allocations.some(a => a.actionId === action.id && a.resourceId === resource.id)) {
    if (!allocations.some(a => a.actionId !== action.id && a.resourceId === resource.id && a.status === 'in_use' && action.allocations.some((own:any)=>samePhysicalUnits(a,own)))) { resource.occupied = false; resource.physicalReleaseConfirmed = true; }
    for (const allocation of allocations.filter(a => a.actionId === action.id && a.resourceId === resource.id && a.status === 'consumed')) resource.quantity += allocation.actualConsumedQuantity ?? 0;
  }
  // Deadlines on another service and its changed conditions do not block this action.
  for (const service of model.services) if (service.id !== action.serviceId) delete service.hardDeadlineMinute;
  const actions = [{ ...action, id: action.sourceActionId }];
  const timeline = computeTimeline(model, { actions });
  const current = { ...plan, modelRevision: model.revision, actions, timeline, metrics: computeMetrics(model, actions, timeline) };
  const result = validatePlan(model, current);
  // The domain transition verifies completed predecessor actions against the journal.
  result.issues = result.issues.filter(issue => issue.code !== 'predecessor'); result.valid = !result.issues.length;
  return result;
}
export function approvePlan(store: Store, state: State, user: User, payload: any) {
  requireRole(user, coordinators);
  must(!state.recovery.isolated && state.recovery.accountsReviewed && state.recovery.resourcesReconciled, 'recovery_blocked', 'Odtworzona instancja wymaga przeglądu kont i fizycznego uzgodnienia zasobów.', 409);
  const plan: Plan = structuredClone(payload.plan); must(plan && Array.isArray(plan.actions), 'invalid_plan', 'Brak planu.');
  const incident:any=item(state.incidents, payload.incidentId); must(incident.status==='open','incident_closed','Incydent jest zamknięty.',409);
  must(accelerated(state,incident.id)||Date.parse(plan.referenceTime)+plan.horizonMinutes*60000>Date.now(),'plan_expired','Horyzont planu upłynął. Przelicz plan dla bieżącego czasu.',409);
  must(!state.plans.some(p => p.id === plan.id), 'plan_exists', 'Plan został już zapisany.', 409);
  must(!plan.conditional && !(plan.assumptions?.length), 'conditional_plan', 'Plan warunkowy wymaga uprzedniego potwierdzenia przesłanek.', 409);
  must(['optimal', 'feasible'].includes(plan.status), 'invalid_solver_result', 'Wynik obliczenia nie zawiera wykonalnego planu.', 409);
  must(plan.modelRevision === state.model.revision, 'model_changed', 'Model zmienił się. Przelicz plan.', 409);
  const validation = validatePlan(currentPlanModel(state), plan);
  must(validation.valid, 'invalid_plan', 'Plan nie przechodzi niezależnej walidacji.', 409);
  plan.validation=validation;
  plan.diagnostics=[...new Set([...plan.diagnostics,...validation.warnings.filter(warning=>warning.code==='fragment_excluded').map(warning=>warning.message)])];
  for (const action of plan.actions) for (const allocation of action.allocations) {
    const resource: any = item(state.model.resources, allocation.resourceId);
    must(!resource.reconciliationRequired, 'resource_unreconciled', 'Stan fizyczny zasobu wymaga potwierdzenia.', 409);
    must(!state.allocationScopes.some(s => s.resourceIds.includes(resource.id) && !s.revokedAt), 'resource_delegated', 'Zasób należy do lokalnej puli. Najpierw uzgodnij fizyczny zwrot puli.', 409);
    // Equipment remains exclusively assigned until an explicit physical return.
    if (resource.type === 'equipment') must(!state.allocations.some(a => samePhysicalUnits(a,allocation) && !['released', 'consumed'].includes(a.status)), 'resource_occupied', 'Sprzęt nie został fizycznie zwolniony.', 409);
  }
  plan.approvalStatus = 'approved'; (plan as any).incidentId = payload.incidentId; (plan as any).approvedBy = user.id; (plan as any).approvedAt = now(); (plan as any).executionClock=executionClock(state,incident.id); (plan as any).modelSnapshot=structuredClone(state.model);
  for (const action of plan.actions) {
    action.status = 'approved';
    const proposedOwner = payload.assignments?.[action.id] ?? action.ownerId;
    const ownerId = proposedOwner && store.users(user.organizationId).some(u => u.id === proposedOwner) ? proposedOwner : user.id;
    must(store.users(user.organizationId).some(u => u.id === ownerId && u.active && workers.includes(u.role)), 'invalid_owner', 'Wykonawca nie ma aktualnych praw.');
    state.actions.push({ ...action, id: `${plan.id}:${action.id}`, sourceActionId: action.id, planId: plan.id, incidentId: payload.incidentId, ownerId, version: 1, needsReview: false, executionClock:(plan as any).executionClock });
    for (const allocation of action.allocations) state.allocations.push({ ...allocation, id: randomUUID(), planId: plan.id, actionId: `${plan.id}:${action.id}`, status: 'reserved', physicalReleaseRequired: state.model.resources.find((r: any) => r.id === allocation.resourceId)?.type === 'equipment' });
  }
  state.plans.push(plan); state.model.reservations = state.allocations.filter(a=>!['released','consumed'].includes(a.status));
  return plan;
}

export function applyMutation(store: Store, state: State, user: User, type: string, payload: any): any {
  const issues = commandPayloadIssues(type, payload);
  if (issues.length) throw new DomainError('invalid_payload', 'Dane komendy nie odpowiadają wymaganemu schematowi.', 400, issues);
  switch (type) {
    case 'incident.create': {
      requireRole(user, coordinators); const incident = { id: payload.id ?? randomUUID(), name: text(payload.name ?? payload.title, 300), title: payload.name ?? payload.title, kind: payload.kind ?? (payload.exercise===undefined?(state.model.synthetic?'exercise':'incident'):payload.exercise?'exercise':'incident'), status: 'open', openedAt: now() };
      must((incident.kind==='exercise')===state.model.synthetic,'dataset_kind_mismatch','Ćwiczenia wymagają osobnej instalacji syntetycznej, a incydenty rzeczywiste osobnej instalacji operacyjnej. Użyj właściwego adresu i katalogu danych.',409);
      must(!state.incidents.some(i => i.id === incident.id), 'duplicate_id', 'Incydent już istnieje.', 409); state.incidents.push(incident); return incident;
    }
    case 'incident.close': { requireRole(user, coordinators); const incident = item(state.incidents, payload.incidentId) as any; must(!allAllocations(state).some(a => state.actions.some(action=>action.id===a.actionId&&action.incidentId===incident.id)&&(a.status === 'in_use' || a.status === 'reserved')), 'resources_not_returned', 'Najpierw potwierdź zwrot lub zużycie zasobów.', 409); incident.status = 'closed'; incident.closedAt = now(); return incident; }
    case 'observation.create': {
      requireRole(user, workers); if (payload.incidentId) item(state.incidents, payload.incidentId);
      const subjectId = text(payload.subjectId ?? 'general', 100);
      const observation = { id: payload.id ?? randomUUID(), incidentId: payload.incidentId, original: text(payload.original ?? payload.text), text: payload.original ?? payload.text, subjectId, observedState: payload.observedState ?? payload.claimedState, authorId: user.id, source: text(payload.source, 300), observedAt: date(payload.observedAt), receivedAt: now(), expiresAt: payload.expiresAt ?? payload.validUntil, verificationStatus: 'unverified', evidenceIds: payload.evidenceIds ?? [], kind: payload.kind ?? 'observation', clockUncertain: Math.abs(Date.now() - Date.parse(payload.observedAt)) > 24 * 3600_000 };
      must(!state.observations.some(o => o.id === observation.id), 'duplicate_id', 'Meldunek już istnieje.', 409);
      must(observation.evidenceIds.length <= 20, 'too_many_evidence', 'Zbyt wiele załączników.');
      state.observations.push(observation); return observation;
    }
    case 'observation.attach': {
      requireRole(user,workers); const observation=item(state.observations,payload.observationId) as any;
      must(coordinators.includes(user.role)||observation.authorId===user.id,'not_author','Załącznik do meldunku może dodać jego autor lub koordynator.',403);
      const evidenceIds=[...new Set<string>([...observation.evidenceIds,...payload.evidenceIds])];
      must(evidenceIds.length<=20,'too_many_evidence','Meldunek może zawierać najwyżej 20 załączników.');
      observation.evidenceIds=evidenceIds; observation.attachmentsUpdatedAt=now(); observation.attachmentsUpdatedBy=user.id;
      return observation;
    }
    case 'assessment.create': {
      requireRole(user, coordinators); must(['available', 'unavailable', 'unknown'].includes(payload.state), 'invalid_state', 'Nieprawidłowy stan.');
      must(Array.isArray(payload.observationIds) && payload.observationIds.length > 0, 'missing_source', 'Ocena wymaga meldunku źródłowego.');
      const sources = payload.observationIds.map((id: string) => item(state.observations, id));
      must(sources.every((s: any) => s.subjectId === payload.subjectId), 'source_mismatch', 'Meldunek dotyczy innego obiektu.');
      const subject = [...state.model.resources, ...state.model.dependencies].find((r: any) => r.id === payload.subjectId);
      must(subject, 'unknown_subject', 'Ocena wymaga istniejącego zasobu lub zależności.');
      const contradictory = state.observations.filter(o => o.subjectId === payload.subjectId && o.observedState && o.observedState !== payload.state && o.verificationStatus !== 'rejected');
      must(!contradictory.length || typeof payload.reason === 'string' && payload.reason.trim().length >= 10, 'contradiction_reason', 'Sprzeczne meldunki wymagają uzasadnienia oceny.', 409);
      const beforeModel = structuredClone(state.model);
      const assessment = { id: randomUUID(), subjectId: payload.subjectId, state: payload.state, observationIds: payload.observationIds, contradictions: contradictory.map(o => o.id), approvedBy: user.id, approvedAt: now(), modelRevision: ++state.model.revision, reason: payload.reason ?? '', incidentId: payload.incidentId, computedImpact: undefined as ReturnType<typeof assessmentImpact> | undefined };
      subject.state = payload.state; subject.confidence = 'confirmed';
      assessment.computedImpact = assessmentImpact(beforeModel, state.model, payload.subjectId, state.actions);
      sources.forEach((s: any) => { s.verificationStatus = 'confirmed'; s.assessment = assessment.id; });
      state.assessments.push(assessment); invalidate(state, payload.subjectId, 'Zmiana zatwierdzonej oceny.'); return assessment;
    }
    case 'model.replace': {
      requireRole(user, editors); const model = structuredClone(payload.model); model.reservations=state.allocations.filter(a=>!['released','consumed'].includes(a.status)); model.allocationScopes=state.allocationScopes.filter(scope=>!scope.revokedAt);
      const validation = validateModel(model); must(validation.valid, 'invalid_model', 'Model zawiera błędy.', 409);
      must(allAllocations(state).filter(a=>!['released','consumed'].includes(a.status)).every(a=>model.resources.some((r:any)=>r.id===a.resourceId)),'resource_reserved','Nie można usunąć zasobu przed rozliczeniem jego przydziałów.',409);
      must(model.organizationId === user.organizationId, 'wrong_organization', 'Model innej organizacji.', 403);
      must(model.synthetic===state.model.synthetic||['incidents','observations','assessments','plans','actions','verifications','allocations','allocationScopes','readinessTrials'].every(key=>!(state[key]??[]).length),'dataset_kind_mismatch','Nie można mieszać faktów ćwiczenia z danymi operacyjnymi. Utwórz osobną instalację z osobnym katalogiem danych.',409);
      if (user.role === 'owner') {
        const current = state.model;
        const owned = new Set(current.services.filter((s: any) => s.ownerId === user.id).map((s: any) => s.id));
        const ownedModes = new Set(current.modes.filter((m: any) => owned.has(m.serviceId)).map((m: any) => m.id));
        const ownedProcedures = new Set(current.modes.filter((m: any) => owned.has(m.serviceId)).map((m: any) => m.procedureId));
        for (const key of Object.keys(current)) if (!['services','modes','procedures','verificationContracts','revision'].includes(key)) must(canonical(current[key]) === canonical(model[key]), 'owner_scope', 'Właściciel zatwierdza wyłącznie własne usługi.', 403);
        for (const [key, permits] of [['services', (x: any) => owned.has(x.id) && x.ownerId === user.id], ['modes', (x: any) => owned.has(x.serviceId)], ['procedures', (x: any) => ownedProcedures.has(x.id) && !current.modes.some((m: any) => m.procedureId === x.id && !owned.has(m.serviceId))], ['verificationContracts', (x: any) => ownedModes.has(x.modeId)]] as const) {
          const before = current[key].filter((x: any) => !permits(x)); const after = model[key].filter((x: any) => !permits(x));
          must(canonical(before) === canonical(after), 'owner_scope', 'Zmiana lub usunięcie obiektu cudzej usługi jest zabronione.', 403);
        }
      }
      const users = store.users(user.organizationId);
      must(model.services.every((service:any)=>users.some(u=>u.id===service.ownerId&&u.active&&editors.includes(u.role))&&(!service.deputyId||users.some(u=>u.id===service.deputyId&&u.active&&workers.includes(u.role)))), 'missing_owner', 'Usługa wymaga aktywnego właściciela z prawem zatwierdzania modelu oraz uprawnionego zastępcy.');
      for (const key of ['procedures','verificationContracts']) for (const next of model[key]) {
        const previous = state.model[key].find((entry:any)=>entry.id===next.id);
        if (previous && canonical(previous)!==canonical(next)) must(next.version>previous.version, 'version_required', 'Zmiana procedury lub kontraktu wymaga nowego numeru wersji.', 409);
      }
      model.revision = state.model.revision + 1; model.reservations = state.allocations.filter(a=>!['released','consumed'].includes(a.status)); model.allocationScopes = state.allocationScopes.filter(scope=>!scope.revokedAt);
      for (const subject of [...state.model.resources, ...state.model.dependencies, ...state.model.procedures, ...state.model.modes, ...state.model.services, ...state.model.verificationContracts]) {
        const next = [...model.resources, ...model.dependencies, ...model.procedures, ...model.modes, ...model.services, ...model.verificationContracts].find((x: any) => x.id === subject.id);
        if (canonical(subject) !== canonical(next)) invalidate(state, subject.id, 'Zmiana modelu lub procedury.');
      }
      if (['referenceTime','horizonMinutes','stepMinutes'].some(key=>model[key]!==state.model[key])) for (const service of state.model.services) invalidate(state, service.id, 'Zmiana czasu odniesienia lub siatki planowania.');
      state.modelHistory??=[]; state.modelHistory.push({model:structuredClone(state.model),supersededAt:now(),supersededBy:user.id});
      state.model = model; return { model, validation };
    }
    case 'plan.approve': return approvePlan(store, state, user, payload);
    case 'action.accept': case 'action.start': case 'action.complete': case 'action.revalidate': {
      requireRole(user, type === 'action.revalidate' ? coordinators : workers);
      const action = item(state.actions, payload.actionId) as any; const plan = item(state.plans, action.planId) as any;
      must(coordinators.includes(user.role) || action.ownerId === user.id, 'not_assigned', 'Zadanie przypisano innej osobie.', 403);
      if (['action.accept','action.start','action.revalidate'].includes(type)) checkScope(state,action,user,type!=='action.revalidate');
      if (payload.expectedVersion !== undefined) must(payload.expectedVersion === action.version, 'action_changed', 'Wersja zadania zmieniła się.', 409);
      if (type === 'action.revalidate') {
        const validation = validateAction(state, action, plan);
        must(validation.valid, 'invalid_plan', 'Aktualne warunki nie pozwalają wykonać tej czynności.', 409);
        action.needsReview = false; action.conditionsValidatedAt = now(); action.reviewReason = undefined; action.version++;
        plan.approvalStatus = state.actions.some(a => a.planId === plan.id && a.needsReview) ? 'needs_review' : 'approved'; return { validation, plan, action };
      }
      const performedAt = date(payload.performedAt ?? now()), performedMs = Date.parse(performedAt);
      must(performedMs <= Date.now() + 30_000, 'future_action', 'Czas wykonania czynności leży w przyszłości.', 409);
      if (payload.performedAt !== undefined) {
        const authorizedAt = plan.approvedLocallyAt ?? plan.approvedAt;
        must(!authorizedAt || performedMs + 2000 >= Date.parse(authorizedAt), 'before_authorization', 'Czynność nie mogła nastąpić przed zatwierdzeniem planu.', 409);
        const previousAt = action.completedAt ?? action.startedAt ?? action.acceptedAt;
        must(!previousAt || performedMs >= Date.parse(previousAt), 'nonmonotonic_action', 'Czas wykonania jest wcześniejszy od poprzedniego kroku.', 409);
      }
      const reportedClock = { source: payload.performedAt === undefined ? 'server_received_time' : 'device_reported_server_anchored_time', boundedByServer: true, physicalTimingIndependentlyVerified: false, receivedAt: now() };
      if (type === 'action.accept') { must(action.status === 'approved', 'invalid_transition', 'Zadanie nie oczekuje na przyjęcie.', 409); action.status = 'accepted'; action.acceptedAt = performedAt; action.acceptedClock = reportedClock; }
      if (type === 'action.start') {
        must(!state.recovery.isolated && state.recovery.accountsReviewed && state.recovery.resourcesReconciled, 'recovery_blocked', 'Odtworzona instancja wymaga uzgodnienia przed rozpoczęciem czynności.', 409);
        must(!action.needsReview, 'review_required', 'Warunki zmieniły się. Koordynator musi ponownie sprawdzić czynność.', 409);
        must(['accepted', 'approved'].includes(action.status), 'invalid_transition', 'Zadanie nie może zostać rozpoczęte.', 409);
        if (!accelerated(state,action.incidentId)) {
          const reference=Date.parse(plan.referenceTime), preparation=(action.readyMinute-action.startMinute)*60000;
          must(performedMs>=reference+action.startMinute*60000,'before_scheduled_start','Nie nadszedł jeszcze czas rozpoczęcia w harmonogramie.',409);
          must(performedMs+preparation<reference+action.endMinute*60000,'action_window_expired','Pozostały czas nie wystarcza na przygotowanie i obsługę. Wymagany nowy plan.',409);
        }
        must(payload.checkedConditions === true, 'conditions_unconfirmed', 'Potwierdź warunki, kompetencje i dostępność zasobów.');
        for (const id of action.predecessorIds) {
          const predecessor=state.actions.find(a => a.planId === plan.id && a.sourceActionId === id && a.status === 'completed');
          must(predecessor, 'predecessor_incomplete', 'Poprzednie zadanie nie jest ukończone.', 409);
          if(!accelerated(state,action.incidentId)) must(performedMs>=Date.parse(predecessor!.completedAt)+plan.stepMinutes*60000,'predecessor_window','Nie upłynął wymagany krok harmonogramu po zakończeniu poprzednika.',409);
        }
        const validation = validateAction(state, action, plan); must(validation.valid, 'invalid_plan', 'Czynność nie jest już wykonalna.', 409);
        for (const allocation of allAllocations(state).filter(a => a.actionId === action.id)) {
          const resource: any = item(state.model.resources, allocation.resourceId);
          if (resource.type === 'equipment') must(!allAllocations(state).some(a => samePhysicalUnits(a,allocation) && a.actionId !== action.id && a.status === 'in_use'), 'physical_resource_busy', 'Inna czynność nadal fizycznie zajmuje ten sprzęt. Potwierdź zwrot.', 409);
        }
        action.status = 'started'; action.startedAt = performedAt; action.startedClock = reportedClock; action.conditionsValidatedAt = performedAt;
        for (const allocation of allAllocations(state).filter(a => a.actionId === action.id)) {
          allocation.status = 'in_use'; const resource: any = item(state.model.resources, allocation.resourceId);
          if (resource.type === 'equipment' && (!allocation.unitIds?.length || resource.quantity===1)) { resource.occupied = true; resource.physicalReleaseConfirmed = false; }
        }
      }
      if (type === 'action.complete') {
        must(action.status === 'started', 'invalid_transition', 'Najpierw rozpocznij zadanie.', 409);
        if (!accelerated(state,action.incidentId)) must(performedMs>=Date.parse(action.startedAt)+(action.readyMinute-action.startMinute)*60000,'preparation_not_elapsed','Nie upłynął rzeczywisty czas przygotowania wymagany przez zatwierdzony harmonogram.',409);
        action.status = 'completed'; action.completedAt = performedAt; action.completedClock = reportedClock; action.notes = payload.notes ?? '';
        // Settlement changes reserved consumption to actual consumption exactly once.
        for (const allocation of allAllocations(state).filter(a => a.actionId === action.id)) {
          const resource: any = item(state.model.resources, allocation.resourceId);
          if (['consumable', 'energy'].includes(resource.type)) { const consumed = allocation.consumedQuantity ?? allocation.quantity; must(resource.quantity >= consumed, 'stock_changed', 'Rzeczywisty zapas wymaga uzgodnienia.', 409); resource.quantity -= consumed; if(plan.scopeId){const local=plan.localModel.resources.find((r:any)=>r.id===resource.id);local.quantity-=consumed;} allocation.status = 'consumed'; allocation.actualConsumedQuantity = consumed; }
        }
      }
      action.version++; return action;
    }
    case 'verification.create': {
      requireRole(user, workers); const action = item(state.actions, payload.actionId) as any; const plan = item(state.plans, action.planId) as any;
      if(action.scopeId) checkScope(state,action,user,false);
      must(action.status === 'completed', 'action_incomplete', 'Ukończ czynność przed testem wyniku.', 409);
      must(!action.needsReview, 'review_required', 'Warunki czynności wymagają ponownego sprawdzenia.', 409);
      const mode: any = item(state.model.modes, action.modeId); const contract: any = item(state.model.verificationContracts, mode.verificationContractId);
      must(contract.verifierRoles.includes(user.role), 'verifier_role', 'Ta rola nie może zatwierdzić testu.', 403);
      must((payload.contractId===undefined||payload.contractId===contract.id)&&(payload.contractVersion===undefined||payload.contractVersion===contract.version), 'contract_changed', 'Kontrakt testu zmienił się. Odczytaj aktualne kryteria.', 409);
      must(coordinators.includes(user.role) || action.ownerId === user.id || user.role === 'owner' && state.model.services.some((s: any) => s.id === action.serviceId && s.ownerId === user.id), 'not_assigned', 'Zadanie przypisano innej osobie.', 403);
      must(['passed', 'failed', 'unknown', 'skipped'].includes(payload.outcome), 'invalid_outcome', 'Nieprawidłowy wynik testu.');
      must(mode.procedureVersion === action.procedureVersion, 'procedure_changed', 'Procedura zmieniła się.', 409);
      const evidenceIds: string[] = payload.evidenceIds ?? []; const measuredValue = payload.measuredValue ?? payload.measurement;
      let evidenceObservedAt: string | undefined;
      if (payload.outcome === 'passed') {
        must(Number.isFinite(measuredValue) && measuredValue >= contract.minimum, 'minimum_not_met', 'Pomiar nie potwierdza minimum.');
        must(!contract.evidenceRequired || evidenceIds.length > 0 && evidenceIds.every(id => store.evidenceComplete(user.organizationId, id)), 'missing_evidence', 'Wymagany dowód musi być kompletny.', 409);
        if(contract.simulated) {
          const proofs=evidenceIds.flatMap(id=>{if(!store.evidenceComplete(user.organizationId,id))return[];try{return[JSON.parse(readFileSync(join(store.evidenceDir,id),'utf8'))];}catch{return[];}});
          const matching=proofs.filter(p=>p?.simulated===true&&p.actionId===action.id&&p.contractId===contract.id&&(p.contractVersion===undefined||p.contractVersion===contract.version));
          must(matching.length>0,'simulator_not_tested','Wynik symulowany wymaga dowodu testu tej czynności i kontraktu.');
          must(matching.some(p=>p.measuredValue===measuredValue&&p.unit===contract.unit&&Number.isFinite(p.durationMinutes)&&p.durationMinutes>0),'measurement_mismatch','Pomiar musi odpowiadać wartości, jednostce i czasowi próby z dowodu symulatora.');
        }
        if (!contract.simulated && /register|rejestr/i.test(contract.metric + contract.title)) {
          const records=store.db.prepare('SELECT id,value,created_at FROM register_records WHERE action_id=? AND organization_id=?').all(action.id,user.organizationId) as any[];
          must(records.length>0, 'register_not_tested', 'Wykonaj rzeczywisty zapis i odczyt rejestru.');
          const proofs=evidenceIds.flatMap(id=>{if(!store.evidenceComplete(user.organizationId,id))return[];try{return[JSON.parse(readFileSync(join(store.evidenceDir,id),'utf8'))];}catch{return[];}});
          const matching=proofs.flatMap(proof=>{
            if(proof.readBackVerified!==true||!proof.record?.id||proof.record.actionId&&proof.record.actionId!==action.id||proof.record.organizationId&&proof.record.organizationId!==user.organizationId||proof.readBack&&canonical(proof.record)!==canonical(proof.readBack))return[];
            const record=records.find(record=>record.id===proof.record.id&&record.value===String(proof.record.text??proof.record.value??''));if(!record)return[];
            const times=[record.created_at,proof.testedAt,proof.record.createdAt].filter(Boolean).map(value=>Date.parse(value));
            return times.every(Number.isFinite)?[Math.min(...times)]:[];
          });
          must(matching.length>0,'register_proof_mismatch','Dołącz dowód zapisu i odczytu tego samego rekordu, czynności i organizacji. Sam plik lub wcześniejszy rekord nie potwierdza próby.',409);
          evidenceObservedAt=new Date(Math.max(...matching)).toISOString();
        }
      }
      const observedAt = date(payload.observedAt ?? now()); must(Date.parse(observedAt) <= Date.now() + 60000, 'future_observation', 'Czas testu leży w przyszłości.');
      if(!accelerated(state,action.incidentId)) must(Date.parse(observedAt)>=Date.parse(action.completedAt),'verification_before_completion','Test działania nie może poprzedzać wykonania czynności.',409);
      const result = { id: randomUUID(), actionId: action.id, planId: plan.id, planRevision: plan.modelRevision, contractId: contract.id, contractVersion: contract.version, procedureVersion: action.procedureVersion, outcome: payload.outcome, measuredValue, notes: payload.notes ?? '', evidenceIds, verifiedBy: user.id, observedAt, ...(evidenceObservedAt?{evidenceObservedAt}:{}), validUntil: new Date(Math.min(Date.parse(observedAt),Date.parse(evidenceObservedAt??observedAt)) + contract.validityMinutes * 60000).toISOString(), simulated: contract.simulated };
      for (const previous of state.verifications.filter(v=>v.actionId===action.id&&!v.invalidatedAt)) { previous.invalidatedAt = now(); previous.invalidationReason = 'Zapisano kolejny wynik testu tej czynności.'; }
      state.verifications.push(result); return result;
    }
    case 'readiness.trial': {
      requireRole(user,workers); const service:any=item(state.model.services,payload.serviceId), mode:any=item(state.model.modes,payload.modeId);
      must(user.role==='administrator'||[service.ownerId,service.deputyId].includes(user.id),'owner_approval_required','Próbę zatwierdza właściciel usługi, wskazany zastępca albo administrator.',403);
      must(mode.serviceId===service.id,'service_mismatch','Tryb należy do innej usługi.');
      const verification:any=item(state.verifications,payload.verificationId), action:any=item(state.actions,verification.actionId), contract:any=item(state.model.verificationContracts,mode.verificationContractId);
      must(action.serviceId===service.id&&action.modeId===mode.id,'verification_mismatch','Wynik testu dotyczy innej usługi lub trybu.');
      must(action.status==='completed'&&!action.needsReview&&verification.outcome==='passed'&&!verification.invalidatedAt&&Date.parse(verification.validUntil)>Date.now()&&verification.contractId===contract.id&&verification.contractVersion===contract.version&&verification.procedureVersion===mode.procedureVersion&&verification.evidenceIds.every((id:string)=>store.evidenceComplete(user.organizationId,id)), 'current_verification_required','Próba wymaga aktualnego pozytywnego testu właściwej wersji i kompletnych dowodów.',409);
      must(payload.measuredLevel>=Math.max(service.minimum,contract.minimum),'minimum_not_met','Zmierzony poziom musi spełniać minimum usługi i kontraktu testu.');
      must(payload.measuredLevel===verification.measuredValue,'measurement_mismatch','Poziom próby musi odpowiadać pomiarowi zapisanemu w wybranym teście.');
      const trial={id:randomUUID(),serviceId:service.id,modeId:mode.id,verificationId:verification.id,actionId:action.id,incidentId:action.incidentId,modelRevision:state.model.revision,procedureId:mode.procedureId,procedureVersion:mode.procedureVersion,contractId:contract.id,contractVersion:contract.version,knownGoodConfirmed:true,preparationMinutes:payload.preparationMinutes,observedSetupMinutes:payload.observedSetupMinutes,measuredLevel:payload.measuredLevel,unit:contract.unit,notes:payload.notes,source:payload.source,approvedBy:user.id,approvedAt:now(),evidenceIds:[...verification.evidenceIds],simulated:contract.simulated,parametersPublished:false,requiresModelReview:payload.observedSetupMinutes>mode.setupMinutes||payload.measuredLevel<mode.level};
      state.readinessTrials??=[]; state.readinessTrials.push(trial); return trial;
    }
    case 'register.record': {
      requireRole(user, workers); const action = item(state.actions, payload.actionId) as any;
      must(['started','completed'].includes(action.status), 'action_not_started', 'Najpierw rozpocznij czynność rejestru.', 409);
      must(coordinators.includes(user.role) || action.ownerId === user.id, 'not_assigned', 'Rejestr dotyczy zadania innej osoby.', 403);
      const mode: any = item(state.model.modes, action.modeId), contract: any = item(state.model.verificationContracts, mode.verificationContractId);
      must(!contract.simulated && /rejestr|register/i.test(contract.title + contract.expectedResult), 'wrong_contract', 'Czynność nie dotyczy lokalnego rejestru.');
      must(store.evidenceComplete(user.organizationId, payload.evidenceId), 'missing_evidence', 'Najpierw prześlij dowód zapisu i odczytu rejestru.', 409);
      let proof; try { proof = JSON.parse(readFileSync(join(store.evidenceDir, payload.evidenceId), 'utf8')); } catch { throw new DomainError('invalid_register_proof', 'Nieprawidłowy dowód testu rejestru.'); }
      must(proof.readBackVerified === true && proof.record?.id && canonical(proof.record) === canonical(proof.readBack), 'register_readback_failed', 'Dowód musi zachować ten sam zapis i odczyt.');
      must(!proof.record.actionId || proof.record.actionId === action.id, 'register_action_mismatch', 'Dowód rejestru dotyczy innej czynności.');
      const id = text(String(proof.record.id), 150); must(!store.db.prepare('SELECT id FROM register_records WHERE id=?').get(id), 'duplicate_register_record', 'Rekord już uzgodniono.', 409);
      const value = text(String(proof.record.text ?? proof.record.value ?? ''), 2000);
      store.db.prepare('INSERT INTO register_records(id,organization_id,incident_id,action_id,value,created_at) VALUES (?,?,?,?,?,?)').run(id, user.organizationId, action.incidentId, action.id, value, now());
      const readBack: any = store.db.prepare('SELECT value FROM register_records WHERE id=? AND organization_id=? AND action_id=?').get(id, user.organizationId, action.id);
      must(readBack?.value === value, 'register_readback_failed', 'Nie potwierdzono odczytu uzgodnionego rekordu.');
      return { id, actionId: action.id, evidenceId: payload.evidenceId, source: 'device-readback-evidence', reconciledAt: now(), serverWriteReadVerified: true, limitation: 'Odtworzono zgłoszony zapis urządzenia. Serwer nie był obecny podczas pierwotnego testu offline.' };
    }
    case 'resource.release': {
      requireRole(user, workers); const resource: any = item(state.model.resources, payload.resourceId);
      const allocations = allAllocations(state).filter(a => a.resourceId === resource.id && !['released', 'consumed'].includes(a.status));
      must(coordinators.includes(user.role) || allocations.length>0&&allocations.every(a => state.actions.find(x => x.id === a.actionId)?.ownerId === user.id), 'not_assigned', 'Nie możesz zwolnić zasobu bez własnego przydziału.', 403);
      must(payload.physicalConfirmed === true, 'physical_confirmation_required', 'Zwrot wymaga fizycznego potwierdzenia.');
      must(allocations.every(a => ['completed', 'cancelled'].includes(state.actions.find(x => x.id === a.actionId)?.status)), 'action_still_active', 'Zakończ czynność przed zwolnieniem zasobu.', 409);
      for (const allocation of allocations) { allocation.status = 'released'; allocation.releaseConfirmedAt = now(); allocation.releaseConfirmedBy = user.id; }
      resource.occupied = false; resource.physicalReleaseConfirmed = true; resource.reconciliationRequired = false;
      invalidate(state, resource.id, 'Potwierdzono fizyczny zwrot zasobu; poprzedni test nie potwierdza dalszego działania usługi.'); return resource;
    }
    case 'resource.update': case 'resource.reconcile': {
      requireRole(user, coordinators); const resource: any = item(state.model.resources, payload.resourceId);
      must(['available','unavailable','unknown'].includes(payload.state ?? resource.state), 'invalid_state', 'Nieprawidłowy stan zasobu.');
      if (payload.quantity !== undefined) { must(Number.isFinite(payload.quantity) && payload.quantity >= 0 && (resource.type!=='person'||payload.quantity===1), 'invalid_quantity', 'Nieprawidłowa ilość. Osoba ma własną tożsamość i ilość 1.'); resource.quantity = payload.quantity; }
      resource.state = payload.state ?? resource.state; resource.confidence = payload.confidence ?? 'confirmed';
      if (type === 'resource.reconcile') { must(payload.physicalConfirmed === true, 'physical_confirmation_required', 'Uzgodnienie wymaga fizycznego sprawdzenia.'); resource.reconciliationRequired = false; resource.occupied = Boolean(payload.occupied); resource.physicalReleaseConfirmed = !payload.occupied; if (!payload.occupied) for (const a of allAllocations(state).filter(a => a.resourceId === resource.id && a.status !== 'consumed')) { a.status = 'released'; a.releaseConfirmedAt = now(); } state.recovery.resourcesReconciled = state.model.resources.every((r: any) => !r.reconciliationRequired); }
      state.model.revision++; invalidate(state, resource.id, 'Zmiana dostępności lub stanu fizycznego zasobu.'); return resource;
    }
    case 'scope.create': {
      requireRole(user, coordinators); must(!state.recovery.isolated && state.recovery.accountsReviewed && state.recovery.resourcesReconciled, 'recovery_blocked', 'Najpierw zakończ odtworzenie.', 409);
      const scope = { ...payload, id: payload.id ?? randomUUID(), modelRevision: state.model.revision, approvedBy: user.id, approvedAt: now() };
      must(!state.allocationScopes.some(s=>s.id===scope.id),'duplicate_id','Pula z tym identyfikatorem już istnieje.',409);
      must(Array.isArray(scope.resourceIds) && Array.isArray(scope.modeIds), 'invalid_scope', 'Brak zakresu zasobów lub trybów.');
      must(store.users(user.organizationId).some(u => u.id === scope.authorizedUserId && u.active && workers.includes(u.role)), 'invalid_owner', 'Nieuprawniony dysponent.');
      must(Date.parse(date(scope.validUntil)) > Date.parse(date(scope.validFrom)), 'invalid_dates', 'Nieprawidłowa ważność.');
      must(Date.parse(scope.validUntil)>Date.now(), 'scope_expired', 'Nie można nadać wygasłego upoważnienia.', 409);
      for (const id of scope.resourceIds) {
        const resource: any = item(state.model.resources, id); must(!resource.reconciliationRequired && !resource.occupied, 'resource_unreconciled', 'Zasób wymaga uzgodnienia lub pozostaje fizycznie zajęty.', 409);
        must(!state.allocationScopes.some(s => s.resourceIds.includes(id) && !s.revokedAt), 'scope_conflict', 'Zasób należy do lokalnej puli, której nie zwrócono.', 409);
        must(!state.allocations.some(a => a.resourceId === id && !['released','consumed'].includes(a.status)), 'resource_reserved', 'Zasób ma aktywny globalny przydział. Najpierw uzgodnij jego fizyczny zwrot.', 409);
      }
      scope.modeIds.forEach((id: string) => item(state.model.modes, id)); state.allocationScopes.push(scope); state.model.allocationScopes = state.allocationScopes.filter(scope=>!scope.revokedAt); return scope;
    }
    case 'scope.release': {
      requireRole(user, coordinators); const scope = item(state.allocationScopes, payload.scopeId) as any;
      must(payload.physicalConfirmed === true, 'physical_confirmation_required', 'Zamknięcie puli wymaga uzgodnienia stanu fizycznego.');
      must(!(state.localAllocations??[]).some((a:any)=>a.scopeId===scope.id&&!['released','consumed'].includes(a.status)),'resources_not_returned','Najpierw potwierdź zwrot lub zużycie lokalnych przydziałów.',409);
      scope.revokedAt = now(); scope.revokedBy = user.id; return scope;
    }
    case 'scope.reconcile': {
      requireRole(user, coordinators); const scope = item(state.allocationScopes, payload.scopeId) as any;
      must(payload.physicalConfirmed === true, 'physical_confirmation_required', 'Pula wymaga fizycznego uzgodnienia z dysponentem.');
      must(scope.resourceIds.every((id:string)=>!state.model.resources.find((r:any)=>r.id===id)?.reconciliationRequired), 'resource_unreconciled', 'Najpierw uzgodnij zasoby należące do puli.', 409);
      if (payload.remainsActive) {
        must(!scope.revokedAt && Date.parse(scope.validUntil)>Date.now() && store.users(user.organizationId).some(u=>u.id===scope.authorizedUserId&&u.active&&workers.includes(u.role)), 'scope_expired', 'Nie można przywrócić wygasłego lub cofniętego upoważnienia.', 409);
      } else { must(!(state.localAllocations??[]).some((a:any)=>a.scopeId===scope.id&&!['released','consumed'].includes(a.status)),'resources_not_returned','Najpierw uzgodnij fizyczny zwrot lokalnych przydziałów.',409); scope.revokedAt = now(); scope.revokedBy = user.id; }
      scope.reconciliationRequired = false; scope.reconciledAt = now(); scope.reconciledBy = user.id; return scope;
    }
    case 'local.plan': {
      requireRole(user, workers); const scope = item(state.allocationScopes, payload.scopeId) as any;
      must(!state.recovery.isolated && state.recovery.accountsReviewed && state.recovery.resourcesReconciled && !scope.reconciliationRequired, 'recovery_blocked', 'Lokalna pula po odtworzeniu wymaga osobnego uzgodnienia.', 409);
      must(scope.authorizedUserId === user.id && scope.allowLocalReplanning && !scope.revokedAt, 'scope_forbidden', 'Brak upoważnienia do lokalnego przeliczenia.', 403);
      const approvedAt = date(payload.approvedLocallyAt ?? now());
      must(Date.parse(approvedAt) >= Date.parse(scope.validFrom) && Date.parse(approvedAt) <= Date.parse(scope.validUntil) && Date.parse(scope.validUntil) > Date.now() && Date.parse(approvedAt) <= Date.now() + 60000, 'scope_expired', 'Ważność upoważnienia wymaga ponownego uzgodnienia.', 409);
      must(Date.parse(approvedAt)+2000>=Date.parse(scope.approvedAt??scope.validFrom),'before_scope_grant','Lokalna decyzja nie może poprzedzać przyznania puli.',409);
      const localModel = structuredClone(payload.model ?? state.model); const plan = structuredClone(payload.plan);
      must(!state.plans.some(p=>p.id===plan.id),'plan_exists','Plan został już zapisany.',409);
      const incident:any=item(state.incidents,payload.incidentId??state.incidents.find(i=>i.status==='open')?.id);
      must(incident.status==='open','incident_closed','Incydent jest zamknięty.',409);
      must(accelerated(state,incident.id)||Date.parse(plan.referenceTime)+plan.horizonMinutes*60000>Date.now(),'plan_expired','Horyzont lokalnego planu już upłynął.',409);
      for (const key of Object.keys(state.model)) if (!['resources','reservations'].includes(key)) must(canonical(localModel[key]) === canonical(state.model[key]), 'local_model_scope', 'Lokalny plan nie może zmieniać usług, priorytetów ani procedur.', 403);
      must(localModel.resources.length === state.model.resources.length, 'local_model_scope', 'Lokalna pula nie może dodawać zasobów.', 403);
      for (const resource of state.model.resources) {
        const local = localModel.resources.find((r: any) => r.id === resource.id); must(local, 'local_model_scope', 'Brak zasobu modelu.', 403);
        if (scope.resourceIds.includes(resource.id)) {
          for (const key of Object.keys(resource)) if (!['state','confidence','quantity'].includes(key)) must(canonical(local[key]) === canonical(resource[key]), 'local_model_scope', 'Zmiana przekracza lokalne upoważnienie.', 403);
          must(local.quantity <= resource.quantity, 'local_resource_increase', 'Lokalny plan nie może zwiększać przyznanej puli.', 409);
          if (resource.state !== 'available' || resource.confidence !== 'confirmed') must(local.state !== 'available' || local.confidence !== 'confirmed', 'unconfirmed_resource', 'Niepotwierdzony zasób wymaga oceny koordynatora.', 409);
        } else must(canonical(local) === canonical(resource), 'local_model_scope', 'Zasób jest poza lokalną pulą.', 403);
      }
      must(plan && plan.actions.every((a: any) => scope.modeIds.includes(a.modeId) && a.allocations.every((r: any) => scope.resourceIds.includes(r.resourceId))), 'scope_exceeded', 'Plan wykracza poza lokalną pulę.', 403);
      const previousActions=state.actions.filter(a=>a.scopeId===scope.id&&a.status!=='cancelled');
      must(!previousActions.some(a=>a.status==='started'||a.status==='completed'&&allAllocations(state).some(r=>r.actionId===a.id&&!['released','consumed'].includes(r.status))),'local_resource_busy','Poprzednia lokalna czynność trwa albo jej zasoby nie zostały fizycznie zwrócone.',409);
      const replaceable=new Set(previousActions.filter(a=>['approved','accepted'].includes(a.status)).map(a=>a.id));
      localModel.reservations = allAllocations(state).filter(a => !replaceable.has(a.actionId)&&!['released','consumed'].includes(a.status));
      must(['optimal','feasible'].includes(plan.status) && !plan.conditional && !plan.assumptions.length, 'conditional_plan', 'Lokalna decyzja wymaga potwierdzonych przesłanek.', 409);
      const validation = validatePlan(localModel, plan); must(validation.valid, 'invalid_plan', 'Lokalny plan nie przeszedł walidacji.', 409);
      plan.validation=validation;
      plan.diagnostics=[...new Set([...plan.diagnostics,...validation.warnings.filter(warning=>warning.code==='fragment_excluded').map(warning=>warning.message)])];
      for(const action of previousActions.filter(a=>replaceable.has(a.id))) {action.status='cancelled';action.needsReview=true;action.reviewReason='Nowy plan w tej samej lokalnej puli zastąpił nierozpoczęte zadanie.';action.version++;const old=state.plans.find(p=>p.id===action.planId);if(old)old.approvalStatus='needs_review';}
      state.localAllocations??=[]; for(const allocation of state.localAllocations.filter((a:any)=>replaceable.has(a.actionId))) {allocation.status='released';allocation.releaseReason='superseded_before_start';allocation.releaseConfirmedAt=now();}
      plan.approvalStatus='approved'; plan.scopeId=scope.id; plan.localScopeId=scope.id; plan.incidentId=incident.id; plan.localModel=localModel; plan.modelSnapshot=structuredClone(localModel); plan.local=true; plan.sharedReservationCreated=false; plan.approvedBy=user.id; plan.approvedAt=now(); plan.approvedLocallyAt=approvedAt; plan.executionClock=executionClock(state,incident.id);
      for(const action of plan.actions) {
        action.status='approved';
        const actionId=`${plan.id}:${action.id}`;
        state.actions.push({...action,id:actionId,sourceActionId:action.id,planId:plan.id,incidentId:incident.id,scopeId:scope.id,ownerId:scope.authorizedUserId,version:1,needsReview:false,local:true,executionClock:plan.executionClock});
        for(const allocation of action.allocations) state.localAllocations.push({...allocation,id:randomUUID(),planId:plan.id,actionId,scopeId:scope.id,status:'reserved',global:false});
      }
      state.plans.push(plan);
      const proposal = { id: randomUUID(), plan, scopeId: scope.id, authorId: user.id, approvedLocallyAt: approvedAt, receivedAt: now(), status: 'reconciled_in_scope', sharedReservationCreated: false, validation };
      state.localProposals ??= []; state.localProposals.push(proposal); return proposal;
    }
    case 'recovery.review_accounts': { requireRole(user, ['administrator']); must(payload.confirmed === true, 'confirmation_required', 'Potwierdź przegląd kont i ról.'); state.recovery.accountsReviewed = true; return state.recovery; }
    case 'recovery.promote': { requireRole(user, ['administrator']); must(payload.oldAuthorityDisabled === true && state.recovery.accountsReviewed && state.recovery.resourcesReconciled && state.allocationScopes.every(s=>s.revokedAt||!s.reconciliationRequired), 'recovery_blocked', 'Wyłącz stary autorytet, przejrzyj konta i uzgodnij zasoby oraz lokalne pule.', 409); state.recovery.isolated = false; return state.recovery; }
    default: throw new DomainError('unknown_command', 'Nieznany typ komendy.');
  }
}

function executeCommandAtomic(store: Store, user: User, command: Command) {
  return store.db.transaction(() => {
    must(command.organizationId === user.organizationId, 'wrong_organization', 'Komenda innej organizacji.', 403);
    const fingerprint = sha256(canonical(command));
    const prior = store.db.prepare('SELECT * FROM commands WHERE organization_id=? AND command_id=?').get(user.organizationId, command.commandId) as any;
    if (prior) { must(prior.user_id === user.id, 'wrong_actor', 'Kolejka należy do innego konta.', 403); must(prior.hash === fingerprint, 'idempotency_mismatch', 'Ten identyfikator komendy ma inną treść.', 409); return { ...JSON.parse(prior.result), replayed: true }; }
    must(command.serverEpoch === store.epoch, 'epoch_changed', 'Serwer został odtworzony. Uzgodnij nowy snapshot, zachowując kolejkę.', 409);
    const row = store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as any;
    must(row?.active, 'account_inactive', 'Konto zostało wyłączone.', 403); user = store.user(row);
    const device = store.db.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').get(command.deviceId, user.id) as any;
    must(!device?.revoked, 'device_revoked', 'Uprawnienie urządzenia zostało cofnięte.', 403);
    for (const dependency of command.dependsOn) {
      const accepted = store.db.prepare('SELECT user_id,result FROM commands WHERE organization_id=? AND command_id=?').get(user.organizationId, dependency) as any;
      must(!accepted || accepted.user_id===user.id, 'wrong_actor', 'Poprzednik kolejki należy do innego konta.', 403);
      if (!accepted || JSON.parse(accepted.result).status !== 'accepted') return { commandId: command.commandId, status: 'waiting', code: 'dependency_pending', message: 'Komenda oczekuje na przyjęcie poprzednika.' };
    }
    const state = store.read(user.organizationId);
    const versionedActionCommand = ['action.accept','action.start','action.complete','verification.create','register.record'].includes(command.type) && Number.isInteger(command.payload?.expectedVersion);
    if(versionedActionCommand) {
      must(command.baseRevision<=state.revision,'revision_conflict','Wersja bazowa nie istnieje na serwerze.',409);
      const action=item(state.actions,command.payload.actionId as string) as any;
      must(action.version===command.payload.expectedVersion,'action_changed','Wersja zadania zmieniła się.',409);
    }
    if (!['observation.create', 'incident.create'].includes(command.type) && !versionedActionCommand && command.baseRevision !== state.revision) {
      const dependencyIds = new Set(command.dependsOn); let expanded = true;
      while (expanded) { expanded = false; for (const id of Array.from(dependencyIds)) { const record = store.db.prepare('SELECT dependencies FROM (SELECT json_extract(result,\'$.dependencies\') AS dependencies FROM commands WHERE organization_id=? AND command_id=? AND user_id=?)').get(user.organizationId, id, user.id) as any; if (record?.dependencies) for (const dependency of JSON.parse(record.dependencies)) if (!dependencyIds.has(dependency)) { dependencyIds.add(dependency); expanded = true; } } }
      const changes = (store.db.prepare('SELECT payload FROM events WHERE organization_id=?').all(user.organizationId) as any[]).map(row => JSON.parse(row.payload)).filter(event => event.revision > command.baseRevision);
      must(changes.length > 0 && changes.every(event => dependencyIds.has(event.commandId)), 'revision_conflict', 'Stan zmienił się. Zachowano propozycję do rozstrzygnięcia.', 409);
    }
    const data = applyMutation(store, state, user, command.type, command.payload);
    state.model.reservations=state.allocations.filter(a=>!['released','consumed'].includes(a.status)); state.model.allocationScopes=state.allocationScopes.filter(scope=>!scope.revokedAt);
    state.revision++; store.save(state);
    const event = store.event(state, user.id, command.type, { commandId: command.commandId, deviceId: command.deviceId, data, revision: state.revision });
    const result = { commandId: command.commandId, status: 'accepted', serverSeq: event.serverSeq, revision: state.revision, dependencies: command.dependsOn, data };
    store.db.prepare('INSERT INTO commands(organization_id,command_id,user_id,device_id,hash,result,created_at) VALUES (?,?,?,?,?,?,?)').run(user.organizationId, command.commandId, user.id, command.deviceId, fingerprint, JSON.stringify(result), now());
    store.db.prepare('INSERT INTO devices(id,user_id,organization_id,last_seen) VALUES (?,?,?,?) ON CONFLICT(id,user_id) DO UPDATE SET last_seen=excluded.last_seen').run(command.deviceId, user.id, user.organizationId, now());
    return result;
  })();
}

export function executeCommand(store: Store, user: User, command: Command) {
  try { return executeCommandAtomic(store, user, command); }
  catch (error) {
    if (error instanceof DomainError && command.organizationId === user.organizationId && !['idempotency_mismatch','wrong_actor'].includes(error.code)) {
      // A rejected decision is also immutable. Resolution is a new command ID.
      store.db.transaction(() => {
        if (store.db.prepare('SELECT command_id FROM commands WHERE organization_id=? AND command_id=?').get(user.organizationId, command.commandId)) return;
        const state = store.read(user.organizationId);
        const event = store.event(state, user.id, 'command.rejected', { commandId: command.commandId, type: command.type, code: error.code });
        const result = { commandId: command.commandId, status: error.statusCode === 409 ? 'conflict' : 'rejected', code: error.code, message: error.message, serverSeq: event.serverSeq, revision: state.revision };
        store.db.prepare('INSERT INTO commands(organization_id,command_id,user_id,device_id,hash,result,created_at) VALUES (?,?,?,?,?,?,?)').run(user.organizationId, command.commandId, user.id, command.deviceId, sha256(canonical(command)), JSON.stringify(result), now());
      })();
    }
    throw error;
  }
}
