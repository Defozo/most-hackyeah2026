import type { Availability, DomainModel, Resource, ResourceRequirement, ValidationIssue, ValidationResult } from '../../contracts/src/index.js';
import { evaluateDependencies } from './dependencies.js';
import { blockedModelFragments } from './fragments.js';
export function resourceMatches(resource: Resource, requirement: ResourceRequirement): boolean {
  return resource.type === requirement.type && resource.unit === requirement.unit && (!requirement.resourceIds?.length || requirement.resourceIds.includes(resource.id)) && (requirement.skills ?? []).every(s => resource.skills.includes(s)) && (requirement.tags ?? []).every(t => resource.tags.includes(t)) && (requirement.requiredCapacity === undefined || resource.capacityUnit === requirement.capacityUnit && (resource.capacity ?? 0) >= requirement.requiredCapacity);
}
export function travelMinutes(model: DomainModel, from: string, to: string): number { return from === to ? 0 : model.travelTimes.find(t => t.from === from && t.to === to)?.minutes ?? Infinity; }
export function availableQuantity(model: DomainModel, resource: Resource, minute: number, assumptions: Record<string, Availability> = {}, excludePlanId?: string): number {
  if (resource.reconciliationRequired || ((Object.hasOwn(assumptions,resource.id) ? assumptions[resource.id] : undefined) ?? (resource.confidence === 'confirmed' ? resource.state : 'unknown')) !== 'available' || resource.occupied && !resource.physicalReleaseConfirmed || minute < (resource.availableFromMinute ?? 0) || minute + model.stepMinutes > (resource.availableUntilMinute ?? Infinity)) return 0;
  if(resource.dependencyId&&(evaluateDependencies(model,minute,assumptions).states[resource.dependencyId]!=='available'||evaluateDependencies(model,minute+model.stepMinutes-1e-7,assumptions).states[resource.dependencyId]!=='available'))return 0;
  const reservations = model.reservations.filter(r => r.resourceId === resource.id && r.planId !== excludePlanId && r.status !== 'released' && r.status !== 'consumed');
  const relevant=reservations.filter(r=>resource.type==='consumable'||resource.type==='energy'||r.status==='in_use'&&!r.releaseConfirmedAt||minute>=r.startMinute);
  const reserved=resource.type==='consumable'||resource.type==='energy'?relevant.reduce((sum,r)=>sum+r.quantity,0):new Set(relevant.flatMap(r=>r.unitIds??[])).size+relevant.filter(r=>r.unitIds===undefined).reduce((sum,r)=>sum+r.quantity,0);
  return Math.max(0, Math.floor((resource.quantity - reserved) * 1000 + 1e-8) / 1000);
}
/** Stable identities for interchangeable renewable units in one inventory group. */
export function resourceUnitNumber(resource:Resource,id:string):number|null{
  const prefix=`${resource.id}#`;if(typeof id!=='string'||!id.startsWith(prefix))return null;
  const suffix=id.slice(prefix.length),number=Number(suffix);
  return /^[1-9]\d*$/.test(suffix)&&Number.isSafeInteger(number)&&number<=Math.floor(resource.quantity)?number:null;
}
export function unitAvailable(model:DomainModel,resource:Resource,id:string,minute:number,assumptions:Record<string,Availability>={},excludePlanId?:string):boolean{
  const number=resourceUnitNumber(resource,id);if(number===null)return false;
  const quantity=Math.floor(availableQuantity(model,resource,minute,assumptions,excludePlanId));if(quantity<1)return false;
  const held=new Set(model.reservations.filter(r=>r.resourceId===resource.id&&r.planId!==excludePlanId&&!['released','consumed'].includes(r.status)&&(r.status==='in_use'&&!r.releaseConfirmedAt||minute>=r.startMinute)).flatMap(r=>r.unitIds??[]));
  if(held.has(id))return false;
  // Legacy reservations have only a quantity. Conservatively reserve the highest
  // remaining slots, keeping their treatment stable across every interval.
  const heldBefore=[...held].filter(unit=>{const n=resourceUnitNumber(resource,unit);return n!==null&&n<number;}).length;
  return number-heldBefore<=quantity;
}
/** Each consumable resource is an identified stock batch. A confirmed future batch can be consumed only after arrival. */
export function stockQuantity(model: DomainModel, resource: Resource, assumptions: Record<string, Availability> = {}, excludePlanId?: string): number {
  const firstUsableMinute = Math.ceil(Math.max(0,resource.availableFromMinute ?? 0) / model.stepMinutes) * model.stepMinutes;
  return firstUsableMinute >= model.horizonMinutes ? 0 : availableQuantity(model,resource,firstUsableMinute,assumptions,excludePlanId);
}
export function validateModel(model: DomainModel): ValidationResult {
  const issues: ValidationIssue[] = [], warnings: ValidationIssue[] = [];
  const issue = (code: string, message: string, subjectId?: string) => issues.push({ code, message, subjectId });
  if (!model || !Array.isArray(model.services) || !Array.isArray(model.modes) || !Array.isArray(model.resources) || !Array.isArray(model.dependencies) || !Array.isArray(model.procedures) || !Array.isArray(model.verificationContracts) || !Array.isArray(model.reservations) || !Array.isArray(model.travelTimes) || !Array.isArray(model.uncertainties) || !Array.isArray(model.allocationScopes)) return { valid: false, issues: [{ code: 'schema', message: 'Model nie zawiera wszystkich wymaganych kolekcji.' }], warnings };
  if ([...model.uncertainties,...model.allocationScopes].some(x => !x || typeof x !== 'object')) return { valid: false, issues: [{ code: 'schema', message: 'Niepoprawna struktura pytań lub lokalnych upoważnień.' }], warnings };
  if ([...model.services,...model.modes,...model.resources,...model.dependencies,...model.procedures,...model.verificationContracts,...model.reservations,...model.travelTimes].some(x => !x || typeof x !== 'object') || model.modes.some(m => !Array.isArray(m.requirements) || m.requirements.some(r => !r || typeof r !== 'object' || ['resourceIds','skills','tags'].some(key => (r as any)[key] !== undefined && !Array.isArray((r as any)[key]))) || m.predecessors !== undefined && !Array.isArray(m.predecessors)) || model.dependencies.some(d => !Array.isArray(d.inputs)) || model.resources.some(r => !Array.isArray(r.tags) || !Array.isArray(r.skills))) return { valid: false, issues: [{ code: 'schema', message: 'Niepoprawna struktura obiektu lub zapotrzebowań.' }], warnings };
  if (model.schemaVersion !== 1) issue('schema_version', 'Nieobsługiwana wersja schematu.');
  if (typeof model.id !== 'string' || !model.id || typeof model.organizationId !== 'string' || !model.organizationId || !Number.isInteger(model.revision) || model.revision < 1 || typeof model.synthetic !== 'boolean') issue('model_identity', 'Model wymaga tożsamości, organizacji, wersji i jawnego trybu danych.');
  if (!Number.isFinite(model.horizonMinutes) || !Number.isFinite(model.stepMinutes) || model.stepMinutes <= 0 || model.horizonMinutes <= 0 || model.horizonMinutes % model.stepMinutes !== 0) issue('time_grid', 'Horyzont musi być dodatnią wielokrotnością kroku.');
  if (!Number.isFinite(Date.parse(model.referenceTime))) issue('reference_time', 'Brak poprawnego czasu odniesienia.');
  for (const [name, collection] of Object.entries({ services: model.services, modes: model.modes, resources: model.resources, dependencies: model.dependencies, procedures: model.procedures, contracts: model.verificationContracts })) {
    const ids = new Set<string>(); for (const entry of collection) { if (typeof entry.id!=='string' || !entry.id || ids.has(entry.id)) issue('duplicate_id', `Brak ID lub duplikat w ${name}: ${entry.id}`, entry.id); ids.add(entry.id); }
  }
  for (const service of model.services) {
    if (!service.ownerId || !service.unit || !service.location) issue('missing_owner', 'Usługa wymaga właściciela, jednostki i lokalizacji.', service.id);
    if (!Number.isFinite(service.minimum) || service.minimum <= 0 || !Number.isInteger(service.priority) || service.priority < 1 || !Number.isFinite(service.weight) || service.weight <= 0 || !Number.isFinite(service.toleratedOutageMinutes) || service.toleratedOutageMinutes < 0 || service.hardDeadlineMinute !== undefined && (!Number.isFinite(service.hardDeadlineMinute) || service.hardDeadlineMinute < 0)) issue('service_parameter', 'Niepoprawne minimum, priorytet, waga, termin lub tolerancja usługi.', service.id);
  }
  for (const resource of model.resources) {
    if (!Number.isFinite(resource.quantity) || resource.quantity < 0 || !resource.unit || !Array.isArray(resource.skills) || !Array.isArray(resource.tags) || !resource.provenance?.source || !resource.provenance?.checkedAt) issue('resource_parameter', 'Zasób wymaga ilości, jednostki, kompetencji i źródła.', resource.id);
    if (resource.type === 'person' && resource.quantity !== 1) issue('person_identity', 'Każda osoba musi mieć własną tożsamość i ilość 1.', resource.id);
    if (resource.capacity !== undefined && (!Number.isFinite(resource.capacity) || resource.capacity < 0 || !resource.capacityUnit)) issue('capacity_parameter', 'Moc lub pojemność wymaga poprawnej wartości i jednostki.', resource.id);
    if (!['available','unavailable','unknown'].includes(resource.state) || !['confirmed','unverified','rejected','conflicting'].includes(resource.confidence)) issue('resource_state', 'Niepoprawny stan dostępności lub potwierdzenia.', resource.id);
    if (!['person','equipment','consumable','energy'].includes(resource.type) || !resource.location) issue('resource_type', 'Zasób wymaga poprawnego typu i lokalizacji.', resource.id);
    for (const minute of [resource.availableFromMinute,resource.availableUntilMinute]) if (minute !== undefined && !Number.isFinite(minute)) issue('resource_time', 'Niepoprawny czas dostępności zasobu.', resource.id);
    if(resource.dependencyId&&!model.dependencies.some(d=>d.id===resource.dependencyId))issue('missing_resource_dependency','Zasób wskazuje nieistniejącą zależność lub wspólną przyczynę.',resource.id);
  }
  for (const mode of model.modes) {
    if (typeof mode.approved !== 'boolean' || !Number.isInteger(mode.procedureVersion) || mode.procedureVersion < 1) issue('mode_approval', 'Tryb wymaga jawnego zatwierdzenia i wersji procedury.', mode.id);
    if (!model.services.some(s => s.id === mode.serviceId)) issue('missing_service', 'Tryb wskazuje brakującą usługę.', mode.id);
    if (!Number.isFinite(mode.setupMinutes) || mode.setupMinutes < 0 || !Number.isFinite(mode.level) || mode.level < 0 || mode.autonomyMinutes !== undefined && (!Number.isFinite(mode.autonomyMinutes) || mode.autonomyMinutes < 0)) issue('mode_parameter', 'Brak poprawnego czasu, poziomu lub autonomii.', mode.id);
    if (mode.dependencyId && !model.dependencies.some(d => d.id === mode.dependencyId)) issue('missing_dependency', 'Tryb wskazuje brakującą zależność.', mode.id);
    if (!model.procedures.some(p => p.id === mode.procedureId && p.version === mode.procedureVersion)) issue('missing_procedure', 'Brakuje wskazanej wersji procedury.', mode.id);
    if (!model.verificationContracts.some(c => c.id === mode.verificationContractId && c.modeId === mode.id)) issue('missing_contract', 'Brakuje kontraktu potwierdzenia.', mode.id);
    if (!mode.approved || !model.procedures.find(p => p.id === mode.procedureId)?.approved) warnings.push({ code: 'unapproved_mode', subjectId: mode.id, message: 'Tryb bez zatwierdzenia jest wyłączony z planowania.' });
    const reqIds = new Set<string>();
    for (const req of mode.requirements) { if (reqIds.has(req.id) || !req.id) issue('duplicate_requirement', 'Powtórzony lub brakujący identyfikator zapotrzebowania.', req.id); reqIds.add(req.id); if (!Number.isFinite(req.quantity) || req.quantity <= 0 || !req.unit || !['person','equipment','consumable','energy'].includes(req.type) || ![undefined,'setup','operation','both'].includes(req.phase) || !Number.isFinite(req.consumptionPerMinute ?? 0) || (req.consumptionPerMinute ?? 0) < 0 || !Number.isFinite(req.setupConsumption ?? 0) || (req.setupConsumption ?? 0) < 0 || req.requiredCapacity!==undefined&&(!Number.isFinite(req.requiredCapacity)||req.requiredCapacity<0||!req.capacityUnit)) issue('requirement_parameter', 'Niepoprawne zapotrzebowanie zasobu.', req.id); if ((req.type === 'person' || req.type === 'equipment') && !Number.isInteger(req.quantity)) issue('integer_requirement', 'Obsada i liczba urządzeń wymagają ilości całkowitej.', req.id); }
    for (const id of mode.predecessors ?? []) if (!model.modes.some(m => m.id === id)) issue('missing_predecessor', 'Nie istnieje tryb poprzednika.', id);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) { issue('predecessor_cycle', 'Cykl zależności działań.', id); return; } if (visited.has(id)) return; visiting.add(id); for (const p of model.modes.find(m => m.id === id)?.predecessors ?? []) visit(p); visiting.delete(id); visited.add(id); };
  model.modes.forEach(m => visit(m.id));
  for (const travel of model.travelTimes) if (!Number.isFinite(travel.minutes) || travel.minutes < 0) issue('travel_parameter', 'Czas przejazdu musi być nieujemny.');
  for (const d of model.dependencies) { if (!['and','or','leaf'].includes(d.kind) || d.kind!=='leaf' && !d.inputs.length || d.inputs.some(id=>typeof id!=='string') || d.kind==='leaf' && (d.inputs.length>0 || !['available','unavailable','unknown'].includes(d.state!) || !['confirmed','unverified','rejected','conflicting'].includes(d.confidence!))) issue('dependency_parameter','Zależność wymaga poprawnego typu, wejść i stanu informacji.',d.id); for(const t of [d.availableFromMinute,d.availableUntilMinute])if(t!==undefined&&!Number.isFinite(t))issue('dependency_time','Niepoprawny czas zależności.',d.id); }
  for (const reservation of model.reservations) if (!model.resources.some(r=>r.id===reservation.resourceId) || !Number.isFinite(reservation.quantity) || reservation.quantity<0 || !Number.isFinite(reservation.startMinute) || !Number.isFinite(reservation.endMinute) || reservation.endMinute <= reservation.startMinute || !['reserved','in_use','released','consumed'].includes(reservation.status) || reservation.consumedQuantity !== undefined && (!Number.isFinite(reservation.consumedQuantity) || reservation.consumedQuantity < 0)) issue('reservation_parameter','Niepoprawny przydział istniejący.',reservation.id);
  for(const reservation of model.reservations)if(reservation.unitIds!==undefined){const resource=model.resources.find(r=>r.id===reservation.resourceId);if(!Array.isArray(reservation.unitIds)||!resource||reservation.unitIds.length!==reservation.quantity||new Set(reservation.unitIds).size!==reservation.unitIds.length||reservation.unitIds.some(id=>resourceUnitNumber(resource,id)===null))issue('reservation_units','Rezerwacja wymaga poprawnych, różnych jednostek zasobu zgodnych z ilością.',reservation.id);}
  const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(v=>typeof v==='string');
  for (const procedure of model.procedures) if (!Number.isInteger(procedure.version) || procedure.version<1 || typeof procedure.approved!=='boolean' || !strings(procedure.steps) || !procedure.steps.length || !strings(procedure.prerequisites) || typeof procedure.safetyNote!=='string' || !procedure.provenance?.source || !Number.isFinite(Date.parse(procedure.provenance?.checkedAt))) issue('procedure_parameter','Procedura wymaga wersji, kroków, warunków, źródła i jawnego zatwierdzenia.',procedure.id);
  for (const contract of model.verificationContracts) if (!Number.isInteger(contract.version) || contract.version<1 || !Number.isFinite(contract.minimum) || contract.minimum<0 || !Number.isFinite(contract.validityMinutes) || contract.validityMinutes<=0 || !strings(contract.verifierRoles) || !contract.verifierRoles.length || contract.verifierRoles.some(role=>!['administrator','coordinator','owner','operator','observer'].includes(role)) || !['evidenceRequired','mandatory','simulated'].every(key=>typeof (contract as any)[key]==='boolean') || !contract.unit || !contract.expectedResult || !contract.metric) issue('contract_parameter','Kontrakt wymaga poprawnego progu, ważności, ról, dowodu i zakresu testu.',contract.id);
  for (const uncertainty of model.uncertainties) if (!uncertainty.id || !uncertainty.subjectId || !Number.isFinite(uncertainty.verificationMinutes) || uncertainty.verificationMinutes<0 || typeof uncertainty.question!=='string' || typeof uncertainty.contact!=='string') issue('uncertainty_parameter','Pytanie wymaga obiektu, treści, kontaktu i poprawnego czasu sprawdzenia.',uncertainty.id);
  for (const scope of model.allocationScopes) if (!scope.id || !scope.authorizedUserId || !strings(scope.resourceIds) || !strings(scope.modeIds) || !strings(scope.conditions) || typeof scope.allowLocalReplanning!=='boolean' || !Number.isInteger(scope.modelRevision) || scope.modelRevision<1 || !Number.isFinite(Date.parse(scope.validFrom)) || !Number.isFinite(Date.parse(scope.validUntil)) || Date.parse(scope.validUntil)<=Date.parse(scope.validFrom)) issue('scope_parameter','Lokalne upoważnienie wymaga poprawnego zakresu, osoby, wersji i ważności.',scope.id);
  for(const entry of [...model.services,...model.modes,...model.dependencies,...model.verificationContracts]){const provenance=entry.provenance;if(!provenance)warnings.push({code:'provenance_missing',subjectId:entry.id,message:'Brak źródła i daty sprawdzenia parametrów. Uzupełnij przed zatwierdzeniem gotowości.'});else if(typeof provenance.source!=='string'||!provenance.source.trim()||typeof provenance.checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(provenance.checkedAt)||!Number.isFinite(Date.parse(provenance.checkedAt)))issue('provenance_parameter','Parametry wymagają niepustego źródła i poprawnej daty ISO sprawdzenia.',entry.id);}
  issues.push(...evaluateDependencies(model).issues);
  const localCodes=new Set(['dependency_cycle','missing_dependency','missing_resource_dependency','predecessor_cycle','missing_predecessor','missing_procedure','missing_contract','mode_parameter','mode_approval','procedure_parameter','contract_parameter']);
  const blockedFragments=blockedModelFragments(model,issues.filter(item=>localCodes.has(item.code)));
  const globalIssues=issues.filter(item=>!localCodes.has(item.code));
  for(const fragment of blockedFragments)warnings.push({code:'fragment_excluded',subjectId:fragment.id,message:`Wyłączony fragment (${fragment.kind}): ${fragment.reasons.join(' ')}`});
  for(const item of issues.filter(item=>localCodes.has(item.code)))if(!blockedFragments.some(fragment=>fragment.id===item.subjectId))warnings.push({code:'fragment_excluded',subjectId:item.subjectId,message:`Wyłączony fragment: ${item.message}`});
  return { valid: globalIssues.length === 0, issues:globalIssues, warnings, blockedFragments };
}
