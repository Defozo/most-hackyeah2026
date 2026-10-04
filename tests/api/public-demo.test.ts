import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp, seedDemo } from '../../apps/api/src/app.js';
import { Store } from '../../apps/api/src/store.js';
const cleanup:Array<()=>Promise<unknown>>=[];
async function removeTestDirectory(directory:string){const target=resolve(directory),pathFromTemp=relative(resolve(tmpdir()),target);if(!pathFromTemp||pathFromTemp.startsWith('..')||isAbsolute(pathFromTemp)||!basename(target).startsWith('most-'))throw new Error('Refusing to remove a directory outside this test temporary scope.');await rm(target,{recursive:true,force:true});}
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const origin='https://most-judging.example';
async function app(publicDemo=true){const dataDir=await mkdtemp(join(tmpdir(),'most-public-demo-'));cleanup.push(()=>removeTestDirectory(dataDir));const instance=await buildApp({dataDir,publicDemo,trustedOrigins:[origin],secureCookies:true});cleanup.push(()=>instance.close());return instance;}
describe('separate public judging demo',()=>{
  it('is opt-in and refuses an existing organization',async()=>{
    const ordinary=await app(false);
    expect((await ordinary.inject({method:'POST',url:'/api/auth/demo',headers:{origin},payload:{}})).statusCode).toBe(401);
    const dataDir=await mkdtemp(join(tmpdir(),'most-private-protection-'));cleanup.push(()=>removeTestDirectory(dataDir));
    const store=new Store(dataDir);cleanup.push(async()=>store.close());seedDemo(store,randomUUID());
    await expect(buildApp({store,publicDemo:true})).rejects.toThrow('dedicated data directory');
    expect(store.meta('publicDemo')).toBeUndefined();
  });
  it('creates separate cookie-only organizations, rejects cross-organization commands and credentials',async()=>{
    const instance=await app();
    expect((await instance.inject({url:'/'})).headers.location).toBe('/demo');
    const landing=await instance.inject({url:'/demo'});expect(landing.body).toContain('Uruchom demo');
    const start=()=>instance.inject({method:'POST',url:'/api/auth/demo',headers:{origin},payload:{}});
    const first=await start(),second=await start();expect(first.statusCode).toBe(200);expect(second.statusCode).toBe(200);
    const a=first.json(),b=second.json();expect(a.user.organizationId).not.toBe(b.user.organizationId);
    const cookie=String(first.headers['set-cookie']).split(';')[0];expect(first.headers['set-cookie']).toContain('Secure');expect(first.headers['set-cookie']).toContain('HttpOnly');expect(first.headers['set-cookie']).toContain('SameSite=Strict');
    const snapshot=(await instance.inject({url:'/api/snapshot',headers:{cookie}})).json();expect(snapshot.model.synthetic).toBe(true);expect(snapshot.model.services).toHaveLength(3);
    const response=await instance.inject({method:'POST',url:'/api/commands',headers:{origin,cookie,'x-csrf-token':a.csrfToken},payload:{commands:[{commandId:randomUUID(),deviceId:'judge-test',organizationId:b.user.organizationId,baseRevision:1,serverEpoch:a.serverEpoch,dependsOn:[],type:'observation.create',schemaVersion:1,payload:{text:'Cross organization'}}]}});
    expect(response.json().results[0].status).toBe('rejected');
    expect(instance.store.read(b.user.organizationId).observations).toHaveLength(0);
    expect((await instance.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:a.user.username,password:'not-a-demo-password'}})).statusCode).toBe(403);
    expect((await instance.inject({method:'POST',url:'/api/auth/bootstrap',headers:{origin},payload:{username:'private-account',password:'not-a-demo-password'}})).statusCode).toBe(403);
  });
  it('requires trusted Origin and CSRF for another exercise, caps anonymous starts',async()=>{
    const instance=await app();
    expect((await instance.inject({method:'POST',url:'/api/auth/demo',payload:{}})).statusCode).toBe(403);
    const first=await instance.inject({method:'POST',url:'/api/auth/demo',headers:{origin},payload:{}});const a=first.json();const cookie=String(first.headers['set-cookie']).split(';')[0];
    expect((await instance.inject({method:'POST',url:'/api/auth/demo',headers:{origin,cookie},payload:{}})).statusCode).toBe(403);
    expect((await instance.inject({method:'POST',url:'/api/auth/demo',headers:{origin,cookie,'x-csrf-token':a.csrfToken},payload:{}})).statusCode).toBe(200);
    let last;for(let i=0;i<31;i++)last=await instance.inject({method:'POST',url:'/api/auth/demo',headers:i%2?{origin,cookie,'x-csrf-token':a.csrfToken,'x-forwarded-for':'198.51.100.5'}:{origin},payload:{}});
    expect(last!.statusCode).toBe(429);expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    expect((instance.store.db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as {n:number}).n).toBeLessThanOrEqual(31);
  });
});
