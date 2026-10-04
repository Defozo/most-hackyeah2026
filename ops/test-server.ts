import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';

const dir=await mkdtemp(join(tmpdir(),'most-e2e-'));
const staticDir=join(dir,'web-release');await cp('apps/web/dist',staticDir,{recursive:true,errorOnExist:true});
const keys=generateKeyPairSync('ed25519');
process.env.MOST_SIGNING_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
process.env.APP_ORIGIN='http://localhost:8091';
process.env.DEMO_MODE='true';
const app=await buildApp({dataDir:dir,staticDir,trustedOrigins:['http://localhost:8091'],secureCookies:false,seedDemo:true});
await app.listen({host:'127.0.0.1',port:8091});
console.log('MOST isolated e2e server ready on 8091');
for(const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,async()=>{await app.close();process.exit(0);});
