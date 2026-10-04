import { buildApp } from './app.js';
const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? 8080), host = process.env.HOST ?? '127.0.0.1';
try { await app.listen({ port, host }); } catch { process.stderr.write('MOST could not start. Check port, data directory and configuration.\n'); process.exitCode = 1; }
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
