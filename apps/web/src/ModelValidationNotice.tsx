import { arr, nameOf, type Entity } from './types';
import { Badge, Notice } from './ui';

export function ModelValidationNotice({validation,model}:{validation:Entity|undefined|null;model:Entity}){
  if(!validation)return null;
  const fragments=arr(validation.blockedFragments);
  const name=(fragment:Entity)=>nameOf(arr(model[fragment.kind==='mode'?'modes':fragment.kind==='resource'?'resources':'dependencies']).find(item=>item.id===fragment.id)||{id:fragment.id});
  return <>{validation.valid===false&&<Notice tone="red"><strong>Błędy modelu blokują obliczenia i zatwierdzenie.</strong><ul>{arr(validation.issues).map((issue,index)=><li key={index}>{issue.message}</li>)}</ul></Notice>}{fragments.length>0&&<div className="excluded-fragments"><Notice><strong>Wykluczone fragmenty modelu ({fragments.length})</strong><p>Wskazane tryby, zasoby i zależności nie mogą być użyte w planie. {validation.valid===true?'Poprawne, niezależne fragmenty pozostają dostępne do obliczeń.':'Przed obliczeniem pozostałych fragmentów trzeba usunąć błędy całego modelu.'} Wykluczenie nie potwierdza gotowości usługi.</p></Notice><ul>{fragments.map(fragment=><li key={`${fragment.kind}:${fragment.id}`}><Badge tone="red">Wykluczony</Badge> <strong>{name(fragment)}</strong> ({fragment.kind==='mode'?'tryb':fragment.kind==='resource'?'zasób':'zależność'})<ul>{(fragment.reasons||[]).map((reason:string,index:number)=><li key={index}>{reason}</li>)}</ul></li>)}</ul></div>}</>;
}
