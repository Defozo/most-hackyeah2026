/** Availability evaluation only, preserving all samples and separate warmup. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus,totalmem,platform,release} from 'node:os';
import {createDemoModel} from '../packages/scenarios/src/index.ts';
import {evaluateDependencies} from '../packages/engine/src/index.ts';
import type {Dependency} from '../packages/contracts/src/index.ts';
const releaseManifestHash=createHash('sha256').update(await readFile('apps/web/dist/release-manifest.json')).digest('hex'),sourceFiles=['packages/contracts/src/index.ts','packages/scenarios/src/index.ts','packages/engine/src/dependencies.ts','packages/engine/src/fragments.ts'],sourceDigest=createHash('sha256');for(const file of sourceFiles)sourceDigest.update(file).update(await readFile(file));
const graph=createDemoModel();graph.dependencies=Array.from({length:100},(_,i):Dependency=>({id:`bench-${i}`,name:`Element ${i}`,kind:i<20?'leaf':'and',state:'available',confidence:'confirmed',inputs:i<20?[]:Array.from({length:i<80?4:3},(_,j)=>`bench-${i-j-1}`)}));
const samplesMs:number[]=[],warmupSamplesMs:number[]=[];let correct=true;
for(let i=0;i<105;i++){const start=performance.now(),result=evaluateDependencies(graph),elapsed=performance.now()-start;(i<5?warmupSamplesMs:samplesMs).push(elapsed);correct&&=result.issues.length===0&&graph.dependencies.every(node=>result.states[node.id]==='available');}
const sorted=[...samplesMs].sort((a,b)=>a-b),availability={nodes:graph.dependencies.length,edges:graph.dependencies.reduce((n,node)=>n+node.inputs.length,0),repetitions:samplesMs.length,warmup:warmupSamplesMs.length,p50Ms:sorted[49],p95Ms:sorted[94],maxMs:sorted[99],targetP95Ms:300,passed:correct&&sorted[94]<300,correct,samplesMs,warmupSamplesMs};
const report={at:new Date().toISOString(),releaseManifestHash,implementationSourceHash:sourceDigest.digest('hex'),sourceFiles,hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),platform:platform(),release:release(),node:process.version},availability,scope:'Local desktop availability calculation after fragment isolation changes. Five warmups followed by all 100 measured samples. No solver, physical phone or human decision-time claim.'};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/benchmark-availability.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:availability.passed,nodes:availability.nodes,edges:availability.edges,repetitions:availability.repetitions,p50Ms:availability.p50Ms,p95Ms:availability.p95Ms,maxMs:availability.maxMs}));if(!availability.passed)process.exitCode=1;
