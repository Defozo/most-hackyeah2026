import type { Entity } from './types';

interface ActiveCalculation {
  id:string; type:string; budgetMs:number; requestedAt:number;
  resolve:(result:Entity)=>void; reject:(error:Error)=>void;
  deadline?:number; timer?:ReturnType<typeof setTimeout>; latest?:Entity; fallback?:Entity; ranking?:Entity;
}
let worker:Worker|null=null;
let active:ActiveCalculation|null=null;
const now=()=>performance.timeOrigin+performance.now();
function stopWorker(){worker?.terminate();worker=null;}
function release(running:ActiveCalculation){if(running.timer)clearTimeout(running.timer);if(active?.id===running.id)active=null;}
function interrupted(running:ActiveCalculation,cancelled=false){
  if(active?.id!==running.id)return;
  release(running);stopWorker();
  const reason=cancelled?'Obliczenie anulowano.':`Przerwano obliczenie po limicie ${running.budgetMs/1000} s.`;
  if(running.type==='solve'&&running.latest?.validation?.valid===true){
    const plan=structuredClone(running.latest);
    plan.status='feasible';
    plan.solver={...plan.solver,completeHierarchy:false,budgetMs:running.budgetMs,interruption:cancelled?'cancelled':'deadline',timings:{...plan.solver?.timings,totalMs:now()-running.requestedAt,watchdogElapsedMs:running.deadline===undefined?0:now()-(running.deadline-running.budgetMs)}};
    plan.diagnostics=[...(plan.diagnostics||[]),`${reason} Zachowano ostatni niezależnie sprawdzony plan. Nie dowiedziono optimum.`];
    running.resolve(plan);
  }else if(running.type==='rank'&&running.ranking){
    const result=structuredClone(running.ranking);
    result.complete=false;result.interruption=cancelled?'cancelled':'deadline';result.budgetMs=running.budgetMs;
    result.elapsedMs=now()-running.requestedAt;
    result.scope=[...(result.scope||[]),`${reason} Ranking jest częściowy. Niesprawdzone pytania nie mają przypisanej zerowej wartości.`];
    running.resolve(result);
  }else if(!cancelled&&running.type==='solve'&&running.fallback){
    const result=structuredClone(running.fallback);
    result.status='no_solution';result.validation={valid:false,issues:[],warnings:[]};
    result.solver={...result.solver,completeHierarchy:false,budgetMs:running.budgetMs,interruption:'deadline',timings:{...result.solver?.timings,totalMs:now()-running.requestedAt,watchdogElapsedMs:running.deadline===undefined?0:now()-(running.deadline-running.budgetMs)}};
    result.diagnostics=[...(result.diagnostics||[]),`${reason} Nie uzyskano niezależnie sprawdzonego planu. Nie jest to dowód niewykonalności.`];
    running.resolve(result);
  }else running.reject(new Error(`${reason} ${running.type==='rank'?'Nie ukończono porównania odpowiedzi. Poprzedni ranking pozostaje widoczny.':'Nie uzyskano nowego, niezależnie sprawdzonego wyniku. To nie jest dowód niewykonalności. Poprzedni zakończony wynik pozostaje zapisany.'}`));
}
export function calculate(type:string,model:Entity,extra:Entity={}):Promise<any>{
  if(active)return Promise.reject(new Error('Obliczenie już trwa. Poczekaj na wynik lub je anuluj.'));
  const budgetMs=extra.budgetMs??5000;
  if(!Number.isFinite(budgetMs)||budgetMs<1||budgetMs>30000)return Promise.reject(new Error('Budżet obliczenia musi wynosić od 1 ms do 30 s.'));
  if(!worker){try{worker=new Worker(new URL('./planner.worker.ts',import.meta.url),{type:'module'});}catch(error){return Promise.reject(error);}}
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const running:ActiveCalculation={id,type,budgetMs,requestedAt:now(),resolve,reject};active=running;
    worker!.onmessage=e=>{
      if(e.data.id!==active?.id)return;
      if(e.data.event==='solver-start'){
        // One wall-clock deadline covers every objective and ranking variant.
        if(running.deadline===undefined){if(e.data.plan?.status==='no_solution')running.fallback=e.data.plan;const startedAt=Number.isFinite(e.data.startedAt)?e.data.startedAt:now();const deadline=Number(startedAt)+budgetMs;running.deadline=deadline;running.timer=setTimeout(()=>interrupted(running),Math.max(0,deadline-now()));}
        return;
      }
      if(e.data.event==='solver-progress'){
        if(type==='solve'&&e.data.plan?.validation?.valid===true&&(!running.deadline||now()<running.deadline))running.latest=e.data.plan;
        return;
      }
      if(e.data.event==='ranking-progress'){
        if(type==='rank'&&Array.isArray(e.data.ranking?.items)&&Array.isArray(e.data.ranking?.unexaminedIds)&&(!running.deadline||now()<running.deadline))running.ranking=e.data.ranking;
        return;
      }
      if(running.deadline!==undefined&&now()>=running.deadline){interrupted(running);return;}
      release(running);
      e.data.error?reject(new Error(e.data.error)):resolve(e.data.result);
    };
    worker!.onerror=e=>{if(active?.id!==running.id)return;release(running);stopWorker();reject(new Error(e.message||'Nie udało się uruchomić lokalnego silnika.'));};
    try{worker!.postMessage({id,type,model,...extra,budgetMs});}catch(error){release(running);stopWorker();reject(error instanceof Error?error:new Error(String(error)));}
  });
}
export function cancelCalculation(){if(active)interrupted(active,true);else stopWorker();}

