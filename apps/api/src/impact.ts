import type { AssessmentImpact, DomainModel } from '../../../packages/contracts/src/index.js';
import { evaluateDependencies, resourceMatches } from '../../../packages/engine/src/index.js';

/** A dependency/resource impact is not a new capacity estimate or a reservation. */
export function assessmentImpact(before: DomainModel, after: DomainModel, subjectId: string, actions: any[]): AssessmentImpact {
  const prior = evaluateDependencies(before), next = evaluateDependencies(after);
  const dependent = new Set([subjectId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of after.dependencies) if (!dependent.has(node.id) && (node.inputs.some(id => dependent.has(id)) || node.commonCauseId && dependent.has(node.commonCauseId))) { dependent.add(node.id); expanded = true; }
  }
  const resources = after.resources.filter(resource => resource.id === subjectId || dependent.has(resource.dependencyId ?? ''));
  const affected = new Set(after.modes.filter(mode => dependent.has(mode.dependencyId ?? '') || mode.requirements.some(requirement => resources.some(resource => resourceMatches(resource, requirement)))).map(mode => mode.id));
  expanded = true;
  while (expanded) { expanded = false; for (const mode of after.modes) if (!affected.has(mode.id) && mode.predecessors?.some(id => affected.has(id))) { affected.add(mode.id); expanded = true; } }
  const modes = after.modes.filter(mode => affected.has(mode.id));
  const relevantDependencies = new Set<string>();
  const visit = (id?: string) => { if (!id || relevantDependencies.has(id)) return; relevantDependencies.add(id); const node = after.dependencies.find(candidate => candidate.id === id); node?.inputs.forEach(visit); visit(node?.commonCauseId); };
  modes.forEach(mode => { visit(mode.dependencyId); for (const requirement of mode.requirements) for (const resource of after.resources.filter(candidate => resourceMatches(candidate, requirement))) visit(resource.dependencyId); });
  const missingIds = new Set(after.dependencies.filter(node => node.kind === 'leaf' && relevantDependencies.has(node.id) && next.states[node.id] === 'unknown').map(node => node.id));
  for (const mode of modes) for (const requirement of mode.requirements) for (const resource of after.resources) if (resourceMatches(resource, requirement) && (resource.state === 'unknown' || resource.confidence !== 'confirmed')) missingIds.add(resource.id);
  const missingChecks = [...missingIds].sort().map(id => { const question = after.uncertainties.find(candidate => candidate.subjectId === id); return { subjectId: id, state: 'unknown' as const, ...(question ? { question: question.question, contact: question.contact, verificationMinutes: question.verificationMinutes } : {}) }; });
  return {
    computedAt: new Date().toISOString(), beforeModelRevision: before.revision, modelRevision: after.revision,
    subjectId, affectedServiceIds: [...new Set(modes.map(mode => mode.serviceId))].sort(), affectedModeIds: [...affected].sort(),
    affectedActionIds: actions.filter(action => affected.has(action.modeId)).map(action => action.id).sort(),
    dependencyChanges: after.dependencies.filter(node => prior.states[node.id] !== next.states[node.id]).map(node => ({ id: node.id, before: prior.states[node.id], after: next.states[node.id] })),
    missingChecks, scope: 'dependency_and_resource_impact', requiresReplanning: affected.size > 0,
  };
}
