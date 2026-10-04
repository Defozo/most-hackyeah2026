import { arr, type Outbox, type Snapshot } from './types';

/** Canonical snapshot stays unchanged on disk; queued facts are visibly projected. */
export function projectSnapshot(snapshot: Snapshot, queue: Outbox[]): Snapshot {
  const projected = structuredClone(snapshot);
  for (const row of queue) {
    if (!['pending','waiting'].includes(row.status) || row.result?.resolvedAt || row.command.serverEpoch !== snapshot.serverEpoch) continue;
    const {type,payload} = row.command;
    if (type === 'local.plan' && !projected.plans.some(p=>p.id===payload.plan?.id)) {
      const scope = arr(snapshot.allocationScopes).find(s=>s.id===payload.scopeId);
      if (!scope) continue;
      for(const previous of projected.actions.filter(a=>a.scopeId===scope.id&&['approved','accepted'].includes(a.status)))previous.status='cancelled';
      const plan = {...payload.plan,approvalStatus:'approved',scopeId:payload.scopeId,localScopeId:payload.scopeId,incidentId:payload.incidentId,localModel:payload.model,local:true,pendingSync:true,localCommandId:row.commandId};
      projected.plans.push(plan);
      projected.localAllocations ??= [];
      for (const action of arr(plan.actions)) {
        const actionId=`${plan.id}:${action.id}`;
        projected.actions.push({...action,id:actionId,sourceActionId:action.id,planId:plan.id,incidentId:payload.incidentId,ownerId:scope.authorizedUserId,scopeId:scope.id,version:1,status:'approved',local:true,pendingSync:true,localCommandId:row.commandId});
        projected.localAllocations.push(...arr(action.allocations).map(a=>({...a,actionId,planId:plan.id,scopeId:scope.id,status:'reserved',local:true})));
      }
    }
    if (['action.accept','action.start','action.complete'].includes(type)) {
      const action = projected.actions.find(a => a.id === payload.actionId);
      if (!action) continue;
      // A snapshot saved just before a lost response may already include this step.
      if(payload.expectedVersion!==undefined&&action.version!==payload.expectedVersion)continue;
      action.status = {'action.accept':'accepted','action.start':'started','action.complete':'completed'}[type];
      action.version = (action.version || 1) + 1;
      action.local = true; action.pendingSync = true; action.localCommandId = row.commandId;
      if (type === 'action.start') {
        action.startedAt=payload.performedAt||row.createdAt;
        for(const allocation of [...projected.allocations,...arr(projected.localAllocations)].filter(a=>a.actionId===action.id))allocation.status='in_use';
      }
      if (type === 'action.complete') action.completedAt = payload.performedAt||row.createdAt;
    }
    if (type === 'verification.create'&&!projected.verifications.some(v=>v.actionId===payload.actionId&&v.observedAt===payload.observedAt&&v.outcome===payload.outcome)) projected.verifications.push({...payload,id:row.commandId,local:true,validUntil:new Date(Date.parse(payload.observedAt||row.createdAt)+(arr(snapshot.model.verificationContracts).find(c=>c.id===payload.contractId)?.validityMinutes||0)*60000).toISOString()});
    if(type==='resource.release') {
      const resource=arr(projected.model.resources).find(r=>r.id===payload.resourceId);
      if(resource){resource.occupied=false;resource.physicalReleaseConfirmed=true;resource.localRelease=true;}
      for(const allocation of [...projected.allocations,...arr(projected.localAllocations)].filter(a=>a.resourceId===payload.resourceId))allocation.status='released';
      for(const verification of projected.verifications)if(projected.actions.some(a=>a.id===verification.actionId&&arr(a.allocations).some(r=>r.resourceId===payload.resourceId))){verification.current=false;verification.invalidatedAt=row.createdAt;verification.invalidationReason='Lokalnie potwierdzono zwrot sprzętu.';}
    }
  }
  return projected;
}

export function actionDependencies(queue: Outbox[], actionId: string) {
  return queue.filter(q => (q.command.payload.actionId === actionId || q.command.type==='local.plan' && actionId.startsWith(`${q.command.payload.plan?.id}:`)) && !q.result?.resolvedAt && ['pending','waiting'].includes(q.status)).map(q => q.commandId);
}
