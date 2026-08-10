import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';

let port = 4100;
async function build(label, plugins, withStatic, withHooks) {
  const p = port++;
  const app = Fastify();
  if (withHooks) {
    app.addHook('onRequest', async () => {});
    app.addHook('onResponse', async () => {});
    app.addHook('onError', async () => {});
  }
  if (plugins.cors) await app.register(cors, { origin: true, credentials: true });
  if (plugins.helmet) await app.register(helmet, { contentSecurityPolicy: false });
  if (plugins.rateLimit) await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  if (plugins.compress) await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });
  app.get('/big', async () => ({ data: 'x'.repeat(2000) }));
  await app.listen({ port: p, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${p}/big`, { headers: { 'Accept-Encoding': 'gzip' } });
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`${label} | ce=${res.headers.get('content-encoding')} | cl=${res.headers.get('content-length')} | bodyLen=${buf.length}`);
  } catch (e) {
    console.log(`${label} | FETCH_ERROR ${e.cause?.code || e.message}`);
  }
  await app.close();
}

// base order matches real app: cors, helmet, rateLimit, compress
await build('A: all-but-static', { cors: true, helmet: true, rateLimit: true, compress: true }, false, false);
await build('B: all+static', { cors: true, helmet: true, rateLimit: true, compress: true }, true, false);
await build('C: all+hooks', { cors: true, helmet: true, rateLimit: true, compress: true }, false, true);
await build('D: all+static+hooks', { cors: true, helmet: true, rateLimit: true, compress: true }, true, true);
process.exit(0);
