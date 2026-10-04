import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'apps/web/public'), { recursive: true });
const highsRoot = resolve(require.resolve('highs'), '..');
async function findWasm(dir: string): Promise<string | undefined> {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith('.wasm')) return resolve(dir, f.name);
    if (f.isDirectory()) { const found = await findWasm(resolve(dir, f.name)); if (found) return found; }
  }
}
const wasm = await findWasm(highsRoot);
if (!wasm) throw new Error('Nie znaleziono lokalnego highs.wasm. Wykonaj pnpm install.');
await cp(wasm, resolve(root, 'apps/web/public/highs.wasm'));
// Generate one offline worker only after a successful application build. Vite's finally
// closes bundles even after failure; generating a worker there hides the original error
// behind Workbox initialization and can publish an incomplete offline release.
let generateWorker: (()=>Promise<unknown>) | undefined;
await build({ configFile: resolve(root, 'apps/web/vite.config.ts'), plugins: [{
  name: 'most-offline-build-lifecycle',
  configResolved(config) {
    if(config.isWorker)return;
    const pwa=config.plugins.find(plugin=>plugin.name==='vite-plugin-pwa') as any;
    if(pwa?.api?.generateSW)generateWorker=()=>pwa.api.generateSW();
    for(const plugin of config.plugins)if(plugin.name==='vite-plugin-pwa:build')delete plugin.closeBundle;
  },
  buildEnd(error){if(error)console.error('MOST application build failed:',error.stack??error);}
}] });
if(!generateWorker)throw new Error('Brak generatora pakietu offline.');
console.log('MOST application compiled; generating the offline worker.');
await generateWorker();
const publicDemoBuild = process.env.MOST_PUBLIC_DEMO_BUILD === 'true';
const dist = resolve(root, publicDemoBuild ? 'artifacts/private/public-demo/web-release' : 'apps/web/dist');
const files: {path: string; sha256: string; size: number}[] = [];
async function walk(dir: string) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, f.name);
    if (f.isDirectory()) await walk(full);
    else {
      const bytes = await readFile(full);
      files.push({ path: relative(dist, full).replaceAll('\\', '/'), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    }
  }
}
await walk(dist);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = { schemaVersion: 1, application: 'MOST', version: pkg.version, builtAt: new Date().toISOString(), node: process.version, dependencies: pkg.dependencies, files };
await writeFile(resolve(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
await mkdir(resolve(root, 'artifacts'), {recursive: true});
await writeFile(resolve(root, publicDemoBuild ? 'artifacts/public-demo-release-manifest.json' : 'artifacts/release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ built: true, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), wasm: files.find(f => f.path === 'highs.wasm')?.sha256 }));
