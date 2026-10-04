import type { BlockedFragment, DomainModel, ValidationIssue } from '../../contracts/src/index.js';

/** Invalid reference paths are excluded even when an OR has a healthy branch. */
function blockedGraph(nodes:{id:string;inputs:string[];reasons?:string[]}[],label:string):Map<string,string[]>{
  const byId=new Map(nodes.map(node=>[node.id,node])),memo=new Map<string,string[]>(),visiting:string[]=[];
  const visit=(id:string):string[]=>{
    const known=memo.get(id);if(known)return known;
    if(visiting.includes(id))return [`Cykl ${label}: ${[...visiting.slice(visiting.indexOf(id)),id].join(' → ')}.`];
    const node=byId.get(id);if(!node){const reasons=[`Brak ${label}: ${id}.`];memo.set(id,reasons);return reasons;}
    visiting.push(id);const reasons=[...new Set([...(node.reasons??[]),...node.inputs.flatMap(visit)])];visiting.pop();memo.set(id,reasons);return reasons;
  };
  for(const node of nodes)visit(node.id);
  return new Map([...memo].filter(([,reasons])=>reasons.length>0));
}

export function excludedDependencyReasons(model:DomainModel):Map<string,string[]>{
  return blockedGraph(model.dependencies.map(node=>({id:node.id,inputs:[...node.inputs,...(node.commonCauseId?[node.commonCauseId]:[])]})),'zależności');
}

export function blockedModelFragments(model:DomainModel,localIssues:ValidationIssue[]):BlockedFragment[]{
  const dependencies=excludedDependencyReasons(model);
  for(const entry of [...model.modes,...model.resources])if(entry.dependencyId&&!model.dependencies.some(d=>d.id===entry.dependencyId))dependencies.set(entry.dependencyId,[`Brak zależności: ${entry.dependencyId}.`]);
  const reason=(dependencyId:string|undefined)=>dependencyId?(dependencies.get(dependencyId)??(!model.dependencies.some(d=>d.id===dependencyId)?[`Brak zależności: ${dependencyId}.`]:[])):[];
  const modeCodes=new Set(['missing_procedure','missing_contract','mode_parameter','mode_approval']);
  const modeReasons=(mode:DomainModel['modes'][number])=>localIssues.filter(issue=>modeCodes.has(issue.code)&&issue.subjectId===mode.id||issue.code==='procedure_parameter'&&issue.subjectId===mode.procedureId||issue.code==='contract_parameter'&&issue.subjectId===mode.verificationContractId).map(issue=>issue.message);
  const modes=blockedGraph(model.modes.map(mode=>({id:mode.id,inputs:mode.predecessors??[],reasons:[...reason(mode.dependencyId),...modeReasons(mode)]})),'poprzednika');
  const fragments:BlockedFragment[]=[...dependencies].map(([id,reasons])=>({kind:'dependency',id,reasons}));
  for(const [id,reasons] of modes)if(model.modes.some(m=>m.id===id))fragments.push({kind:'mode',id,reasons});
  for(const resource of model.resources){const reasons=reason(resource.dependencyId);if(reasons.length)fragments.push({kind:'resource',id:resource.id,reasons});}
  return fragments;
}
