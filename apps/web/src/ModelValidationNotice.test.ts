import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelValidationNotice } from './ModelValidationNotice';

const model={modes:[{id:'invalid-mode',name:'Tryb zależny od wadliwego routera'}],dependencies:[{id:'loop',name:'Cykl połączeń'}],resources:[]};
const blockedFragments=[{kind:'mode',id:'invalid-mode',reasons:['Wymagana zależność zawiera cykl']},{kind:'dependency',id:'loop',reasons:['Cykl połączeń A → B → A']}];
describe('excluded fragments are distinct from global invalidity',()=>{
  it('names excluded modes and explains that valid independent fragments remain usable',()=>{
    const html=renderToStaticMarkup(createElement(ModelValidationNotice,{model,validation:{valid:true,issues:[],blockedFragments}}));
    expect(html).toContain('Tryb zależny od wadliwego routera');expect(html).toContain('Wymagana zależność zawiera cykl');expect(html).toContain('nie mogą być użyte w planie');expect(html).toContain('niezależne fragmenty pozostają dostępne');expect(html).not.toContain('Błędy modelu blokują obliczenia');
  });
  it('retains the global block even when a partial exclusion report is also available',()=>{
    const html=renderToStaticMarkup(createElement(ModelValidationNotice,{model,validation:{valid:false,issues:[{message:'Nieprawidłowe jednostki paliwa'}],blockedFragments}}));
    expect(html).toContain('Błędy modelu blokują obliczenia');expect(html).toContain('Nieprawidłowe jednostki paliwa');expect(html).not.toContain('niezależne fragmenty pozostają dostępne');
  });
});
