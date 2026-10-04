import { parentPort, workerData } from 'node:worker_threads';
import { solvePlan, rankUncertainties } from '../../../packages/engine/src/index.js';
try {
  const options = { ...workerData.options, onSolverStart: (fallback: unknown) => parentPort?.postMessage({ started: true, startedAt: performance.timeOrigin + performance.now(), fallback }), onProgress: (progress: unknown) => parentPort?.postMessage({ progress }), onRankingProgress: (ranking: unknown) => parentPort?.postMessage({ ranking }) };
  const result = workerData.operation === 'rank' ? await rankUncertainties(workerData.model, options) : await solvePlan(workerData.model, options);
  parentPort?.postMessage({ result });
} catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Worker failed' }); }
