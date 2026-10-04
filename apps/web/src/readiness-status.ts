import { arr, nameOf, type Entity, type Snapshot } from './types';

const parameterGroups=[
  ['services','Usługa','minimum, priorytet i tolerowana przerwa'],
  ['modes','Tryb','poziom usługi, czas przygotowania, wymagania i autonomia'],
  ['resources','Zasób','ilość, dostępność, kompetencje i zgodność'],
  ['dependencies','Zależność','warunki i stan zależności'],
  ['procedures','Procedura','kroki, warunki i wersja procedury'],
  ['verificationContracts','Kontrakt testu','kryterium, pomiar i ważność testu'],
];
export function readinessDetails(snapshot:Snapshot,now=Date.now()){
  const model=snapshot.model;
  const parameterIssues=parameterGroups.flatMap(([key,label,parameters])=>arr(model[key]).flatMap(item=>{
    const provenance=item.provenance;const missing=[];
    if(!provenance?.source?.trim())missing.push('źródło');
    if(typeof provenance?.checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(provenance.checkedAt)||!Number.isFinite(Date.parse(provenance.checkedAt)))missing.push('prawidłowa data sprawdzenia');
    return missing.length?[{id:`${key}:${item.id}`,entityId:item.id,name:`${label}: ${nameOf(item)}`,parameters,reason:`Brak: ${missing.join(', ')}.`}]:[];
  }));
  const trials=arr(snapshot.readinessTrials).slice().sort((a,b)=>String(b.approvedAt).localeCompare(String(a.approvedAt))||String(a.id).localeCompare(String(b.id)));
  const modes=arr(model.modes).map(mode=>{
    const storedTrial=trials.find(t=>t.modeId===mode.id);
    const expiry=storedTrial?.verificationValidUntil||arr(snapshot.verifications).find(v=>v.id===storedTrial?.verificationId)?.validUntil;
    const trial:Entity|undefined=storedTrial?{...storedTrial,current:storedTrial.current===true&&(!expiry||Date.parse(expiry)>now)}:undefined;const updates:string[]=[];
    const excluded=arr(snapshot.modelValidation?.blockedFragments).find(fragment=>fragment.kind==='mode'&&fragment.id===mode.id);
    if(excluded)updates.push(`Tryb wykluczony z planowania: ${(excluded.reasons||[]).join('; ')}`);
    if(snapshot.modelValidation?.valid===false)updates.push('Błędy całego modelu blokują obliczenia i zatwierdzenie. Najpierw popraw strukturę danych.');
    if(!trial)updates.push('Brak odebranej próby na znanym dobrym stanie.');
    else {
      const contract=arr(model.verificationContracts).find(c=>c.id===mode.verificationContractId);
      if(trial.current!==true)updates.push('Brak bieżącego pozytywnego testu z kompletnym dowodem. Powtórz próbę i odbiór.');
      if(trial.procedureVersion!==mode.procedureVersion)updates.push(`Procedura zmieniła się z v${trial.procedureVersion} na v${mode.procedureVersion}. Sprawdź kroki i powtórz próbę.`);
      if(contract&&trial.contractVersion!==contract.version)updates.push(`Kontrakt testu zmienił się z v${trial.contractVersion} na v${contract.version}. Powtórz pomiar według bieżących kryteriów.`);
      if(trial.observedSetupMinutes>mode.setupMinutes)updates.push(`Czas przygotowania: model ${mode.setupMinutes} min, zmierzono ${trial.observedSetupMinutes} min. Zatwierdź aktualizację tego parametru.`);
      if(trial.measuredLevel<mode.level)updates.push(`Poziom usługi: model ${mode.level}, zmierzono ${trial.measuredLevel}. Sprawdź parametr wydajności i minimum usługi.`);
      if(trial.requiresModelReview&&!updates.some(issue=>issue.startsWith('Czas przygotowania:')||issue.startsWith('Poziom usługi:')))updates.push('Próba wskazuje wymagany przegląd parametrów. Właściciel musi osobno zatwierdzić zmianę modelu.');
    }
    return {mode,trial,updates,excluded:!!excluded,ready:!!trial&&updates.length===0};
  });
  return {parameterIssues,modes,latestTrial:trials[0] as Entity|undefined};
}
