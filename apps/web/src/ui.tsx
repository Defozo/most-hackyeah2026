import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, CircleHelp, Loader2, X } from 'lucide-react';
import { stateLabel } from './types';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Status({ value }: { value: string | undefined }) { const tone = ['available','passed','approved','accepted','optimal','confirmed','complete'].includes(value || '') ? 'green' : ['unavailable','failed','rejected','conflict','invalid_model'].includes(value || '') ? 'red' : ['unknown','pending','needs_review','unverified','waiting'].includes(value || '') ? 'amber' : 'neutral'; return <Badge tone={tone}>{tone === 'green' ? <Check size={12}/> : tone === 'red' ? <AlertTriangle size={12}/> : <CircleHelp size={12}/>} {stateLabel(value)}</Badge>; }
export function Button({ children, onClick, type = 'button', kind = 'secondary', disabled, className = '', ...rest }: { children: ReactNode; onClick?: () => void; type?: 'button'|'submit'; kind?: string; disabled?: boolean; className?: string; [key: string]: any }) { return <button type={type} className={`button ${kind} ${className}`} onClick={onClick} disabled={disabled} {...rest}>{children}</button>; }
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`panel ${className}`}>{children}</section>; }
export function SectionHeading({ eyebrow, title, children, action }: { eyebrow?: string; title: string; children?: ReactNode; action?: ReactNode }) { return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{children && <p>{children}</p>}</div>{action}</div>; }
export function PageHeading({ eyebrow, title, children, action }: { eyebrow?: string; title: string; children?: ReactNode; action?: ReactNode }) { return <header className="page-heading"><div><span className="eyebrow">{eyebrow || 'CENTRUM CIĄGŁOŚCI'}</span><h1>{title}</h1>{children && <p>{children}</p>}</div>{action}</header>; }
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) { return <div className="empty"><CircleHelp size={28}/><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function Notice({ children, tone = 'amber' }: { children: ReactNode; tone?: string }) { return <div className={`notice ${tone}`}>{tone === 'green' ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>}<div>{children}</div></div>; }
export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) { return <label className="field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>; }
function modalFocusTargets(dialog:HTMLDialogElement){
  const candidates=Array.from(dialog.querySelectorAll<HTMLElement>('a[href],area[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"],audio[controls],video[controls]'));
  return candidates.filter(element=>{
    if(element.tabIndex<0||element.matches(':disabled')||element.closest('[hidden],[inert]')||!element.getClientRects().length)return false;
    const visibility=getComputedStyle(element).visibility;if(visibility==='hidden'||visibility==='collapse')return false;
    for(let parent=element.parentElement;parent&&parent!==dialog;parent=parent.parentElement){
      if(parent instanceof HTMLDetailsElement&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(element))return false;
    }
    return true;
  }).sort((a,b)=>(a.tabIndex>0?a.tabIndex:Infinity)-(b.tabIndex>0?b.tabIndex:Infinity));
}
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const titleId=useId(),ref=useRef<HTMLDialogElement>(null),closeRef=useRef(close);closeRef.current=close;
  useEffect(()=>{
    const dialog=ref.current,opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    // Native modal dialogs keep keyboard focus inside and make the background inert.
    if(dialog&&!dialog.open)dialog.showModal();
    const cancel=(event:Event)=>{event.preventDefault();closeRef.current();};
    const tab=(event:KeyboardEvent)=>{
      if(event.key!=='Tab'||!dialog?.open||Array.from(document.querySelectorAll('dialog[open]')).at(-1)!==dialog)return;
      const targets=modalFocusTargets(dialog);event.preventDefault();
      if(!targets.length){dialog.focus({preventScroll:true});return;}
      const index=targets.indexOf(document.activeElement as HTMLElement);
      const next=index<0?(event.shiftKey?targets.length-1:0):(index+(event.shiftKey?-1:1)+targets.length)%targets.length;
      targets[next].focus();
    };
    dialog?.addEventListener('cancel',cancel);
    document.addEventListener('keydown',tab,true);
    return()=>{document.removeEventListener('keydown',tab,true);dialog?.removeEventListener('cancel',cancel);dialog?.close();if(opener?.isConnected)opener.focus({preventScroll:true});};
  },[]);
  return <dialog ref={ref} aria-labelledby={titleId} className={wide?'wide':''} onClick={e=>{if(e.target===e.currentTarget)close();}}><div className="modal-header"><div className="modal-head"><h2 id={titleId}>{title}</h2><Button kind="icon" onClick={close} aria-label="Zamknij"><X size={20}/></Button></div><div className="modal-toast-host"/></div><div className="modal-content">{children}</div></dialog>;
}
export function Submit({ busy, children = 'Zapisz' }: { busy: boolean; children?: ReactNode }) { return <Button type="submit" kind="primary" disabled={busy}>{busy ? <Loader2 size={17} className="spin"/> : <Check size={17}/>} {children}</Button>; }
export function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowRight size={15}/></button>; }

