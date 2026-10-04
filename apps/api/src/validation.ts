import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const str = Type.String({ minLength: 1, maxLength: 12000 });
const id = Type.String({ minLength: 1, maxLength: 250 });
const num = Type.Number({ minimum: 0 });
const version = Type.Integer({ minimum: 1 });
const strings = Type.Array(str, { maxItems: 1000 });
const optional = Type.Optional;
const enumeration = (...values: string[]) => Type.Union(values.map(value => Type.Literal(value)));
const availability = enumeration('available','unavailable','unknown');
const confidence = enumeration('confirmed','unverified','rejected','conflicting');
const role = enumeration('administrator','coordinator','owner','operator','observer');
const resourceType = enumeration('person','equipment','consumable','energy');
const provenance = Type.Object({ source: str, checkedAt: str, synthetic: optional(Type.Boolean()), evidenceIds: optional(strings) });
const requirement = Type.Object({ id, type: resourceType, quantity: Type.Number({ exclusiveMinimum: 0 }), unit: str, resourceIds: optional(strings), skills: optional(strings), tags: optional(strings), phase: optional(enumeration('setup','operation','both')), consumptionPerMinute: optional(num), setupConsumption: optional(num), requiredCapacity: optional(num), capacityUnit: optional(str) });
const allocation = Type.Object({ resourceId: id, requirementId: id, quantity: Type.Number({ exclusiveMinimum: 0 }), startMinute: num, endMinute: num, consumedQuantity: optional(num), unitIds: optional(strings) });
const array = (schema: TSchema) => Type.Array(schema, { maxItems: 10000 });
export const modelSchema = Type.Object({
  schemaVersion: Type.Literal(1), id, organizationId: id, revision: version, name: str, synthetic: Type.Boolean(), referenceTime: str,
  horizonMinutes: Type.Number({ exclusiveMinimum: 0 }), stepMinutes: Type.Number({ exclusiveMinimum: 0 }),
  services: array(Type.Object({ id, name: str, outcome: str, unit: str, minimum: Type.Number({ exclusiveMinimum: 0 }), priority: version, weight: Type.Number({ exclusiveMinimum: 0 }), toleratedOutageMinutes: num, hardDeadlineMinute: optional(num), ownerId: id, deputyId: optional(id), location: str, version, provenance: optional(provenance) })),
  modes: array(Type.Object({ id, serviceId: id, name: str, level: num, dependencyId: optional(id), setupMinutes: num, autonomyMinutes: optional(num), requirements: array(requirement), procedureId: id, procedureVersion: version, approved: Type.Boolean(), verificationContractId: id, predecessors: optional(strings), location: optional(str), provenance: optional(provenance) })),
  resources: array(Type.Object({ id, name: str, type: resourceType, unit: str, quantity: num, state: availability, confidence, location: str, skills: strings, tags: strings, capacity: optional(num), capacityUnit: optional(str), availableFromMinute: optional(num), availableUntilMinute: optional(num), occupied: optional(Type.Boolean()), physicalReleaseConfirmed: optional(Type.Boolean()), reconciliationRequired: optional(Type.Boolean()), provenance, dependencyId: optional(id) })),
  dependencies: array(Type.Object({ id, name: str, kind: enumeration('leaf','and','or'), inputs: strings, state: optional(availability), confidence: optional(confidence), commonCauseId: optional(id), availableFromMinute: optional(num), availableUntilMinute: optional(num), provenance: optional(provenance), version: optional(version) })),
  procedures: array(Type.Object({ id, version, title: str, approved: Type.Boolean(), approvedBy: optional(id), steps: strings, prerequisites: strings, safetyNote: Type.String({ maxLength: 12000 }), provenance })),
  verificationContracts: array(Type.Object({ id, version, modeId: id, title: str, expectedResult: str, metric: str, minimum: num, unit: str, validityMinutes: Type.Number({ exclusiveMinimum: 0 }), verifierRoles: Type.Array(role, { minItems: 1 }), evidenceRequired: Type.Boolean(), mandatory: Type.Boolean(), simulated: Type.Boolean(), provenance: optional(provenance) })),
  reservations: array(Type.Object({ id, resourceId: id, planId: id, actionId: optional(id), startMinute: num, endMinute: num, quantity: num, status: enumeration('reserved','in_use','released','consumed'), releaseConfirmedAt: optional(str), consumedQuantity: optional(num), unitIds: optional(strings) })),
  uncertainties: array(Type.Object({ id, subjectId: id, question: str, verificationMinutes: num, contact: str, groupId: optional(id) })),
  travelTimes: array(Type.Object({ from: str, to: str, minutes: num })),
  allocationScopes: array(Type.Object({ id, resourceIds: strings, modeIds: strings, authorizedUserId: id, validFrom: str, validUntil: str, modelRevision: version, allowLocalReplanning: Type.Boolean(), conditions: strings })),
});
export const planSchema = Type.Object({
  id, modelId: id, modelRevision: version, referenceTime: str, horizonMinutes: Type.Number({ exclusiveMinimum: 0 }), stepMinutes: Type.Number({ exclusiveMinimum: 0 }), createdAt: str,
  status: enumeration('optimal','feasible','infeasible','no_solution','invalid_model','cancelled'), approvalStatus: enumeration('draft','approved','needs_review'), conditional: Type.Boolean(),
  assumptions: array(Type.Object({ subjectId: id, state: availability })),
  actions: array(Type.Object({ id, serviceId: id, modeId: id, procedureId: id, procedureVersion: version, startMinute: num, readyMinute: num, endMinute: num, allocations: array(allocation), predecessorIds: strings, ownerId: optional(id), status: enumeration('proposed','approved','accepted','started','completed','blocked','cancelled'), conditions: strings })),
  timeline: array(Type.Object({ serviceId: id, intervals: array(Type.Object({ startMinute: num, endMinute: num, modeId: Type.Union([id, Type.Null()]), level: num, meetsMinimum: Type.Boolean() })), minimumMinutes: num, outageMinutes: num, firstMinimumMinute: Type.Union([num,Type.Null()]), maxOutageMinutes: num, toleranceExceeded: Type.Boolean() })),
  metrics: Type.Object({ minimumServiceMinutes: num, possibleServiceMinutes: num, outageServiceMinutes: num, simultaneousMinimumFromMinute: Type.Union([num,Type.Null()]), byPriority: Type.Record(Type.String(),num), normalizedShortfall: num, switches: num }),
  validation: Type.Object({ valid: Type.Boolean(), issues: array(Type.Object({code:str,message:str})), warnings: array(Type.Object({code:str,message:str})), blockedFragments: optional(array(Type.Object({kind:enumeration('dependency','mode','resource'),id,reasons:strings}))) }), diagnostics: strings,
  solver: Type.Object({name:Type.Literal('HiGHS'), stages:array(Type.Object({name:str,status:str,elapsedMs:num,objective:optional(Type.Number())})),budgetMs:num,timings:Type.Object({initializationMs:num,buildMs:num,solveMs:num,validationMs:num,totalMs:num}),completeHierarchy:Type.Boolean()}), analysisScope: strings,
});
export function schemaIssues(schema: TSchema, input: unknown) {
  const issues:{code:string;message:string}[]=[];
  for(const error of Value.Errors(schema,input)){issues.push({code:'schema',message:`${error.path||'/'}: ${error.message}`});if(issues.length>=20)break;}
  const dates = new Set(['checkedAt','referenceTime','createdAt','observedAt','expiresAt','validUntil','validFrom','approvedLocallyAt']);
  function inspect(value:any,path='',depth=0) { if (!value || typeof value!=='object'||issues.length>=20) return; if(depth>32){issues.push({code:'schema',message:'Przekroczono dopuszczalną głębokość danych.'});return;} for (const [key,child] of Object.entries(value)) { if (dates.has(key) && child!==undefined && (typeof child!=='string'||!Number.isFinite(Date.parse(child)))) issues.push({code:'date',message:`${path}/${key}: Nieprawidłowa data.`}); if (child && typeof child==='object') inspect(child,`${path}/${key}`,depth+1); } }
  if (!issues.length) inspect(input); return issues.slice(0,20);
}
export function modelProvenanceIssues(input: any) {
  const complete=(value:any)=>typeof value?.source==='string'&&value.source.trim()&&typeof value.checkedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value.checkedAt)&&Number.isFinite(Date.parse(value.checkedAt));
  return ['services','modes','resources','dependencies','procedures','verificationContracts'].flatMap(collection => (Array.isArray(input?.[collection]) ? input[collection] : []).filter((entry:any) => !complete(entry?.provenance)).map((entry:any) => ({code:'provenance_missing',subjectId:entry?.id,collection,message:`${collection}/${entry?.id}: uzupełnij rzeczywiste źródło parametrów oraz datę sprawdzenia.`})));
}
export function modelStructureIssues(input: unknown, requireProvenance = false) { const issues=schemaIssues(modelSchema, input); return issues.length || !requireProvenance ? issues : modelProvenanceIssues(input); }
export function planStructureIssues(input: unknown) { return schemaIssues(planSchema, input); }

const action = { actionId: id, expectedVersion: optional(version), checkedConditions: optional(Type.Boolean()), performedAt: optional(str), notes: optional(Type.String({maxLength:12000})) };
const scope = Type.Object({id:optional(id),resourceIds:Type.Array(id,{minItems:1,uniqueItems:true}),modeIds:Type.Array(id,{minItems:1,uniqueItems:true}),authorizedUserId:id,validFrom:str,validUntil:str,allowLocalReplanning:Type.Boolean(),conditions:strings});
const payloadSchemas: Record<string, TSchema> = {
  'incident.create': Type.Object({id:optional(id),name:optional(str),title:optional(str),kind:optional(enumeration('exercise','incident')),exercise:optional(Type.Boolean())}),
  'incident.close': Type.Object({incidentId:id}),
  'observation.create': Type.Object({id:optional(id),incidentId:optional(id),original:optional(str),text:optional(str),subjectId:optional(id),observedState:optional(availability),claimedState:optional(availability),source:str,observedAt:str,expiresAt:optional(str),validUntil:optional(str),evidenceIds:optional(Type.Array(Type.String({pattern:'^[a-f0-9]{64}$'}),{maxItems:20})),kind:optional(enumeration('observation','instruction'))}),
  'observation.attach': Type.Object({observationId:id,evidenceIds:Type.Array(Type.String({pattern:'^[a-f0-9]{64}$'}),{minItems:1,maxItems:20,uniqueItems:true})}),
  'assessment.create': Type.Object({subjectId:id,state:availability,observationIds:Type.Array(id,{minItems:1,maxItems:100}),reason:optional(Type.String({maxLength:12000})),incidentId:optional(id)}),
  'model.replace': Type.Object({model:modelSchema}),
  'plan.approve': Type.Object({plan:planSchema,incidentId:id,assignments:optional(Type.Record(Type.String(),id))}),
  'action.accept':Type.Object(action),'action.start':Type.Object(action),'action.complete':Type.Object(action),'action.revalidate':Type.Object(action),
  'verification.create':Type.Object({actionId:id,expectedVersion:optional(version),outcome:enumeration('passed','failed','unknown','skipped'),measuredValue:optional(num),measurement:optional(num),evidenceIds:optional(Type.Array(Type.String({pattern:'^[a-f0-9]{64}$'}),{maxItems:20})),observedAt:optional(str),notes:optional(Type.String({maxLength:12000}))}),
  'register.record':Type.Object({actionId:id,expectedVersion:optional(version),evidenceId:Type.String({pattern:'^[a-f0-9]{64}$'})}),
  'resource.release':Type.Object({resourceId:id,physicalConfirmed:Type.Boolean()}),
  'resource.update':Type.Object({resourceId:id,state:optional(availability),confidence:optional(confidence),quantity:optional(num)}),
  'resource.reconcile':Type.Object({resourceId:id,state:optional(availability),confidence:optional(confidence),quantity:optional(num),physicalConfirmed:Type.Boolean(),occupied:Type.Boolean()}),
  'scope.create':scope,'scope.release':Type.Object({scopeId:id,physicalConfirmed:Type.Boolean()}),'scope.reconcile':Type.Object({scopeId:id,physicalConfirmed:Type.Boolean(),remainsActive:Type.Boolean()}),
  'local.plan':Type.Object({scopeId:id,plan:planSchema,model:optional(modelSchema),approvedLocallyAt:optional(str)}),
  'recovery.review_accounts':Type.Object({confirmed:Type.Boolean()}),'recovery.promote':Type.Object({oldAuthorityDisabled:Type.Boolean()}),
  'readiness.trial':Type.Object({serviceId:id,modeId:id,verificationId:id,knownGoodConfirmed:Type.Literal(true),preparationMinutes:num,observedSetupMinutes:num,measuredLevel:num,notes:Type.String({maxLength:12000}),source:str}),
};
export function commandPayloadIssues(type: string, payload: unknown) { const issues=payloadSchemas[type] ? schemaIssues(payloadSchemas[type], payload) : []; return !issues.length&&type==='model.replace' ? modelProvenanceIssues((payload as any).model) : issues; }
