import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';

const app = Fastify({ logger: false });

// mirror real app hooks
app.addHook('onRequest', async (request) => { request.log.info({ method: request.method, url: request.url }, 'incoming'); });
app.addHook('onResponse', async (request, reply) => { void reply.elapsedTime; });

await app.register(cors, { origin: (origin, cb) => { if (!origin) return cb(null, true); cb(null, true); }, credentials: true });
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });
await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 10 } });

app.get('/stats', async (_req, reply) => {
  const obj = { totalPages: 100, totalLinks: 200, dirCounts: { entities: 10, concepts: 20, comparisons: 5, queries: 3 }, recentLog: 'x'.repeat(1200) };
  return reply.send(obj);
});

const PORT = 3102;
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log('listening on', PORT);

async function probe(label, headers) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/stats`, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[${label}] status=${res.status} enc=${res.headers.get('content-encoding')} len=${res.headers.get('content-length')} bytes=${buf.length} preview=${buf.slice(0, 40).toString('utf8').replace(/\n/g, ' ')}`);
  } catch (e) { console.log(`[${label}] ERROR ${e.message}`); }
}

await probe('NO-enc', {});
await probe('gzip', { 'Accept-Encoding': 'gzip' });
await probe('br', { 'Accept-Encoding': 'br' });

await app.close();
process.exit(0);
