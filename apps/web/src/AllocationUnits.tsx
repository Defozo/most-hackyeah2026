import type { Entity } from './types';

export function AllocationUnits({allocation}:{allocation:Entity}){
  const ids:string[]=Array.isArray(allocation.unitIds)?allocation.unitIds:[];
  if(!ids.length)return null;
  return <details><summary>Jednostki: {ids.map(id=>id.startsWith(`${allocation.resourceId}#`)?id.slice(allocation.resourceId.length+1):id).join(', ')}</summary><p>Logiczne sztuki puli. Przed rozpoczęciem przypisz im oznaczenia fizycznych egzemplarzy.</p><span>Identyfikatory w modelu: {ids.join(', ')}</span></details>;
}
