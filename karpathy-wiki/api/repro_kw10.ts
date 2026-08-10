import Fastify from 'fastify';
import { registerCompression } from './src/compression.js';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

const app = Fastify({ logger: false });
registerCompression(app, { threshold: 1024 });

function makeObj(n: number) {
  return { totalPages: 100, totalLinks: 200, dirCounts: { entities: 10, concepts: 20, comparisons: 5, queries: 3 }, recentLog: 'x'.repeat(n) };
}
function objOfLen(target: number) {
  let n = 0;
  while (JSON.stringify(makeObj(n)).length < target) n++;
  return makeObj(n);
}
const sizes = [500, 1023, 1024, 1025, 1100, 1500, 3000, 58000];
for (const s of sizes) {
  const o = objOfLen(s);
  app.get('/s' + s, async (_req, reply) => reply.send(JSON.parse(JSON.stringify(o))));
}

async function probe(size: number, enc?: string) {
  const res = await app.inject({ method: 'GET', url: '/s' + size, headers: enc ? { 'accept-encoding': enc } : {} });
  const bodyBuf: Buffer = (res as any).rawPayload ?? Buffer.from(res.body, 'binary');
  const e = res.headers['content-encoding'];
  let ok = false, decLen = 0;
  try {
    const d = e === 'gzip' ? zlib.gunzipSync(bodyBuf) : e === 'br' ? zlib.brotliDecompressSync(bodyBuf) : e === 'deflate' ? zlib.inflateSync(bodyBuf) : bodyBuf;
    ok = d.length === size && d[0] === 0x7b; decLen = d.length;
  } catch { ok = false; }
  return `${e ?? 'none'}:wire=${bodyBuf.length} dec=${decLen} ${ok ? 'OK' : 'BROKEN'}`;
}

let out = '';
try {
  const ITER = 15;
  for (const s of sizes) {
    let allOk = true; let last = '';
    for (let i = 0; i < ITER; i++) { last = await probe(s, 'gzip'); if (last.includes('BROKEN')) { allOk = false; break; } }
    const brLast = await probe(s, 'br');
    const rawLast = await probe(s);
    out += `size=${s}  gzip(x${ITER})=${allOk ? 'ALL OK' : last}  | br=${brLast}  | raw=${rawLast}\n`;
  }
} catch (e) {
  out += 'ERROR: ' + (e as Error).stack + '\n';
}
writeFileSync('C:/tmp/kw10_result.txt', out);
