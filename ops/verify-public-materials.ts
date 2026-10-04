import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile, mkdir } from 'node:fs/promises';
const origin = 'https://phones-hwy-punch-contributing.trycloudflare.com';
const base = `${origin}/materialy/`;
const checks: {name:string;passed:boolean;detail?:unknown}[] = [];
const check = (name:string, passed:boolean, detail?:unknown) => {checks.push({name,passed,detail});if(!passed)throw new Error(name);};
await mkdir('artifacts/public-materials',{recursive:true});
let browser;
try {
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1050}});
  const page = await context.newPage();
  const pageErrors:string[]=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await expect(page.getByRole('heading',{level:1})).toContainText('Awaria wspólnego routera');
  await expect(page.getByRole('link',{name:'Uruchom demo',exact:true})).toHaveAttribute('href','/demo');
  check('Strona pokazuje właściwy projekt, wejście do demo i napisy filmu',await page.locator('track[srclang=pl]').count()===1);
  await page.screenshot({path:'artifacts/public-materials/desktop.png',fullPage:true});
  const desktopAxe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  check('Brak poważnych i krytycznych naruszeń axe w stronie materiałów',!desktopAxe.violations.some(v=>['serious','critical'].includes(v.impact??'')),desktopAxe.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length})));
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'artifacts/public-materials/mobile.png',fullPage:true});
  check('Strona materiałów mieści się na ekranie telefonu',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  check('Brak błędów JavaScript strony i odtwarzacza',pageErrors.length===0,pageErrors);
  await context.close();
}catch(error){checks.push({name:'Weryfikacja zakończona bez błędu',passed:false,detail:String(error)});}
finally{await browser?.close();}
const report={verifiedAt:new Date().toISOString(),url:base,passed:checks.every(c=>c.passed),checks};
await writeFile('artifacts/public-materials-verification.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;
