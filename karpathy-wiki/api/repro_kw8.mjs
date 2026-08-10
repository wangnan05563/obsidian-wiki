import Fastify from 'fastify';
import compress from '@fastify/compress';

const app = Fastify({ logger: false });
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });

function makeObj(n) {
  return { totalPages: 100, totalLinks: 200, dirCounts: { entities: 10, concepts: 20, comparisons: 5, queries: 3 }, recentLog: 'x'.repeat(n) };
}

// Build an object whose JSON serialization is EXACTLY 1024 bytes
function exactObj(target) {
  let n = 0;
  while (JSON.stringify(makeObj(n)).length < target) n++;
  return makeObj(n);
}

const obj1024 = exactObj(1024);
const ser1024 = JSON.stringify(obj1024);
console.log('serialized length =', ser1024.length);

app.get('/stats1024', async (_req, reply) => {
  return reply.send(JSON.parse(ser1024));
});

const PORT = 3103;
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log('listening on', PORT);

async function probe(label, url, headers) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    const enc = res.headers.get('content-encoding');
    let decoded = buf;
    if (enc === 'gzip') { const z = await import('node:zlib'); decoded = z.gunzipSync(buf); }
    console.log(`[${label}] status=${res.status} enc=${enc} wireBytes=${buf.length} decodedBytes=${decoded.length} okJson=${decoded.slice(0,1).toString()==='{'}`);
  } catch (e) { console.log(`[${label}] ERROR ${e.message}`); }
}

await probe('1024 NO-enc', '/stats1024', {});
await probe('1024 gzip', '/stats1024', { 'Accept-Encoding': 'gzip' });
await probe('1024 br', '/stats1024', { 'Accept-Encoding': 'br' });

await app.close();
process.exit(0);
