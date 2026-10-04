import type { Account,Entity } from './types';

export function anchoredExecutionTime(account:Account,localNow=Date.now()):number{
  if(!Number.isFinite(account.lastServerTime)||!Number.isFinite(account.lastLocalTime)||localNow<(account.lastObservedLocalTime||account.lastLocalTime)-60000)throw new Error('Czas urządzenia jest niepewny. Połącz się z serwerem przed wykonaniem czynności.');
  return account.lastServerTime+Math.max(0,localNow-account.lastLocalTime);
}

/** Time gates protect physical execution even before an offline journal is synced. */
export function executionTimingIssue(type:string,action:Entity,plan:Entity|undefined,actions:Entity[],model:Entity,incident:Entity|undefined,now:number):string|null{
  if(!['start','complete'].includes(type))return null;
  const predecessors:string[]=Array.isArray(action.predecessorIds)?action.predecessorIds:[];
  const previous=predecessors.map(id=>actions.find(candidate=>candidate.planId===action.planId&&(candidate.sourceActionId||candidate.id)===id));
  if(type==='start'&&previous.some(item=>item?.status!=='completed'))return 'Najpierw zakończ poprzednie czynności.';
  if(model.synthetic===true&&incident?.kind==='exercise')return null;
  const reference=Date.parse(plan?.referenceTime),start=Number(action.startMinute),ready=Number(action.readyMinute),end=Number(action.endMinute);
  if(!Number.isFinite(now)||!Number.isFinite(reference)||![start,ready,end].every(Number.isFinite)||start<0||ready<start||end<=ready)return 'Nie można potwierdzić czasu zatwierdzonego harmonogramu. Wymagany przegląd planu.';
  const preparation=(ready-start)*60000;
  if(type==='start'){
    if(now<reference+start*60000)return 'Nie nadszedł jeszcze czas rozpoczęcia w harmonogramie.';
    if(now+preparation>=reference+end*60000)return 'Pozostały czas nie wystarcza na przygotowanie i obsługę. Wymagany nowy plan.';
    const step=Number(plan?.stepMinutes??model.stepMinutes);
    if(previous.length&&(!Number.isFinite(step)||step<=0||previous.some(item=>!Number.isFinite(Date.parse(item?.completedAt))||now<Date.parse(item?.completedAt)+step*60000)))return 'Nie upłynął wymagany odstęp po zakończeniu poprzedniej czynności. Sprawdź harmonogram i czas faktycznego wykonania.';
  }
  if(type==='complete'){
    const started=Date.parse(action.startedAt);
    if(!Number.isFinite(started)||now<started+preparation)return 'Nie upłynął rzeczywisty czas przygotowania wymagany przez zatwierdzony harmonogram.';
  }
  return null;
}
