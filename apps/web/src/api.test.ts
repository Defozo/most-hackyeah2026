import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function delayedResponse(delayMs:number){
  const signals:AbortSignal[]=[];
  const fetchMock=vi.fn((_path:unknown,options?:RequestInit)=>new Promise<Response>((resolve,reject)=>{
    const signal=options!.signal!;signals.push(signal);
    const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve(new Response(JSON.stringify({ready:true}),{headers:{'content-type':'application/json'}}));},delayMs);
    signal.addEventListener('abort',abort,{once:true});
  }));
  vi.stubGlobal('fetch',fetchMock);return {signals,fetchMock};
}

describe('bounded API requests',()=>{
  beforeEach(()=>vi.useFakeTimers());
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

  it('keeps the default 15-second limit for ordinary requests',async()=>{
    const {signals}=delayedResponse(20_000);
    const outcome=api('/api/snapshot').catch(error=>error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({status:0,detail:{code:'REQUEST_TIMEOUT',timeoutMs:15_000}});
    expect(signals[0].aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a document or bundle response after 15 seconds with an explicit longer limit',async()=>{
    const {signals}=delayedResponse(20_000);let settled=false;
    const result=api('/api/import/preview','POST',{filename:'procedure.docx'},{timeoutMs:60_000}).finally(()=>{settled=true;});
    await vi.advanceTimersByTimeAsync(15_001);
    expect(settled).toBe(false);expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await result).toEqual({ready:true});expect(vi.getTimerCount()).toBe(0);
  });

  it('still aborts a slow request at its explicit deadline',async()=>{
    const {signals}=delayedResponse(90_000);const outcome=api('/api/bundle','GET',undefined,{timeoutMs:60_000}).catch(error=>error);
    await vi.advanceTimersByTimeAsync(59_999);expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({detail:{code:'REQUEST_TIMEOUT',timeoutMs:60_000}});
    expect(signals[0].aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the actual fetch immediately and removes deadline and listener',async()=>{
    const {signals}=delayedResponse(40_000);const controller=new AbortController();const remove=vi.spyOn(controller.signal,'removeEventListener');
    const outcome=api('/api/bundle','GET',undefined,{timeoutMs:60_000,signal:controller.signal}).catch(error=>error);
    controller.abort();
    expect(await outcome).toMatchObject({detail:{code:'REQUEST_ABORTED'}});
    expect(signals[0].aborted).toBe(true);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a request when its operation was already cancelled',async()=>{
    const {fetchMock}=delayedResponse(40_000);const controller=new AbortController();controller.abort();
    await expect(api('/api/import/preview','POST',{}, {timeoutMs:60_000,signal:controller.signal})).rejects.toMatchObject({detail:{code:'REQUEST_ABORTED'}});
    expect(fetchMock).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
});
