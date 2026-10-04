import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculate, cancelCalculation } from './planner';

class TestWorker {
  static instances:TestWorker[]=[];
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:((event:{message:string})=>void)|null=null;
  request:any;
  terminate=vi.fn();
  constructor(){TestWorker.instances.push(this);}
  postMessage(request:any){this.request=request;}
  emit(data:any){this.onmessage?.({data:{id:this.request.id,...data}});}
  start(){this.emit({event:'solver-start',startedAt:performance.timeOrigin+performance.now()});}
}
const current=()=>TestWorker.instances.at(-1)!;
const incumbent={id:'validated',status:'feasible',validation:{valid:true},solver:{completeHierarchy:false,timings:{solveMs:200}},diagnostics:[]};

describe('real worker deadline and validated result preservation',()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('Worker',TestWorker);TestWorker.instances=[];});
  afterEach(()=>{cancelCalculation();vi.useRealTimers();vi.unstubAllGlobals();});
  it('starts the solver budget after cold initialization, then terminates at the deadline',async()=>{
    const promise=calculate('solve',{}).catch(error=>error);const worker=current();
    await vi.advanceTimersByTimeAsync(12000);expect(worker.terminate).not.toHaveBeenCalled();
    worker.start();await vi.advanceTimersByTimeAsync(4999);expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(worker.terminate).toHaveBeenCalledOnce();expect((await promise).message).toContain('nie jest dowód niewykonalności');
  });
  it('returns only an independently validated incumbent as feasible after interruption',async()=>{
    const promise=calculate('solve',{}, {budgetMs:5000});const worker=current();worker.start();worker.emit({event:'solver-progress',plan:incumbent});
    worker.emit({event:'solver-progress',plan:{id:'invalid',validation:{valid:false}}});await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toMatchObject({id:'validated',status:'feasible',solver:{completeHierarchy:false,interruption:'deadline'}});
  });
  it('does not reset the common budget on another ranking variant',async()=>{
    const promise=calculate('rank',{}, {budgetMs:5000}).catch(error=>error);const worker=current();worker.start();
    await vi.advanceTimersByTimeAsync(4000);worker.start();worker.emit({event:'solver-progress',plan:incumbent});
    await vi.advanceTimersByTimeAsync(1000);expect(worker.terminate).toHaveBeenCalledOnce();expect((await promise).message).toContain('Poprzedni ranking pozostaje widoczny');
  });
  it('preserves a partial ranking and its explicit unexamined questions at the deadline',async()=>{
    const promise=calculate('rank',{});const worker=current();
    worker.emit({event:'ranking-progress',ranking:{items:[],complete:false,unexaminedIds:['question-a','question-b'],scope:[]}});worker.start();
    worker.emit({event:'ranking-progress',ranking:{items:[{id:'question-a',analyzed:true}],complete:false,unexaminedIds:['question-b'],scope:['question-a: available / unavailable']}});
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toMatchObject({items:[{id:'question-a',analyzed:true}],complete:false,unexaminedIds:['question-b'],interruption:'deadline'});
  });
  it('returns an explicit no_solution fallback without claiming infeasibility',async()=>{
    const promise=calculate('solve',{});const worker=current();worker.emit({event:'solver-start',plan:{id:'no-result',status:'no_solution',validation:{valid:false},solver:{timings:{initializationMs:40,buildMs:25}}},startedAt:performance.timeOrigin+performance.now()});
    await vi.advanceTimersByTimeAsync(5000);expect(await promise).toMatchObject({id:'no-result',status:'no_solution',validation:{valid:false},solver:{completeHierarchy:false,interruption:'deadline'}});
  });
  it('honors an explicitly extended budget and clears the deadline after a completed result',async()=>{
    const promise=calculate('solve',{}, {budgetMs:15000});const worker=current();worker.start();await vi.advanceTimersByTimeAsync(6000);
    expect(worker.terminate).not.toHaveBeenCalled();worker.emit({result:{id:'finished',status:'optimal'}});expect(await promise).toMatchObject({id:'finished',status:'optimal'});
    await vi.advanceTimersByTimeAsync(20000);expect(worker.terminate).not.toHaveBeenCalled();
  });
  it('explicit cancellation preserves the last verified plan and releases the worker',async()=>{
    const promise=calculate('solve',{});const worker=current();worker.start();worker.emit({event:'solver-progress',plan:incumbent});cancelCalculation();
    expect(await promise).toMatchObject({id:'validated',status:'feasible',solver:{interruption:'cancelled',completeHierarchy:false}});expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('ignores messages belonging to a terminated request',async()=>{
    const oldPromise=calculate('solve',{}).catch(error=>error);const old=current();old.start();cancelCalculation();await oldPromise;
    const nextPromise=calculate('solve',{});const next=current();old.emit({result:{id:'stale'}});next.emit({result:{id:'current'}});expect(await nextPromise).toEqual({id:'current'});
  });
});
