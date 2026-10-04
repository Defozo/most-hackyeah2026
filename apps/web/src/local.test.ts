import { describe, expect, it } from 'vitest';
import { actionDependencies, projectSnapshot } from './local';
import type { Entity, Outbox, Snapshot } from './types';

function snapshot():Snapshot{return {serverEpoch:'epoch',serverSeq:0,revision:1,organizationId:'org',model:{resources:[{id:'generator',type:'equipment',occupied:true}],verificationContracts:[{id:'test',validityMinutes:60}]},incidents:[],observations:[],assessments:[],plans:[{id:'plan'}],actions:[{id:'plan:action',version:1,status:'approved',planId:'plan',allocations:[{resourceId:'generator'}]}],verifications:[],allocations:[{resourceId:'generator',actionId:'plan:action',status:'reserved'}],allocationScopes:[{id:'scope',authorizedUserId:'operator'}],evidence:[],users:[]};}
function row(type:string,payload:Entity,id=type):Outbox{return {commandId:id,scope:'org:operator',createdAt:'2026-10-03T12:00:00Z',status:'pending',command:{commandId:id,deviceId:'device',organizationId:'org',serverEpoch:'epoch',baseRevision:1,type,payload,schemaVersion:1,dependsOn:[]}};}

describe('account-scoped offline facts projected over canonical snapshot',()=>{
  it('preserves the canonical snapshot while allowing a dependent execution sequence',()=>{
    const original=snapshot();const queue=[row('action.accept',{actionId:'plan:action',expectedVersion:1}),row('action.start',{actionId:'plan:action',expectedVersion:2}),row('action.complete',{actionId:'plan:action',expectedVersion:3})];
    const result=projectSnapshot(original,queue);
    expect(result.actions[0]).toMatchObject({status:'completed',version:4,local:true});
    expect(original.actions[0]).toMatchObject({status:'approved',version:1});
  });
  it('does not project rejected commands or commands from a restored epoch',()=>{
    const rejected={...row('action.start',{actionId:'plan:action',expectedVersion:1}),status:'conflict' as const};
    const old=row('action.complete',{actionId:'plan:action',expectedVersion:1});old.command.serverEpoch='old-epoch';
    expect(projectSnapshot(snapshot(),[rejected,old]).actions[0].status).toBe('approved');
  });
  it('does not increment an action twice after its response was lost',()=>{
    const original=snapshot();original.actions[0]={...original.actions[0],status:'accepted',version:2};
    const result=projectSnapshot(original,[row('action.accept',{actionId:'plan:action',expectedVersion:1}),row('action.start',{actionId:'plan:action',expectedVersion:2})]);
    expect(result.actions[0]).toMatchObject({status:'started',version:3});
  });
  it('keeps the server-anchored physical execution timestamps while commands await synchronization',()=>{
    const original=snapshot();const start='2026-10-03T11:55:00Z',completed='2026-10-03T12:05:00Z';
    const result=projectSnapshot(original,[row('action.start',{actionId:'plan:action',expectedVersion:1,performedAt:start}),row('action.complete',{actionId:'plan:action',expectedVersion:2,performedAt:completed})]);
    expect(result.actions[0]).toMatchObject({startedAt:start,completedAt:completed,pendingSync:true});
  });
  it('projects an executable local pool decision without adding shared reservations',()=>{
    const original=snapshot();const local=row('local.plan',{scopeId:'scope',incidentId:'incident',model:original.model,plan:{id:'local',actions:[{id:'a',allocations:[{resourceId:'generator',quantity:1}]}]}},'local-command');
    const result=projectSnapshot(original,[local]);
    expect(result.actions.at(-1)).toMatchObject({id:'local:a',ownerId:'operator',scopeId:'scope',version:1,status:'approved',local:true});
    expect(result.allocations).toEqual(original.allocations);
    expect(result.localAllocations).toHaveLength(1);
    expect(actionDependencies([local],'local:a')).toEqual(['local-command']);
  });
  it('retains a queued test as a local fact without implying server confirmation',()=>{
    const result=projectSnapshot(snapshot(),[row('verification.create',{actionId:'plan:action',contractId:'test',outcome:'passed',measuredValue:6,observedAt:'2026-10-03T12:00:00Z'})]);
    expect(result.verifications[0]).toMatchObject({local:true,outcome:'passed'});
    expect(result.verifications[0].current).toBeUndefined();
  });
  it('a physical release invalidates the prior confirmation of continued operation',()=>{
    const original=snapshot();original.verifications=[{id:'v',actionId:'plan:action',current:true,outcome:'passed'}];
    const result=projectSnapshot(original,[row('resource.release',{resourceId:'generator',physicalConfirmed:true})]);
    expect(result.allocations[0].status).toBe('released');expect(result.verifications[0].current).toBe(false);
    expect(original.verifications[0].current).toBe(true);
  });
});
