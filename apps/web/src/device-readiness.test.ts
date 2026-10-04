import { describe,expect,it,vi } from 'vitest';
import { preparedDeviceIssues } from './device-readiness';

const context={serverEpoch:'epoch-a',modelRevision:2,offlineUntil:'2030-01-02T00:00:00Z',now:Date.parse('2030-01-01T00:00:00Z')};
const record=()=>({serverEpoch:'epoch-a',modelRevision:2,offlineExpiresAt:context.offlineUntil,persistent:false,signatureVerified:true,manifest:{expiresAt:'2030-01-02T00:00:00Z',application:{complete:true,files:[{path:'/highs.wasm'},{path:'/index.html'},{path:'/assets/Tasks.js'},{path:'/sw.js'},{path:'/assets/Tasks.js.map'}]}}});
describe('prepared device readiness after browser state changes',()=>{
  it('allows explicit nonpersistent storage only when every required runtime file remains cached',async()=>{
    const cached=vi.fn(async()=>true);expect(await preparedDeviceIssues(record(),context,cached)).toEqual([]);
    expect(cached.mock.calls).toHaveLength(3);
  });
  it('detects eviction of a runtime file without modifying the prepared record or data',async()=>{
    const prepared=record(),original=structuredClone(prepared);const issues=await preparedDeviceIssues(prepared,context,async path=>path!=='/highs.wasm');
    expect(issues.join(' ')).toContain('Brak wymaganej kopii offline: /highs.wasm');expect(prepared).toEqual(original);
  });
  it('invalidates an expired signed bundle, account access, changed epoch and model revision',async()=>{
    const prepared=record();prepared.manifest.expiresAt='2029-12-31T00:00:00Z';
    const issues=await preparedDeviceIssues(prepared,{...context,serverEpoch:'epoch-b',modelRevision:3,offlineUntil:'2029-12-31T00:00:00Z'},async()=>true);
    expect(issues).toHaveLength(4);
  });
});
