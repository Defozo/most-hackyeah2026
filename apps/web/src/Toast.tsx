import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

function toastTarget(){
  const dialog=Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
  return dialog?.querySelector<HTMLElement>('.modal-toast-host')||dialog||document.body;
}

/** A single live message must stay within a native dialog's active top layer. */
export function Toast({message,tone,close}:{message:string;tone:string;close:()=>void}){
  const [target,setTarget]=useState<HTMLElement|null>(null);
  const focusBefore=useRef<HTMLElement|null>(null);const element=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const update=()=>setTarget(current=>{const next=toastTarget();return current===next?current:next;});
    update();
    const observer=new MutationObserver(update);
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
    return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    const active=document.activeElement;
    if(active instanceof HTMLElement&&!element.current?.contains(active))focusBefore.current=active;
  },[target,message]);
  function dismiss(){
    const previous=focusBefore.current;const dialog=target?.closest('dialog');
    close();
    if(previous?.isConnected&&(!dialog||dialog.contains(previous)))previous.focus({preventScroll:true});
    else dialog?.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])')?.focus({preventScroll:true});
  }
  if(!target)return null;
  return createPortal(<div ref={element} role={tone==='red'?'alert':'status'} aria-live={tone==='red'?'assertive':'polite'} aria-atomic="true" className={`toast ${tone}`}><div><strong>{tone==='red'?'Działanie wymaga uwagi':tone==='green'?'Zapis potwierdzony':'Informacja'}</strong><p>{message}</p></div><button type="button" onClick={dismiss} aria-label="Zamknij komunikat"><X size={18}/></button></div>,target);
}
