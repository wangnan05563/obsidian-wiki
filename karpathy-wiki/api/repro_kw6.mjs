import Fastify from 'fastify';
import compress from '@fastify/compress';

const app = Fastify({ logger: false });

await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });

app.get('/stats', async (_req, reply) => {
  const obj = {
    totalPages: 100,
    totalLinks: 200,
    dirCounts: { entities: 10, concepts: 20, comparisons: 5, queries: 3 },
    recentLog: 'x'.repeat(1200),
  };
  return reply.send(obj);
});

const PORT = 3101;
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log('listening on', PORT);

async function probe(label, headers) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/stats`, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`\n[${label}] status=${res.status} content-encoding=${res.headers.get('content-encoding')} content-length=${res.headers.get('content-length')} bytes=${buf.length}`);
    console.log(`  body-preview: ${buf.slice(0, 80).toString('utf8').replace(/\n/g, ' ')}`);
  } catch (e) {
    console.log(`\n[${label}] ERROR ${e.message}`);
  }
}

await probe('NO Accept-Encoding', {});
await probe('gzip', { 'Accept-Encoding': 'gzip' });
await probe('br', { 'Accept-Encoding': 'br' });

await app.close();
console.log('\nclosed, exiting');
process.exit(0);
