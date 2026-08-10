import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';

async function build(plugins) {
  const app = Fastify();
  if (plugins.cors) await app.register(cors, { origin: true, credentials: true });
  if (plugins.helmet) await app.register(helmet, { contentSecurityPolicy: false });
  if (plugins.rateLimit) await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  if (plugins.compress) await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });
  app.get('/big', async () => ({ data: 'x'.repeat(2000) }));
  await app.listen({ port: 3998, host: '127.0.0.1' });
  const res = await fetch('http://127.0.0.1:3998/big', { headers: { 'Accept-Encoding': 'gzip' } });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`plugins=${JSON.stringify(plugins)} | ce=${res.headers.get('content-encoding')} | cl=${res.headers.get('content-length')} | bodyLen=${buf.length}`);
  await app.close();
}

for (const combo of [
  { compress: true },
  { cors: true, compress: true },
  { helmet: true, compress: true },
  { rateLimit: true, compress: true },
  { cors: true, helmet: true, rateLimit: true, compress: true },
]) {
  await build(combo);
}
process.exit(0);
