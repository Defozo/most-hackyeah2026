import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from './db';
import { createDocumentDraft, editDocumentFragment, exportDocumentDraftText, loadDocumentDrafts, saveDocumentDraft } from './document-drafts';

afterEach(()=>vi.restoreAllMocks());
describe('unpublished local document drafts',()=>{
  it('keeps original source fragments and their stable references when editing extracted text',()=>{
    const original=createDocumentDraft({filename:'procedura.docx',format:'docx',sourceText:'Pierwszy\n\nDrugi',fragments:[{index:3,source:'procedura.docx, akapit 3',text:'Pierwszy'},{index:7,source:'procedura.docx, akapit 7',text:'Drugi'}]});
    const edited=editDocumentFragment(original,original.fragments[1].id,'Sprawdzona korekta');
    expect(edited.fragments[1]).toEqual({...original.fragments[1],text:'Sprawdzona korekta'});
    expect(original.fragments[1].text).toBe('Drugi');expect(edited.source.originalText).toBe('Pierwszy\n\nDrugi');expect(edited.published).toBe(false);
    const exported=exportDocumentDraftText(edited);expect(exported).toContain('[Fragment 7; źródło: procedura.docx, akapit 7;');expect(exported).toContain('Sprawdzona korekta');
    expect(JSON.parse(JSON.stringify(edited)).fragments[1].originalText).toBe('Drugi');
  });
  it('preserves public URL, acquisition time/status/hash and paragraph references',()=>{
    const draft=createDocumentDraft({url:'https://example.gov/procedura',retrievedAt:'2026-10-03T10:00:00Z',status:'retrieved',hash:'source-hash',text:'Część A\n\nCzęść B'});
    expect(draft.source).toMatchObject({url:'https://example.gov/procedura',retrievedAt:'2026-10-03T10:00:00Z',status:'retrieved',hash:'source-hash',format:'public-source'});
    expect(draft.fragments).toHaveLength(2);expect(draft.fragments.every(f=>f.source==='https://example.gov/procedura')).toBe(true);
    expect(exportDocumentDraftText(draft)).toContain('https://example.gov/procedura');
  });
  it('offers an editable referenced fragment when extraction has no text',()=>{
    const draft=createDocumentDraft({filename:'skan.pdf',format:'pdf',sourceText:'',manualRequired:true,warnings:['Brak warstwy tekstowej.']});
    expect(draft.fragments[0]).toMatchObject({source:'skan.pdf',originalText:'',text:'',index:1});
    expect(editDocumentFragment(draft,draft.fragments[0].id,'Ręcznie sprawdzone dane').manualRequired).toBe(true);
  });
  it('round-trips edited drafts separately for each account and never adds an outbox command',async()=>{
    const rows=new Map<string,any>();const outbox=vi.spyOn(db.outbox,'add');
    vi.spyOn(db.proposals,'put').mockImplementation((row:any)=>{rows.set(row.id,structuredClone(row));return Dexie.Promise.resolve(row.id);});
    vi.spyOn(db.proposals,'where').mockReturnValue({equals:(scope:string)=>({toArray:async()=>[...rows.values()].filter(row=>row.scope===scope)})} as any);
    const draft=createDocumentDraft({filename:'same.pdf',sourceText:'Pierwotna treść'});await saveDocumentDraft('org:alice',draft);
    const edit=editDocumentFragment(draft,draft.fragments[0].id,'Tylko konto Bob');await saveDocumentDraft('org:bob',edit);
    expect((await loadDocumentDrafts('org:alice'))[0].fragments[0].text).toBe('Pierwotna treść');expect((await loadDocumentDrafts('org:bob'))[0].fragments[0].text).toBe('Tylko konto Bob');
    expect(await loadDocumentDrafts('other-org:alice')).toEqual([]);expect(outbox).not.toHaveBeenCalled();expect(rows.size).toBe(2);
  });
  it('rejects a failed quota write instead of claiming persistence',async()=>{
    const failure=new DOMException('Brak miejsca','QuotaExceededError');vi.spyOn(db.proposals,'put').mockRejectedValue(failure);
    await expect(saveDocumentDraft('org:alice',createDocumentDraft({filename:'draft.pdf',text:'Ważna notatka'}))).rejects.toBe(failure);
  });
});
