import { db } from './db';
import { arr, type Entity } from './types';

export interface DraftFragment { id:string; index:number; source:string; originalText:string; text:string }
export interface DocumentDraft {
  id:string; version:1; published:false; createdAt:string; updatedAt:string;
  source:{filename?:string;url?:string;format:string;retrievedAt:string;status:string;hash?:string;originalText:string};
  fragments:DraftFragment[]; manualRequired:boolean; warnings:string[];
}

export function createDocumentDraft(input:Entity, timestamp=new Date().toISOString()):DocumentDraft {
  const id=crypto.randomUUID();const originalText=String(input.sourceText??input.text??input.content??'');
  const sourceName=String(input.filename||input.url||'Wpis ręczny');
  const fragments=arr(input.fragments).length?arr(input.fragments):originalText.split(/\n\s*\n/).filter(Boolean).map((text,index)=>({index:index+1,text,source:sourceName}));
  if(!fragments.length)fragments.push({index:1,text:'',source:sourceName});
  return {id,version:1,published:false,createdAt:timestamp,updatedAt:timestamp,
    source:{filename:input.filename,url:input.url,format:String(input.format||(input.url?'public-source':'text')),retrievedAt:String(input.retrievedAt||timestamp),status:String(input.status||'extracted_draft'),hash:input.hash,originalText},
    fragments:fragments.map((fragment,index)=>({id:`${id}:fragment:${index+1}`,index:Number(fragment.index)||index+1,source:String(fragment.source||sourceName),originalText:String(fragment.text||''),text:String(fragment.text||'')})),
    manualRequired:input.manualRequired===true,warnings:Array.isArray(input.warnings)?input.warnings.map(String):[]};
}

export function editDocumentFragment(draft:DocumentDraft,fragmentId:string,text:string,timestamp=new Date().toISOString()):DocumentDraft {
  if(!draft.fragments.some(fragment=>fragment.id===fragmentId))throw new Error('Nie znaleziono fragmentu szkicu.');
  return {...draft,published:false,updatedAt:timestamp,fragments:draft.fragments.map(fragment=>fragment.id===fragmentId?{...fragment,text}:fragment)};
}

export async function saveDocumentDraft(scope:string,draft:DocumentDraft):Promise<void> {
  // No outbox command: imported text is an account-scoped, unpublished local draft.
  await db.proposals.put({id:`${scope}:document:${draft.id}`,scope,type:'document.draft',payload:structuredClone(draft),createdAt:draft.updatedAt});
}
export async function loadDocumentDrafts(scope:string):Promise<DocumentDraft[]> {
  return (await db.proposals.where('scope').equals(scope).toArray()).filter(row=>row.type==='document.draft').map(row=>row.payload as DocumentDraft)
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
}
export function exportDocumentDraftText(draft:DocumentDraft):string {
  return [`SZKIC NIEOPUBLIKOWANY`, `Dokument: ${draft.source.filename||draft.source.url||'Wpis ręczny'}`,`Adres: ${draft.source.url||'Nie dotyczy'}`,`Pobrano: ${draft.source.retrievedAt}`,`Status źródła: ${draft.source.status}`,`Zmieniono szkic: ${draft.updatedAt}`,'',...draft.fragments.flatMap(fragment=>[`[Fragment ${fragment.index}; źródło: ${fragment.source}; identyfikator: ${fragment.id}]`,fragment.text,''])].join('\n');
}
