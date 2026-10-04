import { solvePlan, validatePlan, validateModel, evaluateDependencies, minimalCutSets, rankUncertainties } from '../../../packages/engine/src/index';
import type { DomainModel, Plan, RankingResult } from '../../../packages/contracts/src/index';
self.onmessage = async (event: MessageEvent<{ id: string; type: string; model: DomainModel; plan?: Plan; assumptions?: Record<string, any>;budgetMs?:number }>) => {
  const { id, type, model, plan, assumptions, budgetMs=5000 } = event.data;
  try {
    let result: unknown;
    const onSolverStart=(plan:Plan)=>self.postMessage({id,event:'solver-start',plan,startedAt:performance.timeOrigin+performance.now()});
    const onProgress=(plan:Plan)=>self.postMessage({id,event:'solver-progress',plan});
    const onRankingProgress=(ranking:RankingResult)=>self.postMessage({id,event:'ranking-progress',ranking});
    if (type === 'solve') result = await solvePlan(model, { budgetMs, wasmUrl: '/highs.wasm', assumptions,onSolverStart,onProgress });
    else if (type === 'validate') result = validatePlan(model, plan!);
    else if (type === 'rank') result = await rankUncertainties(model, { budgetMs, wasmUrl: '/highs.wasm',onSolverStart,onRankingProgress });
    else if (type === 'evaluate') result = { ...evaluateDependencies(model), validation:validateModel(model), cutSets: model.dependencies.filter(d => d.kind !== 'leaf').map(d => ({ dependencyId: d.id, ...minimalCutSets(model, d.id, { limit: 1000 }) })) };
    else throw new Error('Nieznany rodzaj obliczenia');
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
