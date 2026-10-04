import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// No secret is placed in argv, stdout, a file, or the browser bundle.
const names = process.argv.slice(2);
const listing=spawnSync('psst',['--global','list','--json'],{encoding:'utf8',shell:process.platform==='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});
if(listing.status!==0)throw new Error('Nie można sprawdzić istniejących sekretów psst. Nie zmieniono klucza.');
for (const name of names.length ? names : ['MOST_SIGNING_PRIVATE_KEY']) {
  if (!/^(MOST_SIGNING_PRIVATE_KEY|MOST_BOOTSTRAP_TOKEN)$/.test(name)) throw new Error('Niedozwolona nazwa sekretu');
  if(new RegExp(`\\b${name}\\b`).test(listing.stdout)){console.log(`Zachowano istniejący ${name} w psst. Nie wykonano rotacji.`);continue;}
  const secret = name === 'MOST_SIGNING_PRIVATE_KEY'
    ? generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    : randomBytes(32).toString('hex');
  const result = spawnSync('psst', ['--global', 'set', name, '--stdin', '--tag', 'most'], {input: secret, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  if (result.status !== 0) throw new Error(`Nie udało się zapisać ${name} w psst (kod ${result.status})`);
  console.log(`Zapisano ${name} w psst`);
}
