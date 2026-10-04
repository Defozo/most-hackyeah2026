import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, localPlans } from './db';

afterEach(()=>vi.restoreAllMocks());
describe('local plan recovery order',()=>{
  it('selects the newest saved proposal after a cold database read, regardless of UUID order',async()=>{
    const rows=[
      {id:'a-newest',scope:'account',type:'local.plan',payload:{plan:{id:'newest'}},createdAt:'2026-10-03T12:01:00.000Z'},
      {id:'z-older',scope:'account',type:'local.plan',payload:{plan:{id:'older'}},createdAt:'2026-10-03T12:00:00.000Z'},
      {id:'observation',scope:'account',type:'observation.create',payload:{},createdAt:'2026-10-03T12:02:00.000Z'},
    ];
    const equals=vi.fn(()=>({toArray:async()=>rows}));
    const where=vi.spyOn(db.proposals,'where').mockReturnValue({equals} as any);
    const plans=await localPlans('account');
    expect(where).toHaveBeenCalledWith('scope');expect(equals).toHaveBeenCalledWith('account');
    expect(plans.map(row=>row.id)).toEqual(['z-older','a-newest']);
    expect(plans.at(-1)?.payload.plan.id).toBe('newest');
  });
  it('uses a stable tie breaker when saved timestamps are identical',async()=>{
    const rows=['z','a','m'].map(id=>({id,scope:'account',type:'local.plan',payload:{},createdAt:'2026-10-03T12:00:00.000Z'}));
    vi.spyOn(db.proposals,'where').mockReturnValue({equals:()=>({toArray:async()=>rows})} as any);
    expect((await localPlans('account')).map(row=>row.id)).toEqual(['a','m','z']);
    rows.reverse();
    expect((await localPlans('account')).map(row=>row.id)).toEqual(['a','m','z']);
  });
});
