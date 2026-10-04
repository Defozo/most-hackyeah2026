import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => [] as any[]);
vi.mock('node:worker_threads', async () => { const { EventEmitter } = await import('node:events'); return { Worker: class extends EventEmitter {
  terminated = false;
  constructor(..._args: unknown[]) { super(); workers.push(this); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
} }; });
import { runSolver } from '../../apps/api/src/solver.ts';

const fallback = () => ({ status: 'no_solution', validation: { valid: false }, actions: [], diagnostics: [], solver: { completeHierarchy: false, timings: { initializationMs: 3000, buildMs: 20, solveMs: 0, totalMs: 3020 } } });
beforeEach(() => { vi.useFakeTimers(); workers.length = 0; });
afterEach(() => vi.useRealTimers());

describe('Worker execution budget', () => {
  it('does not charge initialization to solving and explicitly reports no solution at the wall-time boundary', async () => {
    const result = runSolver({ uncertainties: [] }, { budgetMs: 5000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(workers[0].terminated).toBe(false);
    workers[0].emit('message', { started: true, fallback: fallback() });
    await vi.advanceTimersByTimeAsync(4999);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const plan = await result;
    expect(workers[0].terminated).toBe(true);
    expect(plan.status).toBe('no_solution');
    expect(plan.validation.valid).toBe(false);
    expect(plan.solver.timings.initializationMs).toBe(3000);
    expect(plan.diagnostics.join(' ')).toContain('nie jest dowód niewykonalności');
  });
  it('preserves the last independently validated incumbent while refusing to label it optimal', async () => {
    const result = runSolver({}, { budgetMs: 5000 });
    workers[0].emit('message', { started: true, fallback: fallback() });
    workers[0].emit('message', { progress: { ...fallback(), status: 'feasible', validation: { valid: true }, actions: [{ id: 'verified-action' }] } });
    await vi.advanceTimersByTimeAsync(5000);
    const plan = await result;
    expect(plan.validation.valid).toBe(true);
    expect(plan.actions).toEqual([{ id: 'verified-action' }]);
    expect(plan.status).toBe('feasible');
    expect(plan.solver.completeHierarchy).toBe(false);
  });
  it('retains finished uncertainty comparisons without treating an inner solve as a completed ranking', async () => {
    const result = runSolver({ uncertainties: [{ id: 'first' }, { id: 'second' }] }, { budgetMs: 5000 }, 'rank');
    workers[0].emit('message', { ranking: { items: [{ id: 'first', analyzed: true }], complete: false, unexaminedIds: ['second'], scope: [], budgetMs: 5000 } });
    workers[0].emit('message', { started: true, fallback: fallback() });
    await vi.advanceTimersByTimeAsync(3000);
    workers[0].emit('message', { started: true, fallback: fallback() });
    workers[0].emit('message', { progress: { ...fallback(), validation: { valid: true } } });
    await vi.advanceTimersByTimeAsync(2000);
    const ranking = await result;
    expect(ranking.items).toEqual([{ id: 'first', analyzed: true }]);
    expect(ranking.unexaminedIds).toEqual(['second']);
    expect(ranking.complete).toBe(false);
    expect(workers[0].terminated).toBe(true);
  });
  it('honors an explicit larger budget while the default remains five seconds', async () => {
    const result = runSolver({}, { budgetMs: 15_000 });
    workers[0].emit('message', { started: true, fallback: fallback() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).status).toBe('no_solution');
    expect(workers[0].terminated).toBe(true);
  });
  it('does not accept a late final result delivered before the timer callback', async () => {
    const result = runSolver({});
    workers[0].emit('message', { started: true, startedAt: performance.timeOrigin + performance.now() - 6000, fallback: fallback() });
    workers[0].emit('message', { result: { ...fallback(), status: 'optimal', validation: { valid: true } } });
    const plan = await result;
    expect(plan.status).toBe('no_solution');
    expect(plan.solver.interruption).toBe('deadline');
    expect(plan.validation.valid).toBe(false);
  });
});
