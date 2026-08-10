import Fastify from 'fastify';
import compress from '@fastify/compress';
import zlib from 'node:zlib';

const app = Fastify({ logger: false });
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });

function makeObj(n) {
  return { totalPages: 100, totalLinks: 200, dirCounts: { entities: 10, concepts: 20, comparisons: 5, queries: 3 }, recentLog: 'x'.repeat(n) };
}
// exact-size builder
function objOfLen(target) {
  let n = 0;
  while (JSON.stringify(makeObj(n)).length < target) n++;
  return makeObj(n);
}

const sizes = [500, 1000, 1020, 1023, 1024, 1025, 1030, 1100, 1500, 3000];
for (const s of sizes) {
  const o = objOfLen(s);
  const len = JSON.stringify(o).length;
  app.get('/s' + len, async (_req, reply) => reply.send(JSON.parse(JSON.stringify(o))));
}

const PORT = 3104;
await app.listen({ port: PORT, host: '127.0.0.1' });

async function probe(size, encHeader) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/s${size}`, { headers: encHeader ? { 'Accept-Encoding': encHeader } : {} });
    const buf = Buffer.from(await res.arrayBuffer());
    const enc = res.headers.get('content-encoding');
    let ok = false;
    try {
      const d = enc === 'gzip' ? zlib.gunzipSync(buf) : enc === 'br' ? zlib.brotliDecompressSync(buf) : enc === 'deflate' ? zlib.inflateSync(buf) : buf;
      ok = d.length === size && d[0] === 0x7b; // starts with '{'
    } catch { ok = false; }
    return `${enc}:${buf.length}B=${ok ? 'OK' : 'BROKEN'}`;
  } catch (e) { return `ERR:${e.message}`; }
}

for (const s of sizes) {
  const noenc = await probe(s, null);
  const gz = await probe(s, 'gzip');
  const br = await probe(s, 'br');
  console.log(`size=${s}  raw=${noenc}  gzip=${gz}  br=${br}`);
}

await app.close();
process.exit(0);
