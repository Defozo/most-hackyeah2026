import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../apps/api/src/app.ts';

describe('rate limits for an offline-capable organization', () => {
  let app: Awaited<ReturnType<typeof buildApp>>, directory: string;
  let administrator: Record<string, string>, operator: Record<string, string>;
  const origin='http://localhost:8080';
  const credentials={username:'rate-admin',password:randomUUID()+randomUUID()};
  beforeEach(async () => {
    directory=mkdtempSync(join(tmpdir(),'most-rate-test-'));
    const staticDir=join(directory,'static');mkdirSync(staticDir);writeFileSync(join(staticDir,'index.html'),'<!doctype html><title>Rate test</title>');writeFileSync(join(staticDir,'app.js'),'globalThis.staticRateTest=true;');
    app=await buildApp({dataDir:directory,staticDir,trustedOrigins:[origin],seedDemo:true});
    const bootstrap=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers:{origin},payload:credentials});expect(bootstrap.statusCode).toBe(200);
    administrator={origin,cookie:String(bootstrap.headers['set-cookie']).split(';')[0],'x-csrf-token':bootstrap.json().csrfToken};
    const created=await app.inject({method:'POST',url:'/api/users',headers:administrator,payload:{username:'rate-operator',password:credentials.password,displayName:'Operator testowy',role:'operator'}});expect(created.statusCode).toBe(200);
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:'rate-operator',password:credentials.password}});expect(login.statusCode).toBe(200);
    operator={origin,cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  },120_000);
  afterEach(async()=>{await app?.close();if(directory&&resolve(directory).startsWith(resolve(join(tmpdir(),'most-rate-test-'))))rmSync(directory,{recursive:true,force:true});});

  it('excludes the complete static/PWA burst from the operational request budget', async () => {
    const first=await app.inject({url:'/api/snapshot',headers:administrator});expect(first.statusCode).toBe(200);expect(Number(first.headers['x-ratelimit-limit'])).toBe(600);
    for(let batch=0;batch<14;batch++){
      const responses=await Promise.all(Array.from({length:50},(_,index)=>app.inject({url:`/app.js?revision=${batch*50+index}`,headers:index%2?administrator:operator})));
      expect(responses.every(response=>response.statusCode===200&&response.headers['x-ratelimit-limit']===undefined)).toBe(true);
    }
    const after=await app.inject({url:'/api/snapshot',headers:administrator});expect(after.statusCode).toBe(200);expect(Number(after.headers['x-ratelimit-remaining'])).toBe(Number(first.headers['x-ratelimit-remaining'])-1);
  },60_000);

  it('gives authenticated users behind the same IP separate operational budgets', async () => {
    let remaining=0;
    for(let batch=0;batch<14;batch++){
      const responses=await Promise.all(Array.from({length:50},(_,index)=>app.inject({url:'/api/snapshot',headers:index%2?administrator:operator})));
      expect(responses.every(response=>response.statusCode===200)).toBe(true);
      remaining=Math.min(...responses.filter((_,index)=>index%2===1).map(response=>Number(response.headers['x-ratelimit-remaining'])));
    }
    for(let request=0;request<remaining;request++)expect((await app.inject({url:'/api/session',headers:administrator})).statusCode).toBe(200);
    const limited=await app.inject({url:'/api/snapshot',headers:administrator});expect(limited.statusCode).toBe(429);expect(limited.json().code).toBe('rate_limited');expect(limited.json().message).toMatch(/^Zbyt wiele żądań/);expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app.inject({url:'/api/snapshot',headers:operator})).statusCode).toBe(200);
  },60_000);

  it('keeps strict login and bootstrap limits per IP even when cookies or forwarded headers change', async () => {
    // Setup already used one login and one bootstrap on this IP.
    for(let attempt=0;attempt<7;attempt++){
      const response=await app.inject({method:'POST',url:'/api/auth/login',headers:attempt%2?administrator:operator,payload:{username:'missing-user',password:credentials.password}});expect(response.statusCode).toBe(401);
    }
    const denied=await app.inject({method:'POST',url:'/api/auth/login',headers:{...administrator,'x-forwarded-for':'198.51.100.99'},payload:credentials});expect(denied.statusCode).toBe(429);expect(denied.json().message).toMatch(/^Zbyt wiele żądań/);
    const otherIp=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'198.51.100.42',headers:{origin},payload:{username:'missing-user',password:credentials.password}});expect(otherIp.statusCode).toBe(401);
    for(let attempt=0;attempt<4;attempt++)expect((await app.inject({method:'POST',url:'/api/auth/bootstrap',headers:attempt%2?administrator:operator,payload:credentials})).statusCode).toBe(409);
    const bootstrapDenied=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers:administrator,payload:credentials});expect(bootstrapDenied.statusCode).toBe(429);
    expect((await app.inject({url:'/api/snapshot',headers:administrator})).statusCode).toBe(200);
  });
});
