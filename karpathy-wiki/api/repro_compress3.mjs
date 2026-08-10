import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';

async function build(order) {
  const app = Fastify();
  // order: array of 'cors' / 'compress' in registration sequence
  for (const p of order) {
    if (p === 'cors') await app.register(cors, { origin: true, credentials: true });
    if (p === 'compress') await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });
  }
  app.get('/big', async () => ({ data: 'x'.repeat(2000) }));
  await app.listen({ port: 3997, host: '127.0.0.1' });
  const res = await fetch('http://127.0.0.1:3997/big', { headers: { 'Accept-Encoding': 'gzip' } });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`order=[${order.join(',')}] | ce=${res.headers.get('content-encoding')} | cl=${res.headers.get('content-length')} | bodyLen=${buf.length}`);
  await app.close();
}

await build(['cors', 'compress']);   // current (broken): cors before compress
await build(['compress', 'cors']);   // fix candidate: compress before cors
process.exit(0);
