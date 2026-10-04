import type { AllocationScope, Availability, DomainModel, Plan, RankingResult, SolveOptions, UncertaintyRanking, ValidationIssue, ValidationResult } from '../../contracts/src/index.js';
import { solvePlan } from './solver.js';
import { validatePlan } from './validator.js';
import { validateModel } from './model.js';

export async function rankUncertainties(model: DomainModel, options: SolveOptions & { includeGroups?: boolean } = {}): Promise<RankingResult> {
  const started=performance.now(), budget=Number.isFinite(options.budgetMs??5000)?Math.max(0,options.budgetMs??5000):0, items:UncertaintyRanking[]=[], scope:string[]=[];
  const validation=validateModel(model);
  if(!validation.valid)return {items,complete:false,unexaminedIds:Array.isArray(model?.uncertainties)?model.uncertainties.flatMap(u=>u?.id?[u.id]:[]):[],budgetMs:budget,elapsedMs:performance.now()-started,scope:validation.issues.map(i=>i.message)};
  const questions=model.uncertainties.map(u=>({id:u.id,subjectIds:[u.subjectId],question:u.question,verificationMinutes:u.verificationMinutes,contact:u.contact}));
  if(options.includeGroups!==false)for(const groupId of new Set(model.uncertainties.map(u=>u.groupId).filter(Boolean))){const group=model.uncertainties.filter(u=>u.groupId===groupId);if(group.length>1)questions.push({id:`group-${groupId}`,subjectIds:group.map(u=>u.subjectId),question:group.map(u=>u.question).join(' / '),verificationMinutes:group.reduce((n,u)=>n+u.verificationMinutes,0),contact:group.map(u=>u.contact).join('; ')});}
  const priorities=[...new Set(model.services.map(s=>s.priority))].sort((a,b)=>a-b);
  const sorted=(values:UncertaintyRanking[])=>[...values].sort((a,b)=>{if(a.analyzed!==b.analyzed)return a.analyzed?-1:1;for(const p of priorities){const delta=(b.improvementByPriority[p]??0)-(a.improvementByPriority[p]??0);if(Math.abs(delta)>1e-6)return delta;}return Number(b.decisionChanges)-Number(a.decisionChanges)||a.verificationMinutes-b.verificationMinutes;});
  options.onRankingProgress?.({items:[],complete:false,unexaminedIds:questions.map(q=>q.id),budgetMs:budget,elapsedMs:performance.now()-started,scope:[]});
  let solverMs=0;
  for(const [questionIndex,question] of questions.entries()){
    const item:UncertaintyRanking={...question,availablePlan:null,unavailablePlan:null,improvementServiceMinutes:0,improvementByPriority:{},decisionChanges:false,approximate:true,analyzed:false};
    if(solverMs>=budget||options.signal?.aborted){if(question.subjectIds.length>1)item.unexaminedCombinationCount=(1n<<BigInt(question.subjectIds.length)).toString();items.push(item);continue;}
    const assume=(state:Availability)=>({...options.assumptions,...Object.fromEntries(question.subjectIds.map(id=>[id,state]))});
    item.availablePlan=await solvePlan(model,{...options,assumptions:assume('available'),budgetMs:Math.max(0,budget-solverMs)});solverMs+=item.availablePlan.solver.timings.solveMs;
    if(solverMs<budget){item.unavailablePlan=await solvePlan(model,{...options,assumptions:assume('unavailable'),budgetMs:Math.max(0,budget-solverMs)});solverMs+=item.unavailablePlan.solver.timings.solveMs;}
    if(item.availablePlan.validation.valid&&item.unavailablePlan?.validation.valid){
      item.analyzed=true;item.improvementServiceMinutes=item.availablePlan.metrics.minimumServiceMinutes-item.unavailablePlan.metrics.minimumServiceMinutes;
      for(const priority of new Set(model.services.map(s=>s.priority)))item.improvementByPriority[priority]=(item.unavailablePlan.metrics.byPriority[priority]??0)-(item.availablePlan.metrics.byPriority[priority]??0);
      const signature=(p:Plan)=>JSON.stringify(p.actions.map(a=>[a.modeId,a.startMinute,a.readyMinute,a.endMinute,a.allocations.map(x=>JSON.stringify([x.requirementId,x.resourceId,[...(x.unitIds??[])].sort(),x.quantity,x.startMinute,x.endMinute,x.consumedQuantity])).sort()]));
      item.decisionChanges=signature(item.availablePlan)!==signature(item.unavailablePlan);item.approximate=item.availablePlan.status!=='optimal'||item.unavailablePlan.status!=='optimal';
    }
    if(question.subjectIds.length>1){
      const combinations=1n<<BigInt(question.subjectIds.length);item.variants=[];
      if(item.availablePlan)item.variants.push({assumptions:assume('available'),plan:item.availablePlan});
      if(item.unavailablePlan)item.variants.push({assumptions:assume('unavailable'),plan:item.unavailablePlan});
      for(let mask=1n;mask<combinations-1n&&solverMs<budget&&!options.signal?.aborted;mask++){
        const assumptions={...options.assumptions,...Object.fromEntries(question.subjectIds.map((id,i)=>[id,mask&(1n<<BigInt(i))?'available':'unavailable']))} as Record<string,Availability>;
        const variant=await solvePlan(model,{...options,assumptions,budgetMs:Math.max(0,budget-solverMs)});solverMs+=variant.solver.timings.solveMs;item.variants.push({assumptions,plan:variant});
      }
      item.unexaminedCombinationCount=(combinations-BigInt(item.variants.length)).toString();
      item.approximate ||= item.unexaminedCombinationCount!=='0'||item.variants.some(v=>v.plan.status!=='optimal');
    }
    scope.push(`${question.id}: ${question.subjectIds.length>1?`${item.variants?.length??0} kombinacji obliczonych, ${item.unexaminedCombinationCount} nieobliczonych`:'available / unavailable'}`);items.push(item);
    if(options.onRankingProgress){const unexaminedIds=[...items.filter(i=>!i.analyzed||(i.unexaminedCombinationCount??'0')!=='0').map(i=>i.id),...questions.slice(questionIndex+1).map(q=>q.id)];options.onRankingProgress(structuredClone({items:sorted(items),complete:unexaminedIds.length===0,unexaminedIds,budgetMs:budget,elapsedMs:performance.now()-started,scope}));}
  }
  return {items:sorted(items),complete:items.every(i=>i.analyzed&&(i.unexaminedCombinationCount??'0')==='0'),unexaminedIds:items.filter(i=>!i.analyzed||(i.unexaminedCombinationCount??'0')!=='0').map(i=>i.id),budgetMs:budget,elapsedMs:performance.now()-started,scope};
}
export function validateAllocationScope(model:DomainModel,plan:Plan,scope:AllocationScope,userId:string,now:string,timeTrusted=true):ValidationResult{
  const validation=validatePlan(model,plan),issues:ValidationIssue[]=[...validation.issues];
  if(!validation.valid)return validation;
  const add=(code:string,message:string)=>issues.push({code,message});
  if(!timeTrusted||!Number.isFinite(Date.parse(now)))add('untrusted_time','Nie można ustalić ważności lokalnego upoważnienia.');
  if(!scope||!Array.isArray(scope.resourceIds)||!Array.isArray(scope.modeIds)){add('scope_schema','Brak poprawnego zakresu lokalnego upoważnienia.');return {valid:false,issues,warnings:validation.warnings};}
  if(scope.allowLocalReplanning!==true||scope.authorizedUserId!==userId)add('scope_authority','Brak uprawnienia do lokalnej zmiany planu.');
  if(!Number.isFinite(Date.parse(scope.validFrom))||!Number.isFinite(Date.parse(scope.validUntil))||Date.parse(scope.validUntil)<=Date.parse(scope.validFrom)||Date.parse(now)<Date.parse(scope.validFrom)||Date.parse(now)>=Date.parse(scope.validUntil))add('scope_expired','Lokalne upoważnienie nie jest ważne.');
  if(scope.modelRevision!==model.revision)add('scope_revision','Upoważnienie dotyczy innej wersji modelu.');
  for(const action of plan.actions){if(!scope.modeIds.includes(action.modeId))add('scope_mode',`Tryb ${action.modeId} poza lokalnym upoważnieniem.`);for(const allocation of action.allocations)if(!scope.resourceIds.includes(allocation.resourceId))add('scope_resource',`Zasób ${allocation.resourceId} poza lokalną pulą.`);}
  if(plan.conditional)add('scope_assumption','Lokalny przydział wymaga potwierdzonych przesłanek.');
  return {valid:issues.length===0,issues,warnings:validation.warnings,blockedFragments:validation.blockedFragments};
}
