import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Database, Download, HardDriveDownload, RefreshCw, ShieldCheck, Smartphone, Upload, WifiOff } from 'lucide-react';
import { useApp } from './context';
import { arr, nameOf, timeOf, type Entity, type Outbox } from './types';
import { Badge, Button, Empty, Field, Modal, Notice, PageHeading, Panel, SectionHeading, Status } from './ui';
import { db, download, exportDevice, fileHash } from './db';
import { api } from './api';
import { calculate, cancelCalculation } from './planner';
import { procedureCards } from './cards';
import { preparedDeviceIssues, requiresOfflineCache } from './device-readiness';
import { verifyBundleSignature } from './signature';

const bytes=(base64:string)=>Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
function bounded<T>(operation:Promise<T>, milliseconds:number, label:string, signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(new Error(signal.reason instanceof Error?signal.reason.message:`Przerwano: ${label}.`));};
    if(signal.aborted){operation.catch(()=>{});abort();return;}
    timer=setTimeout(()=>{cleanup();reject(new Error(`Przekroczono czas operacji: ${label}. Możesz ponowić przygotowanie; zapisane dane pozostają na urządzeniu.`));},milliseconds);
    signal.addEventListener('abort',abort,{once:true});
    operation.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
async function verifiedFetch(path:string,signal:AbortSignal){
  return bounded((async()=>{const response=await fetch(path,{cache:'no-store',signal});if(!response.ok)throw new Error(`Nie udało się pobrać pliku ${path} (${response.status}).`);return response.blob();})(),30000,`pobieranie ${path}`,signal);
}
async function verifyApplicationFiles(application:Entity,signal:AbortSignal,progress:(label:string)=>void){
  if(!application?.complete||!Array.isArray(application.files)||!application.files.some((f:Entity)=>f.path==='/highs.wasm'))throw new Error('Podpisany pakiet nie zawiera kompletnego manifestu aplikacji. Przygotuj pełne wydanie na serwerze.');
  const cacheStores=await bounded((async()=>Promise.all((await caches.keys()).map(name=>caches.open(name))))(),15000,'otwarcie pamięci aplikacji',signal);
  let checked=0;progress(`Sprawdzanie plików wydania: 0 / ${application.files.length}`);
  for(let offset=0;offset<application.files.length;offset+=8)await Promise.all(application.files.slice(offset,offset+8).map(async(item:Entity)=>{
    if(signal.aborted)throw signal.reason;
    if(!item.path.startsWith('/')||item.path.startsWith('//')||item.path.includes('..'))throw new Error('Nieprawidłowa ścieżka manifestu aplikacji.');
    const mustCache=requiresOfflineCache(item.path);
    let matched=false;
    for(const cache of cacheStores){const response=await bounded(cache.match(item.path,{ignoreSearch:true}),15000,`odczyt pamięci ${item.path}`,signal);if(response){const blob=await bounded(response.blob(),15000,`odczyt pliku ${item.path}`,signal);if(blob.size===item.size&&await bounded(fileHash(blob),15000,`sprawdzenie skrótu ${item.path}`,signal)===item.sha256){matched=true;break;}}}
    if(!matched&&mustCache)throw new Error(`Brak zgodnej kopii offline pliku ${item.path}. Poczekaj na instalację lub zastosuj aktualizację po uzgodnieniu kolejki.`);
    if(!matched){const blob=await verifiedFetch(item.path,signal);if(blob.size!==item.size||await bounded(fileHash(blob),15000,`sprawdzenie skrótu ${item.path}`,signal)!==item.sha256)throw new Error(`Plik wydania ${item.path} nie zgadza się z podpisem.`);}
    checked++;progress(`Sprawdzanie plików wydania: ${checked} / ${application.files.length}`);
  }));
}
export function Device() { const{account,snapshot,run,online,inform}=useApp();const[ready,setReady]=useState<Entity|null>(null);const[storage,setStorage]=useState<Entity|null>(null);const[key,setKey]=useState<Entity|null>(null);const[trusted,setTrusted]=useState(false);const[busy,setBusy]=useState(false);const[phase,setPhase]=useState('');const[readinessIssues,setReadinessIssues]=useState<string[]>([]);const[checking,setChecking]=useState(true);const[devices,setDevices]=useState<Entity[]>([]);
  const preparedReady=Boolean(ready)&&!checking&&readinessIssues.length===0;
  useEffect(()=>{
    let disposed=false;setChecking(true);
    async function check(){
      try{
        const stored=(await db.meta.get(`prepared:${account.scope}`))?.value||null;
        const issues=await preparedDeviceIssues(stored,{serverEpoch:snapshot.serverEpoch,modelRevision:snapshot.model.revision,offlineUntil:account.offlineUntil},async path=>Boolean(await caches.match(path,{ignoreSearch:true})));
        if(!disposed){setReady(stored);setReadinessIssues(issues);setChecking(false);}
      }catch{if(!disposed){setReadinessIssues(['Nie można sprawdzić pamięci offline. Gotowość urządzenia nie jest potwierdzona.']);setChecking(false);}}
    }
    void check();const timer=setInterval(check,30000);
    return()=>{disposed=true;clearInterval(timer);};
  },[account.scope,account.offlineUntil,snapshot.serverEpoch,snapshot.model.revision]);
  useEffect(()=>{let disposed=false;db.meta.get(`trusted-key:${account.scope}`).then(r=>{if(!disposed){setKey(r?.value||null);setTrusted(Boolean(r?.value));}});navigator.storage?.estimate().then(value=>{if(!disposed)setStorage(value);}).catch(()=>{});if(online&&account.user.role==='administrator')api('/api/devices').then(r=>{if(!disposed)setDevices(r.devices||[]);}).catch(()=>{});return()=>{disposed=true;};},[account.scope,online]);
  async function prepare(){
    setBusy(true);setPhase('Sprawdzanie gotowości aplikacji offline…');
    const controller=new AbortController(),signal=controller.signal;
    const deadline=setTimeout(()=>controller.abort(new Error('Przygotowanie przekroczyło 120 s. Sprawdź połączenie i ponów próbę. Dane i kolejka pozostają zapisane.')),120000);
    try{await run(async()=>{try{
      if(!key||!trusted)throw new Error('Najpierw pobierz klucz publiczny i potwierdź jego zgodność z kluczem dostarczonym zaufaną drogą.');
      if(!navigator.serviceWorker)throw new Error('Przeglądarka nie udostępnia Service Worker. Użyj HTTPS lub localhost.');
      const registration=await bounded(navigator.serviceWorker.ready,15000,'instalacja aplikacji offline',signal);
      if(!registration.active)throw new Error('Aplikacja nie została jeszcze zapisana do pracy offline. Otwórz zbudowane wydanie i odśwież stronę.');
      setPhase('Sprawdzanie lokalnego modułu obliczeń…');
      const wasmBlob=await verifiedFetch('/highs.wasm',signal),wasmBytes=await bounded(wasmBlob.arrayBuffer(),15000,'odczyt modułu obliczeń',signal);
      if(!WebAssembly.validate(wasmBytes))throw new Error('Plik obliczeń nie jest prawidłowym modułem WebAssembly.');
      setPhase('Pobieranie podpisanego pakietu organizacji…');
      const bundle=await api('/api/bundle','GET',undefined,{timeoutMs:60000,signal});
      if(bundle.manifest.keyId!==key.keyId)throw new Error('Klucz pakietu różni się od wybranego zaufanego klucza.');
      setPhase('Weryfikowanie podpisu i danych organizacji…');
      const valid=await bounded(verifyBundleSignature(bytes(key.publicKeySpki),bytes(bundle.signature),bytes(bundle.manifestBytes)),15000,'weryfikacja podpisu',signal);
      if(!valid)throw new Error('Nieprawidłowy podpis pakietu.');
      const signed=JSON.parse(new TextDecoder().decode(bytes(bundle.manifestBytes)));
      if(signed.keyId!==key.keyId)throw new Error('Podpisany manifest ma inny klucz.');
      if(new Set(signed.files.map((f:Entity)=>f.path)).size!==signed.files.length)throw new Error('Manifest zawiera powtórzone pliki.');
      if(signed.organizationId!==account.user.organizationId||signed.userId!==account.user.id)throw new Error('Pakiet ma inny zakres konta lub organizacji.');
      if(Date.parse(signed.expiresAt)<=Date.now())throw new Error('Pakiet wygasł.');
      for(const item of signed.files){const file=bundle.files.find((f:Entity)=>f.path===item.path);if(!file)throw new Error(`Brakuje pliku ${item.path}`);const data=bytes(file.content);if(data.length!==item.size||await bounded(fileHash(new Blob([data])),15000,`sprawdzenie ${item.path}`,signal)!==item.sha256)throw new Error(`Niezgodny plik ${item.path}`);}
      await verifyApplicationFiles(signed.application,signal,setPhase);
      setPhase('Zapisywanie zweryfikowanego pakietu…');
      await bounded(db.meta.put({key:`bundle:${account.scope}`,value:bundle}),15000,'zapis pakietu',signal);
      await bounded(db.meta.put({key:`trusted-key:${account.scope}`,value:key}),15000,'zapis zaufanego klucza',signal);
      setPhase('Próba lokalnego planowania na zapisanym modelu…');
      let plan:Entity;
      try{plan=await bounded(calculate('solve',snapshot.model),45000,'uruchomienie lokalnego silnika',signal);}catch(error){cancelCalculation();throw error;}
      if(!plan.validation?.valid)throw new Error('Próba lokalnego planowania nie dała wykonalnego planu.');
      setPhase('Sprawdzanie trwałości pamięci…');
      // A browser may leave its storage permission prompt unanswered. Lack of
      // persistence is displayed honestly and does not prevent offline storage.
      const persistent=await bounded(navigator.storage.persist(),10000,'zgoda na trwałą pamięć',signal).catch(error=>{if(signal.aborted)throw error;return false;});
      const cacheNames=await bounded(caches.keys(),15000,'sprawdzenie magazynów offline',signal);
      const cachesComplete=await bounded(caches.match('/highs.wasm',{ignoreSearch:true}),15000,'sprawdzenie modułu offline',signal);
      if(!cachesComplete)throw new Error('Moduł obliczeń nie znajduje się w pamięci offline. Poczekaj na zakończenie instalacji aplikacji.');
      const result={preparedAt:new Date().toISOString(),modelRevision:snapshot.model.revision,serverEpoch:snapshot.serverEpoch,persistent,signatureVerified:true,manifest:signed,cacheNames,wasmHash:await bounded(fileHash(wasmBlob),15000,'sprawdzenie modułu',signal),solverStatus:plan.status,minimumServiceMinutes:plan.metrics.minimumServiceMinutes,offlineExpiresAt:account.offlineUntil};
      await bounded(db.meta.put({key:`prepared:${account.scope}`,value:result}),15000,'zapis wyniku przygotowania',signal);
      setReady(result);setReadinessIssues([]);setChecking(false);setPhase('Zapis, podpisy i próba obliczeń potwierdzone.');
      navigator.storage.estimate().then(setStorage).catch(()=>{});
      inform('Sprawdzono lokalne pliki, zapis danych i obliczenia. Wykonaj jeszcze zimny start po odłączeniu od serwera.','green');
      }catch(error){setPhase(`Przygotowanie przerwane: ${error instanceof Error?error.message:String(error)}`);throw error;}
    });}finally{clearTimeout(deadline);controller.abort();setBusy(false);}
  }
  return <><PageHeading eyebrow="ODPORNOŚĆ URZĄDZENIA" title="Zabierz plan ze sobą" action={<Button kind="primary" disabled={busy||!online} onClick={prepare}><HardDriveDownload size={17}/>{busy?'Sprawdzanie urządzenia…':'Przygotuj urządzenie'}</Button>}>Aplikacja, model, procedury i obliczenia mają działać także po utracie połączenia z serwerem.</PageHeading>{readinessIssues.length>0&&<Notice tone="amber">{readinessIssues.map(issue=><p key={issue}>{issue}</p>)} Dane i kolejka pozostają zachowane.</Notice>}{phase&&<p role="status" aria-live="polite" className="preparation-progress">{phase}</p>}<div className="device-grid"><Panel className="device-hero"><div className="device-symbol"><Smartphone size={58}/><ShieldCheck size={29}/></div><h2>{preparedReady?'Pakiet lokalny przygotowany':checking?'Sprawdzanie zapisanej gotowości':ready?'Pakiet wymaga ponownego przygotowania':'Przygotowanie przed awarią'}</h2><p>{ready?`Ostatnie sprawdzenie: ${timeOf(ready.preparedAt)}`:'Przygotuj urządzenie w zaufanej sieci, zanim będzie potrzebne do pracy bez łączności.'}</p><Badge tone={preparedReady?'green':'amber'}>{preparedReady?'Zapis i próba obliczenia zakończone':'Bieżąca gotowość niepotwierdzona'}</Badge><p className="muted">Zimny start i próbę na docelowym telefonie sprawdza się osobno.</p></Panel><Panel><SectionHeading title="Kontrola pakietu"/>{[['Aplikacja i plik obliczeń',preparedReady?'Zapisano w pamięci PWA':'Wymaga przygotowania'],['Dane i procedury',`Wersja modelu ${snapshot.model.revision}`],['Ważność dostępu',timeOf(account.offlineUntil)],['Trwała pamięć',ready?.persistent?'Przyznana przez przeglądarkę':'Niepotwierdzona; możliwe usunięcie danych'],['Podpis pakietu',ready?.signatureVerified?'Zweryfikowany wobec wybranego klucza':'Niezweryfikowany'],['Wykorzystanie pamięci',storage?`${((storage.usage||0)/1024/1024).toFixed(1)} MB / ${((storage.quota||0)/1024/1024).toFixed(0)} MB`:'Brak informacji']].map(([label,value])=><div className="device-check" key={label}><span>{label}</span><strong>{value}</strong></div>)}</Panel></div>
  <Panel><SectionHeading title="Zaufany klucz organizacji" eyebrow="POCHODZENIE I INTEGRALNOŚĆ" action={<Button disabled={!online} onClick={()=>run(async()=>{setKey(await api('/api/bundle/key'));setTrusted(false);})}>Pobierz klucz publiczny</Button>}/><p>Podpis potwierdza integralność i pochodzenie względem zaufanego klucza. Nie potwierdza prawdziwości meldunków.</p>{key&&<><p className="fingerprint">Identyfikator: {key.keyId} · {key.algorithm}</p><label className="checkbox"><input type="checkbox" checked={trusted} onChange={e=>setTrusted(e.target.checked)}/>Porównałem identyfikator z kluczem organizacji dostarczonym niezależną, zaufaną drogą.</label></>}</Panel><Panel><SectionHeading title="Próba zimnego startu" eyebrow="SPRAWDŹ W TERENIE"/><ol className="numbered-list"><li>Przygotuj urządzenie i wykonaj eksport kolejki.</li><li>Odłącz urządzenie od serwera, zamknij aplikację i uruchom ją ponownie z tego samego adresu.</li><li>Przejdź do planowania, wyłącz jedną osobę w lokalnym wariancie i oblicz nowy plan.</li><li>Zapisz meldunek, zamknij aplikację i potwierdź, że zapis jest nadal widoczny.</li><li>Po powrocie połączenia uzgodnij kolejkę i sprawdź konflikty.</li></ol><Notice>Przyznanie trwałej pamięci nie zastępuje kopii. Zmiana adresu aplikacji oznacza inny magazyn przeglądarki. Dane i kolejka nie przeniosą się automatycznie.</Notice><div className="button-row"><Button onClick={()=>run(async()=>download('most-urzadzenie.json',JSON.stringify(await exportDevice(account.scope),null,2)))}><Download size={16}/>Eksport danych, plików i kolejki</Button><Button onClick={()=>download('most-karty-procedur.html',procedureCards(snapshot.model),'text/html')}>Eksportuj karty procedur do druku</Button></div></Panel>
  {account.user.role==='administrator'&&<Panel><SectionHeading title="Zarejestrowane urządzenia"/><p>Urządzenie rejestruje się po pierwszej przyjętej komendzie. Cofnięcie prawa nie usuwa zdalnie danych z rozłączonego urządzenia.</p>{devices.map(d=><div className="device-check" key={d.id}><span>{d.name||d.id}<small>{d.user_id}</small></span><strong>{d.revoked?'Cofnięte prawo':'Uprawnione'}</strong><Button disabled={Boolean(d.revoked)} onClick={()=>run(async()=>{await api(`/api/devices/${encodeURIComponent(d.id)}/revoke`,'POST',{});setDevices((await api('/api/devices')).devices);})}>Cofnij prawo</Button></div>)}</Panel>}
  </>;
}

export function Sync() { const{queue,account,snapshot,run,refresh,online,command,reloadLocal}=useApp();const[resolving,setResolving]=useState<Outbox|null>(null);const[checked,setChecked]=useState(false);const pending=queue.filter(q=>q.status!=='accepted'&&!q.result?.resolvedAt);return <><PageHeading eyebrow="JEDEN UZGODNIONY STAN" title="Synchronizacja i konflikty" action={<Button kind="primary" onClick={()=>run(refresh)}><RefreshCw size={17}/>Sprawdź i uzgodnij</Button>}>Oryginały zostają zachowane. Przyjęcie przez serwer jest osobnym etapem od zapisu na telefonie.</PageHeading><div className="sync-summary"><Badge tone={online?'green':'amber'}>{online?'Serwer osiągalny':'Brak połączenia z serwerem'}</Badge><span>{pending.length} zmian do uzgodnienia</span><span>{queue.filter(q=>q.status==='accepted').length} potwierdzonych komend w historii urządzenia</span></div>{!pending.length?<Panel><Empty title="Kolejka jest uzgodniona">Nie ma oczekujących zmian tego konta na tym urządzeniu.</Empty></Panel>:pending.map(row=><Panel key={row.commandId}><div className="observation-head"><div><h3>{row.command.type}</h3><p>Zapis na urządzeniu {timeOf(row.createdAt)} · bazowa wersja {row.command.baseRevision}</p></div><Status value={row.status}/></div><p>{row.command.payload.text||row.command.payload.notes||row.result?.message||'Komenda oczekuje na przyjęcie przez serwer.'}</p>{row.result?.message&&<Notice tone={row.status==='rejected'?'red':'amber'}>{row.result.message}</Notice>}<details><summary>Oryginał, wynik i bieżąca wersja</summary><div className="conflict-columns"><div><h4>Propozycja urządzenia</h4><pre>{JSON.stringify(row.command.payload,null,2)}</pre></div><div><h4>Bieżący stan serwera</h4><p>Epoka {snapshot.serverEpoch}</p><p>Wersja {snapshot.revision}, sekwencja {snapshot.serverSeq}</p><pre>{JSON.stringify({result:row.result,current:row.command.payload.actionId?arr(snapshot.actions).find(a=>a.id===row.command.payload.actionId):row.command.payload.resourceId?arr(snapshot.model.resources).find(r=>r.id===row.command.payload.resourceId):row.command.payload.plan?arr(snapshot.plans).find(p=>p.id===row.command.payload.plan.id):null},null,2)}</pre></div></div></details>{['conflict','rejected'].includes(row.status)&&<Button disabled={!online} onClick={()=>{setResolving(row);setChecked(false);}}>Rozstrzygnij z uzasadnieniem</Button>}</Panel>)}<Panel><SectionHeading title="Przyjęte komendy"/><div className="event-list">{queue.filter(q=>q.status==='accepted').slice(-15).reverse().map(q=><div className="event-row" key={q.commandId}><CheckCircle2 size={16}/><span>{q.command.type}</span><small>{timeOf(q.createdAt)}</small><Status value="accepted"/></div>)}</div><Button onClick={()=>run(async()=>download('most-kolejka.json',JSON.stringify(await exportDevice(account.scope),null,2)))}><Download size={16}/>Zachowaj kopię kolejki</Button></Panel>
  {resolving&&<Modal title="Rozstrzygnięcie konfliktu" wide close={()=>setResolving(null)}><Notice>Nie powtarzaj czynności o skutku fizycznym bez sprawdzenia jej wykonania. Oryginalna komenda pozostanie w historii.</Notice><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);run(async()=>{const decision=String(f.get('decision')),reason=String(f.get('reason'));if(decision==='retry'){if(!checked)throw new Error('Najpierw potwierdź sprawdzenie bieżącego stanu.');const original=resolving.command.payload;const currentAction=arr(snapshot.actions).find(a=>a.id===original.actionId);await command(resolving.command.type,{...original,...(currentAction&&original.expectedVersion!==undefined?{expectedVersion:currentAction.version}:{}),resolutionReason:reason,supersedesCommandId:resolving.commandId});}await db.outbox.update(resolving.commandId,{status:'rejected',result:{...resolving.result,message:`Rozstrzygnięto: ${reason}`,resolution:decision,resolvedAt:new Date().toISOString()}});await reloadLocal();setResolving(null);});}}><Field label="Rozstrzygnięcie"><select name="decision"><option value="retain">Zachowaj oryginał, odstąp od ponowienia</option><option value="retry">Utwórz nową komendę na bieżącej wersji</option></select></Field><Field label="Uzasadnienie i potwierdzony stan"><textarea name="reason" required minLength={10} rows={4}/></Field><label className="checkbox"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>Sprawdzono fizyczny stan, uprawnienia i skutki wcześniejszej komendy.</label><Button kind="primary" type="submit">Zapisz rozstrzygnięcie</Button></form></Modal>}
  </>;
}


