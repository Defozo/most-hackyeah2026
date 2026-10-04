import type { Availability, CutSetResult, DependencyEvaluation, DomainModel, ValidationIssue } from '../../contracts/src/index.js';
import { excludedDependencyReasons } from './fragments.js';

export function evaluateDependencies(model: DomainModel, minute = 0, assumptions: Record<string, Availability> = {}): DependencyEvaluation {
  const states: Record<string, Availability> = Object.create(null), reasons: Record<string, string[]> = Object.create(null), issues: ValidationIssue[] = [];
  const nodes = new Map(model.dependencies.map(n => [n.id, n]));
  const visiting = new Set<string>();
  const walk = (id: string): Availability => {
    if (states[id]) return states[id];
    if (visiting.has(id)) { issues.push({ code: 'dependency_cycle', subjectId: id, message: `Cykl zależności: ${[...visiting, id].join(' → ')}` }); return 'unknown'; }
    const node = nodes.get(id);
    if (!node) { issues.push({ code: 'missing_dependency', subjectId: id, message: `Nie istnieje zależność ${id}.` }); return 'unknown'; }
    visiting.add(id);
    let state: Availability;
    if (node.kind === 'leaf') {
      state = (Object.hasOwn(assumptions,id) ? assumptions[id] : undefined) ?? (node.confidence === 'confirmed' ? node.state ?? 'unknown' : 'unknown');
      if ((node.availableFromMinute ?? 0) > minute || (node.availableUntilMinute ?? Infinity) <= minute) state = 'unknown';
      reasons[id] = state === 'available' ? [] : [id];
    } else {
      const inputs = node.inputs.map(walk);
      state = inputs.length === 0 ? 'unknown' : node.kind === 'and'
        ? inputs.includes('unavailable') ? 'unavailable' : inputs.every(s => s === 'available') ? 'available' : 'unknown'
        : inputs.includes('available') ? 'available' : inputs.every(s => s === 'unavailable') ? 'unavailable' : 'unknown';
      reasons[id] = [...new Set(node.inputs.filter((_, i) => inputs[i] !== 'available').flatMap(input => reasons[input] ?? [input]))];
    }
    if (node.commonCauseId) { const cause = walk(node.commonCauseId); if (cause === 'unavailable') state = 'unavailable'; else if (cause === 'unknown' && state !== 'unavailable') state = 'unknown'; if (cause !== 'available') reasons[id].push(node.commonCauseId); }
    visiting.delete(id); states[id] = state; return state;
  };
  for (const node of model.dependencies) walk(node.id);
  for(const [id,excluded] of excludedDependencyReasons(model)){states[id]='unknown';reasons[id]=excluded;}
  return { states, reasons, issues };
}

export function minimalCutSets(model: DomainModel, dependencyId: string, options: { limit?: number; signal?: AbortSignal } = {}): CutSetResult {
  const limit = Math.max(1, options.limit ?? 4096), nodes = new Map(model.dependencies.map(n => [n.id, n]));
  const issues: ValidationIssue[] = []; let explored = 0, complete = true;
  const active = new Set<string>();
  const minimal = (sets: string[][]) => { const sorted = sets.map(s => [...new Set(s)].sort()).sort((a,b) => a.length-b.length); const out: string[][] = []; for (const set of sorted) if (!out.some(s => s.every(id => set.includes(id)))) out.push(set); return out; };
  const walk = (id: string): string[][] => {
    if (options.signal?.aborted || explored++ >= limit) { complete = false; return []; }
    const node = nodes.get(id);
    if (!node || active.has(id)) { issues.push({ code: node ? 'dependency_cycle' : 'missing_dependency', subjectId: id, message: `Niepoprawny graf przy ${id}.` }); complete = false; return []; }
    active.add(id);
    let sets: string[][];
    if (node.kind === 'leaf') sets = [[id]];
    else if (node.kind === 'and') sets = node.inputs.flatMap(walk);
    else {
      sets = [[]];
      for (const input of node.inputs) {
        const children = walk(input), product: string[][] = [];
        for (const a of sets) for (const b of children) { if (++explored > limit || options.signal?.aborted) { complete = false; break; } product.push([...a, ...b]); }
        sets = minimal(product); if (!complete) { sets = []; break; }
      }
    }
    if (node.commonCauseId) sets.push(...walk(node.commonCauseId));
    active.delete(id); return minimal(sets);
  };
  return { sets: walk(dependencyId).filter(s => s.length), complete, explored, limit, issues };
}
