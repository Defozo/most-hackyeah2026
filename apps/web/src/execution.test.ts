import { describe,expect,it } from 'vitest';
import { anchoredExecutionTime,executionTimingIssue } from './execution';
import type { Account,Entity } from './types';
const origin=Date.parse('2030-01-01T12:00:00Z'),minute=(n:number)=>origin+n*60000;
const plan={referenceTime:new Date(origin).toISOString(),stepMinutes:5};
const action={id:'plan:b',planId:'plan',startMinute:10,readyMinute:20,endMinute:60,predecessorIds:[],startedAt:new Date(minute(12)).toISOString()};
const model={synthetic:false,stepMinutes:5};
const issue=(type:string,at:number,value:Entity=action,actions:Entity[]=[],synthetic=false,kind='incident')=>executionTimingIssue(type,value,plan,actions,{...model,synthetic},{kind},minute(at));
describe('offline physical execution follows the approved schedule',()=>{
  it('blocks an early start and a start leaving no time for service, allows a valid window',()=>{
    expect(issue('start',9)).toContain('czas rozpoczęcia');expect(issue('start',50)).toContain('Pozostały czas');expect(issue('start',10)).toBeNull();
  });
  it('measures setup from actual start, including delayed starts',()=>{
    expect(issue('complete',20)).toContain('czas przygotowania');expect(issue('complete',22)).toBeNull();
  });
  it('requires a completed predecessor and the actual time gap after it',()=>{
    const dependent={...action,predecessorIds:['a']},previous={id:'plan:a',sourceActionId:'a',planId:'plan',status:'completed',completedAt:new Date(minute(17)).toISOString()};
    expect(issue('start',20,dependent,[])).toContain('poprzednie czynności');expect(issue('start',20,dependent,[previous])).toContain('odstęp');expect(issue('start',22,dependent,[previous])).toBeNull();
  });
  it('accelerates only synthetic exercises and still respects predecessor completion',()=>{
    expect(issue('start',0,action,[],true,'exercise')).toBeNull();expect(issue('complete',0,action,[],true,'exercise')).toBeNull();
    expect(issue('start',0,action,[],false,'exercise')).not.toBeNull();expect(issue('start',0,action,[],true,'incident')).not.toBeNull();
    expect(issue('start',0,{...action,predecessorIds:['a']},[],true,'exercise')).toContain('poprzednie czynności');
  });
  it('anchors wall time to the last server response and rejects a rolled-back clock',()=>{
    const account={lastServerTime:origin,lastLocalTime:100000,lastObservedLocalTime:110000} as Account;
    expect(anchoredExecutionTime(account,120000)).toBe(origin+20000);expect(()=>anchoredExecutionTime(account,0)).toThrow('niepewny');
  });
});
