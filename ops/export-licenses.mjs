import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const metadata=JSON.parse(await readFile('artifacts/dependency-licenses.json','utf8'));
const target=resolve('output/licenses');await mkdir(target,{recursive:true});
const index=[];
const inherited={ '@esbuild/win32-x64':'esbuild', '@napi-rs/canvas-win32-x64-msvc':'@napi-rs/canvas', '@rolldown/binding-win32-x64-msvc':'rolldown', '@rollup/rollup-win32-x64-gnu':'rollup', '@rollup/rollup-win32-x64-msvc':'rollup' };
const upstream={ '@epic-web/invariant':['epicweb-dev/invariant','README.md'], 'abstract-logging':['jsumners/abstract-logging','Readme.md'], 'is-module':['component/is-module','LICENSE'], 'is-regexp':['sindresorhus/is-regexp','license'], 'react-remove-scroll-bar':['theKashey/react-remove-scroll-bar','LICENSE'], 'filelist':['mde/filelist','LICENSE'], 'jake':['jakejs/jake','LICENSE'] };
for(const packages of Object.values(metadata))for(const pkg of packages){
  const entry={name:pkg.name,versions:pkg.versions,license:pkg.license,homepage:pkg.homepage,files:[]};
  for(const directory of pkg.paths){
    const folder=pkg.name.replaceAll('/','_')+'-'+pkg.versions.join('_');
    const entries=await readdir(directory,{withFileTypes:true});
    for(const item of entries){
      if(item.isFile()&&/^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i.test(item.name)){
        const destination=join(target,folder,item.name);await mkdir(join(target,folder),{recursive:true});
        await copyFile(join(directory,item.name),destination);entry.files.push(folder+'/'+item.name);
      }
    }
    if(!entry.files.length){
      const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
      await mkdir(join(target,folder),{recursive:true});
      await writeFile(join(target,folder,'PACKAGE-LICENSE-METADATA.json'),JSON.stringify({name:manifest.name,version:manifest.version,license:manifest.license,licenses:manifest.licenses,repository:manifest.repository},null,2));
    }
  }
  index.push(entry);
}
for(const entry of index.filter(x=>!x.files.length)){
  const folder=entry.name.replaceAll('/','_')+'-'+entry.versions.join('_');
  const parent=index.find(x=>x.name===inherited[entry.name]);
  if(parent?.files.length){
    for(const source of parent.files){const name=source.split('/').at(-1);await copyFile(join(target,source),join(target,folder,name));entry.files.push(folder+'/'+name);}
    entry.inheritedFrom={name:parent.name,versions:parent.versions};
  }else if(upstream[entry.name]){
    const [repo,name]=upstream[entry.name];
    for(const revision of ['v'+entry.versions[0],entry.versions[0],'main','master']){
      const url=`https://raw.githubusercontent.com/${repo}/${revision}/${name}`;
      try{const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)continue;const content=await response.text();if(!/Permission is hereby granted|Apache License|MIT License|License\s+MIT/i.test(content))continue;await writeFile(join(target,folder,'UPSTREAM-'+name),content);entry.files.push(folder+'/UPSTREAM-'+name);entry.upstream={url,retrievedAt:new Date().toISOString(),versionMatched:revision.includes(entry.versions[0])};break;}catch{}
    }
  }
}
for(const [name,url,file] of [['abstract-logging','https://jsumners.mit-license.org/','AUTHOR-LICENSE.html'],['@epic-web/invariant','https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt','MIT-STANDARD.txt']]){
  const entry=index.find(x=>x.name===name);if(!entry)continue;const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Could not retrieve '+url);const folder=entry.name.replaceAll('/','_')+'-'+entry.versions.join('_');await writeFile(join(target,folder,file),await response.text());entry.files.push(folder+'/'+file);entry.supplement={url,note:name==='@epic-web/invariant'?'Upstream declares MIT but supplies no copyright notice; unmodified SPDX license template included.':'Author license linked by upstream README.'};
}
await writeFile(join(target,'INDEX.json'),JSON.stringify(index,null,2));
console.log(JSON.stringify({packages:index.length,withLicenseFiles:index.filter(x=>x.files.length).length,metadataOnly:index.filter(x=>!x.files.length).map(x=>x.name)},null,2));
