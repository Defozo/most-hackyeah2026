import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, type Node, type Edge, MarkerType, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { List, Network, Waypoints } from 'lucide-react';
import { useApp } from './context';
import { calculate } from './planner';
import { arr, nameOf, stateLabel, type Entity } from './types';
import { Badge, Button, Notice, PageHeading, Panel, SectionHeading, Status } from './ui';
import { ModelValidationNotice } from './ModelValidationNotice';

export function Graph() { const{snapshot,run}=useApp();const model=snapshot.model;const[evaluation,setEvaluation]=useState<Entity|null>(null);const[positions,setPositions]=useState<Record<string,any>>({});const[selected,setSelected]=useState('');const[textOnly,setTextOnly]=useState(false);const[error,setError]=useState('');
  useEffect(()=>{let current=true;setEvaluation(null);setError('');calculate('evaluate',model).then(result=>{if(current)setEvaluation(result);}).catch(error=>{if(current)setError(error.message);});return()=>{current=false;};},[model]);
  const graphDependencies=useMemo<Entity[]>(()=>{
    const existing=arr(model.dependencies);const known=new Set(existing.map(d=>d.id));const missing=new Set<string>();
    for(const dependency of existing)for(const id of [...(dependency.inputs||[]),...(dependency.commonCauseId?[dependency.commonCauseId]:[])])if(!known.has(id))missing.add(id);
    return [...existing,...[...missing].map(id=>({id,name:`Brak definicji: ${id}`,kind:'missing',inputs:[],state:'unknown',missing:true}))];
  },[model]);
  const edges=useMemo<Edge[]>(()=>arr(model.dependencies).flatMap(d=>[
    ...(d.inputs||[]).map((input:string)=>({id:`${input}-${d.id}`,source:input,target:d.id,markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:'#b2c4bf',strokeWidth:2}})),
    ...(d.commonCauseId?[{id:`${d.commonCauseId}-${d.id}-common`,source:d.commonCauseId,target:d.id,label:'Wspólna przyczyna',markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:'#9b6241',strokeWidth:2,strokeDasharray:'5 3'}}]:[])
  ]),[model]);
  useEffect(()=>{
    let current=true;let worker:Worker|undefined;let deadline:ReturnType<typeof setTimeout>|undefined;
    setPositions({});
    try {
      // ELK's bundled fake worker detects a WorkerGlobalScope as its own runtime.
      // Use the supported API + dedicated classic worker so it cannot overwrite
      // a wrapper worker's message handler or lose its exported constructor.
      worker=new Worker(elkWorkerUrl);const layoutWorker=worker;
      const elk=new ELK({workerFactory:()=>layoutWorker});
      worker.onerror=event=>{if(current)setError(`Układ grafu: ${event.message || 'nie udało się uruchomić obliczeń'}`);};
      deadline=setTimeout(()=>{if(current){setError('Układ grafu przekroczył limit 15 sekund. Widok tekstowy pozostaje dostępny.');worker?.terminate();}},15000);
      elk.layout({id:'root',layoutOptions:{'elk.algorithm':'layered','elk.direction':'RIGHT','elk.spacing.nodeNode':'35','elk.layered.spacing.nodeNodeBetweenLayers':'70'},children:graphDependencies.map(n=>({id:n.id,width:205,height:82})),edges:edges.map(edge=>({id:edge.id,sources:[edge.source],targets:[edge.target]}))})
        .then(graph=>{if(current)setPositions(Object.fromEntries((graph.children||[]).map(n=>[n.id,{x:n.x??0,y:n.y??0}])));})
        .catch(error=>{if(current)setError(`Układ grafu: ${error.message || String(error)}`);})
        .finally(()=>{if(deadline)clearTimeout(deadline);});
    }catch(error){setError(`Układ grafu: ${error instanceof Error?error.message:String(error)}`);}
    return()=>{current=false;if(deadline)clearTimeout(deadline);worker?.terminate();};
  },[graphDependencies,edges]);
  const validation=evaluation?.validation||snapshot.modelValidation;const excluded=new Set(arr(validation?.blockedFragments).filter(f=>f.kind==='dependency').map(f=>f.id));
  const nodes:Node[]=graphDependencies.map((d,index)=>{const blocked=excluded.has(d.id)||d.missing;const state=blocked?'unknown':evaluation?.states?.[d.id]||d.state||'unknown';return{id:d.id,sourcePosition:Position.Right,targetPosition:Position.Left,position:positions[d.id]||{x:(index%4)*260,y:Math.floor(index/4)*130},data:{label:<div className="dependency-node"><span>{d.missing?'BRAK DEFINICJI':d.kind==='leaf'?'ZASÓB':d.kind==='and'?'WSZYSTKIE WARUNKI · AND':'DOWOLNY WARUNEK · OR'}</span><strong>{d.name}</strong><small>{blocked?'Wykluczony z planowania':stateLabel(state)}</small></div>},className:`graph-node ${blocked?'unavailable':state}`,style:{width:205},selected:d.id===selected};});const dependency=graphDependencies.find(d=>d.id===selected);const cuts=arr(evaluation?.cutSets).find(c=>c.dependencyId===selected);
  return <><PageHeading eyebrow="WSPÓLNE PRZYCZYNY" title="Zobacz, od czego zależysz" action={<Button onClick={()=>setTextOnly(v=>!v)}>{textOnly?<Network size={17}/>:<List size={17}/>} {textOnly?'Pokaż graf':'Widok tekstowy'}</Button>}>Niezależne łącza mogą zależeć od tego samego routera, zasilania lub pomieszczenia.</PageHeading><ModelValidationNotice validation={validation} model={model}/>{error&&<Notice tone="red">Analiza zależności nie została zakończona: {error}. Widok tekstowy zachowuje dane źródłowe.</Notice>}<Notice>Potwierdzona awaria jednego wejścia AND wyłącza tryb. W OR wystarczy jedno potwierdzone dostępne wejście. „Nieznany” pozostaje osobnym stanem.</Notice>{!textOnly&&<Panel className="graph-panel"><ReactFlow key={Object.keys(positions).length?'layout':'initial'} nodes={nodes} edges={edges} fitView fitViewOptions={{padding:.2}} onNodeClick={(_,node)=>setSelected(node.id)} nodesDraggable={false} proOptions={{hideAttribution:true}} minZoom={.2} maxZoom={1.8}><Background gap={25} color="#e0e6df"/><Controls showInteractive={false}/></ReactFlow></Panel>}
  {dependency&&<Panel><SectionHeading title={dependency.name} eyebrow="WYJAŚNIENIE" action={excluded.has(dependency.id)||dependency.missing?<Badge tone="red">Wykluczony z planowania</Badge>:<Status value={evaluation?.states?.[dependency.id]||dependency.state}/>}/><p>{(evaluation?.reasons?.[dependency.id]||[]).join('; ')}</p>{cuts&&<><h3>Zestawy wystarczające do awarii</h3><div className="resource-chips">{(cuts.sets||[]).map((set:string[],index:number)=><Badge tone="amber" key={index}>{set.map(id=>nameOf(arr(model.dependencies).find(d=>d.id===id))).join(' + ')}</Badge>)}</div><p className="muted">{cuts.complete?'Analiza zakończona w podanym zakresie.':`Analiza częściowa. Limit ${cuts.limit}; nie wykluczono innych zestawów.`}</p></>}</Panel>}
  <Panel><SectionHeading title="Tekstowa mapa zależności" eyebrow="RÓWNOWAŻNY ODCZYT"/><div className="table-scroll"><table><thead><tr><th>Element</th><th>Warunek</th><th>Wejścia</th><th>Stan</th><th>Wspólna przyczyna</th></tr></thead><tbody>{graphDependencies.map(d=><tr key={d.id}><td><button className="plain-link" onClick={()=>setSelected(d.id)}>{d.name}</button></td><td>{d.kind==='and'?'Wszystkie (AND)':d.kind==='or'?'Co najmniej jeden (OR)':'Obserwowany element'}</td><td>{(d.inputs||[]).map((id:string)=>nameOf(graphDependencies.find(n=>n.id===id))).join(', ')||'Bez wejść'}</td><td>{excluded.has(d.id)||d.missing?<Badge tone="red">Wykluczony z planowania</Badge>:<Status value={evaluation?.states?.[d.id]||d.state}/>}</td><td>{d.commonCauseId||'Nie wskazano'}</td></tr>)}</tbody></table></div></Panel></>;
}
