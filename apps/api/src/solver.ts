import { Worker } from 'node:worker_threads';
import { DomainError } from './domain.js';
let active = 0;
export function runSolver(model: any, options: any = {}, operation = 'solve'): Promise<any> {
  if (active >= 2) throw new DomainError('solver_busy', 'Trwają inne obliczenia. Spróbuj ponownie.', 429);
  active++;
  return new Promise((resolve, reject) => {
    const budgetMs = Math.min(30_000, Math.max(100, Number(options.budgetMs) || 5000));
    const worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), { workerData: { model, operation, options: { budgetMs, assumptions: options.assumptions ?? {} } }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let done = false;
    let solveTimeout: ReturnType<typeof setTimeout> | undefined;
    let fallback: any, incumbent: any, ranking: any;
    let solveStarted = 0, deadline = 0;
    const requestedAt = performance.now();
    const finish = (error?: Error, result?: any) => { if (done) return; done = true; clearTimeout(initializationTimeout); clearTimeout(solveTimeout); active--; void worker.terminate(); if (error) reject(error); else resolve(result); };
    const initializationTimeout = setTimeout(() => finish(new DomainError('solver_initialization_timeout', 'Nie uruchomiono silnika w limicie inicjalizacji. Nie jest to dowód niewykonalności.', 408)), 120_000);
    const exhausted = () => {
      if (done) return;
      const elapsedMs = performance.now() - requestedAt;
      if (operation === 'rank') {
        const unexaminedIds = (model.uncertainties ?? []).map((item: any) => item.id);
        const result = ranking ?? { items: [], complete: false, unexaminedIds, budgetMs, elapsedMs, scope: [] };
        result.complete = false; result.elapsedMs = elapsedMs; result.interruption = 'deadline'; result.watchdogElapsedMs = performance.timeOrigin + performance.now() - solveStarted; result.scope.push('Wspólny budżet obliczeń wyczerpany. Zachowano tylko zakończone porównania; pozostałe nie są zbadane.');
        finish(undefined, result); return;
      }
      const result = incumbent ?? fallback;
      if (!result) { finish(new DomainError('solver_timeout', 'Brak zwalidowanego wyniku w budżecie obliczeń. Nie jest to dowód niewykonalności.', 408)); return; }
      result.status = incumbent ? 'feasible' : 'no_solution'; result.solver.completeHierarchy = false; result.solver.interruption = 'deadline';
      result.solver.timings.watchdogElapsedMs = performance.timeOrigin + performance.now() - solveStarted; result.solver.timings.totalMs = elapsedMs;
      result.diagnostics.push(incumbent ? 'Budżet obliczeń wyczerpany. Zachowano ostatni niezależnie zwalidowany plan; optimum pełnej hierarchii nie zostało dowiedzione.' : 'Budżet obliczeń wyczerpany bez zwalidowanego planu. To nie jest dowód niewykonalności.');
      finish(undefined, result);
    };
    worker.on('message', value => {
      if (done) return;
      if (value.started) { if (!solveTimeout) { fallback = value.fallback; clearTimeout(initializationTimeout); solveStarted = value.startedAt ?? performance.timeOrigin + performance.now(); deadline = solveStarted + budgetMs; solveTimeout = setTimeout(exhausted, Math.max(0, deadline - (performance.timeOrigin + performance.now()))); } return; }
      if (deadline && performance.timeOrigin + performance.now() >= deadline) { exhausted(); return; }
      if (value.progress) { if (operation !== 'rank') incumbent = value.progress; return; }
      if (value.ranking) { ranking = value.ranking; return; }
      value.error ? finish(new DomainError('solver_error', value.error)) : finish(undefined, value.result);
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => { if (!done) finish(new DomainError('solver_stopped', `Proces obliczeniowy zakończył się bez wyniku (${code}).`)); });
  });
}
