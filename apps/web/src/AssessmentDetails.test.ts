import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssessmentDetails } from './AssessmentDetails';
import { AppContext, type AppContextValue } from './context';

function render(assessments:any[]){const snapshot={model:{services:[{id:'water',name:'Dystrybucja wody'}],modes:[{id:'pump',name:'Pompa z agregatem'}],dependencies:[{id:'power',name:'Zasilanie'}],resources:[]},users:[{id:'coordinator',displayName:'Koordynator'}],observations:[{id:'contradiction',source:'Drugi dyżur',original:'Sprzeczna informacja',observedState:'available'}],assessments};return renderToStaticMarkup(createElement(AppContext.Provider,{value:{snapshot} as unknown as AppContextValue},createElement(AssessmentDetails,{observation:{id:'observation'}}))); }
describe('assessment impact visible beside the original observation',()=>{
  it('renders linked impact, missing checks, source contradictions and escaped rationale',()=>{
    const output=render([{id:'assessment',observationIds:['observation'],state:'unavailable',approvedBy:'coordinator',approvedAt:'2026-10-03T12:00:00Z',reason:'Pomiar <script>nie wykonuj</script>',contradictions:['contradiction'],computedImpact:{computedAt:'2026-10-03T12:00:00Z',modelRevision:2,affectedServiceIds:['water'],affectedModeIds:['pump'],affectedActionIds:['action'],dependencyChanges:[{id:'power',before:'unknown',after:'unavailable'}],missingChecks:[{subjectId:'power',state:'unknown',question:'Sprawdź zasilanie z dyżurnym',contact:'Zatwierdzony kanał 1',verificationMinutes:5}],requiresReplanning:true}}]);
    for(const text of ['Dystrybucja wody','Pompa z agregatem','Sprawdź zasilanie z dyżurnym','Zatwierdzony kanał 1','Sprzeczna informacja','Przelicz plan'])expect(output).toContain(text);
    expect(output).toContain('&lt;script&gt;');expect(output).not.toContain('<script>');
    expect(output).toContain('Dostępne usługominuty i harmonogram wymagają osobnego obliczenia.');
  });
  it('does not imply that an unassessed or unrelated observation has confirmed impact',()=>{
    const output=render([{id:'other',observationIds:['different'],computedImpact:{affectedServiceIds:['water']}}]);
    expect(output).toContain('Brak zapisanej oceny tego meldunku');expect(output).not.toContain('Dystrybucja wody');
  });
});
