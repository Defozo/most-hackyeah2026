import { useEffect, useRef, useState } from 'react';
import { createDocumentDraft, editDocumentFragment, exportDocumentDraftText, loadDocumentDrafts, saveDocumentDraft, type DocumentDraft } from './document-drafts';
import { type Entity, timeOf } from './types';
import { download } from './db';
import { Badge, Button, Field, Notice, Panel, SectionHeading } from './ui';

export function useDocumentDrafts(scope:string){
  const [drafts,setDrafts]=useState<DocumentDraft[]>([]);const [selected,setSelected]=useState<DocumentDraft|null>(null);
  const [status,setStatus]=useState<'idle'|'saving'|'saved'|'error'>('idle');const [error,setError]=useState('');
  const chain=useRef(Promise.resolve());const scopeRef=useRef(scope);scopeRef.current=scope;
  const latestWrite=useRef(0);
  useEffect(()=>{let alive=true;setDrafts([]);setSelected(null);setStatus('idle');setError('');loadDocumentDrafts(scope).then(rows=>{if(alive)setDrafts(current=>{const combined=new Map(rows.map(row=>[row.id,row]));for(const draft of current)combined.set(draft.id,draft);return [...combined.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));});}).catch(error=>{if(alive){setStatus('error');setError(`Nie odczytano lokalnych szkiców: ${String(error.message||error)}`);}});return()=>{alive=false;};},[scope]);
  async function persist(draft:DocumentDraft){
    const write=++latestWrite.current;setSelected(draft);setStatus('saving');setError('');
    const saved=chain.current.catch(()=>{}).then(()=>saveDocumentDraft(scope,draft));chain.current=saved;
    try{await saved;if(scopeRef.current!==scope)return;setDrafts(rows=>[draft,...rows.filter(row=>row.id!==draft.id)].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));if(write===latestWrite.current)setStatus('saved');}
    catch(error){if(scopeRef.current===scope&&write===latestWrite.current){setStatus('error');setError(`Nie zapisano szkicu na urządzeniu. Zachowaj eksport lub zwolnij pamięć i ponów zapis. ${error instanceof Error?error.message:String(error)}`);}throw error;}
  }
  async function receive(input:Entity){const draft=createDocumentDraft(input);await persist(draft);return draft;}
  function select(draft:DocumentDraft){setSelected(draft);setStatus('saved');setError('');}
  return {drafts,selected,status,error,receive,select,persist,clear:()=>setSelected(null)};
}

export function DocumentDraftLibrary({drafts,error,onOpen}:{drafts:DocumentDraft[];error:string;onOpen:(draft:DocumentDraft)=>void}){
  return <Panel><SectionHeading title="Lokalne szkice dokumentów" action={<Badge>{drafts.length}</Badge>}/><p>Szkice tego konta pozostają na urządzeniu. Import i edycja nie publikują procedury ani nie trafiają do kolejki poleceń.</p>{error&&<Notice tone="red">{error}</Notice>}{drafts.length?<div className="document-draft-list">{drafts.map(draft=><div className="scope-card" key={draft.id}><strong>{draft.source.filename||draft.source.url||'Wpis ręczny'}</strong><p>{draft.fragments.length} fragmentów · zapisano {timeOf(draft.updatedAt)} · nieopublikowany</p><Button onClick={()=>onOpen(draft)} aria-label={`Otwórz szkic ${draft.source.filename||draft.source.url||'Wpis ręczny'}`}>Otwórz zapisany szkic</Button></div>)}</div>:<p className="muted">Brak zapisanych szkiców dokumentów na tym koncie.</p>}</Panel>;
}

export function DocumentDraftEditor({draft,status,error,onSave}:{draft:DocumentDraft;status:string;error:string;onSave:(draft:DocumentDraft)=>Promise<void>}){
  const [fragmentId,setFragmentId]=useState('');const fragment=draft.fragments.find(f=>f.id===fragmentId)||draft.fragments[0];
  return <div className="document-draft-editor"><Notice>Tekst dokumentu jest szkicem. Nie opublikowano procedury. {draft.manualRequired?'Nie udało się odczytać tekstu. Wpisz treść ręcznie.':'Przepisz sprawdzone parametry do modelu wraz ze wskazaniem źródła i fragmentu.'}</Notice><p>Źródło: <strong>{draft.source.filename||draft.source.url||'Wpis ręczny'}</strong>{draft.source.url&&<><br/>Adres: {draft.source.url}</>}<br/>Pobrano: {timeOf(draft.source.retrievedAt)} · status: {draft.source.status}</p>{draft.warnings.length>0&&<Notice>{draft.warnings.join('; ')}</Notice>}<Field label="Fragment dokumentu"><select value={fragment.id} onChange={e=>setFragmentId(e.target.value)}>{draft.fragments.map(f=><option value={f.id} key={f.id}>Fragment {f.index} · {f.source}</option>)}</select></Field><p className="muted">Odniesienie: {fragment.source}, fragment {fragment.index}. Identyfikator: {fragment.id}.</p><details><summary>Oryginalny fragment źródła</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{fragment.originalText||'Brak warstwy tekstowej. Wpis ręczny wymaga sprawdzenia źródła.'}</pre></details><Field label="Szkic tekstu dokumentu"><textarea rows={10} value={fragment.text} onChange={event=>{void onSave(editDocumentFragment(draft,fragment.id,event.target.value)).catch(()=>{});}}/></Field><p role="status">{status==='saving'?'Zapisywanie szkicu…':status==='saved'?'Szkic zapisany lokalnie na tym koncie.':status==='error'?'Zmiany nie zostały zapisane na urządzeniu.':'Szkic nie został jeszcze zapisany.'}</p>{error&&<Notice tone="red">{error}</Notice>}<div className="button-row">{status==='error'&&<Button onClick={()=>{void onSave(draft).catch(()=>{});}}>Ponów zapis szkicu</Button>}<Button onClick={()=>download('most-szkic-dokumentu.json',JSON.stringify(draft,null,2))}>Eksport szkicu ze źródłami</Button><Button onClick={()=>download('szkic-procedury.txt',exportDocumentDraftText(draft),'text/plain')}>Zapisz szkic tekstu</Button></div></div>;
}
