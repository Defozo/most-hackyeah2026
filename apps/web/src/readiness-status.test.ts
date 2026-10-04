import { describe, expect, it } from 'vitest';
import { readinessDetails } from './readiness-status';
import type { Snapshot } from './types';

const provenance={source:'Odbiór właściciela, protokół 1',checkedAt:'2026-01-01T00:00:00Z'};
function snapshot():Snapshot{return {model:{services:[{id:'service',name:'Pomoc',provenance}],modes:[{id:'mode',name:'Rejestr',serviceId:'service',setupMinutes:15,level:6,procedureVersion:2,verificationContractId:'contract',provenance}],resources:[],dependencies:[],procedures:[],verificationContracts:[{id:'contract',version:3,provenance}]},readinessTrials:[]} as unknown as Snapshot;}
describe('readiness distinguishes parameter provenance, current evidence and measured discrepancies',()=>{
  it('flags missing sources and missing trials without inventing an expiry threshold',()=>{
    const state=snapshot();state.model.services[0].provenance={checkedAt:'invalid'};
    const details=readinessDetails(state);expect(details.parameterIssues).toHaveLength(1);expect(details.parameterIssues[0].reason).toContain('źródło');expect(details.parameterIssues[0].reason).toContain('data');
    expect(details.modes[0].updates).toContain('Brak odebranej próby na znanym dobrym stanie.');expect(details.modes[0].ready).toBe(false);
    state.model.services[0].provenance=provenance;expect(readinessDetails(state).parameterIssues).toEqual([]);
  });
  it('uses the latest trial and shows exact setup/level discrepancies requiring model approval',()=>{
    const state=snapshot();state.readinessTrials=[{id:'new',modeId:'mode',approvedAt:'2026-10-03T11:00:00Z',current:true,requiresModelReview:true,observedSetupMinutes:20,measuredLevel:4,procedureVersion:2,contractVersion:3},{id:'old',modeId:'mode',approvedAt:'2026-10-03T10:00:00Z',current:true,observedSetupMinutes:15,measuredLevel:6,procedureVersion:2,contractVersion:3}];
    const details=readinessDetails(state);expect(details.latestTrial?.id).toBe('new');expect(details.modes[0].ready).toBe(false);expect(details.modes[0].updates.join(' ')).toContain('model 15 min, zmierzono 20 min');expect(details.modes[0].updates.join(' ')).toContain('model 6, zmierzono 4');
  });
  it('does not mark a historical result or superseded procedure as operationally current',()=>{
    const state=snapshot();state.readinessTrials=[{id:'trial',modeId:'mode',approvedAt:'2026-10-03T11:00:00Z',current:false,observedSetupMinutes:15,measuredLevel:6,procedureVersion:1,contractVersion:2}];
    const result=readinessDetails(state).modes[0];expect(result.ready).toBe(false);expect(result.updates).toHaveLength(3);expect(result.updates.join(' ')).toContain('Procedura zmieniła się z v1 na v2');
    Object.assign(state.readinessTrials[0],{current:true,procedureVersion:2,contractVersion:3});expect(readinessDetails(state).modes[0].ready).toBe(true);
  });
  it('expires a formerly current trial locally after its evidence validity window',()=>{
    const state=snapshot();state.readinessTrials=[{id:'trial',modeId:'mode',approvedAt:'2026-10-03T11:00:00Z',current:true,observedSetupMinutes:15,measuredLevel:6,procedureVersion:2,contractVersion:3,verificationValidUntil:'2026-10-03T12:00:00Z'}];
    expect(readinessDetails(state,Date.parse('2026-10-03T11:59:59Z')).modes[0].ready).toBe(true);
    expect(readinessDetails(state,Date.parse('2026-10-03T12:00:00Z')).modes[0].ready).toBe(false);
    expect(state.readinessTrials[0].current).toBe(true);
  });
  it('never treats a tested but excluded mode as ready for a new plan',()=>{
    const state=snapshot();state.readinessTrials=[{id:'trial',modeId:'mode',approvedAt:'2026-10-03T11:00:00Z',current:true,observedSetupMinutes:15,measuredLevel:6,procedureVersion:2,contractVersion:3}];
    state.modelValidation={valid:true,issues:[],warnings:[],blockedFragments:[{kind:'mode',id:'mode',reasons:['Cykl w wymaganej zależności']} ]};
    const result=readinessDetails(state).modes[0];expect(result.ready).toBe(false);expect(result.excluded).toBe(true);expect(result.updates.join(' ')).toContain('Cykl w wymaganej zależności');
    state.modelValidation={valid:false,issues:[{message:'Brak jednostki'}]};expect(readinessDetails(state).modes[0].ready).toBe(false);
  });
});
