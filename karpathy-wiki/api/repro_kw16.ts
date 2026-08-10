import Fastify from 'fastify';
import { registerCompression } from './src/compression.js';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

const app = Fastify({ logger: false });
registerCompression(app, { threshold: 1024 });
app.get('/ping', async (_req, reply) => reply.send({ ok: true, msg: 'x'.repeat(1300) }));
app.get('/small', async (_req, reply) => reply.send({ ok: true }));

const PORT = 3107;
await app.listen({ port: PORT, host: '127.0.0.1' });

async function probe(url: string, enc?: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { headers: enc ? { 'accept-encoding': enc } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  const e = res.headers.get('content-encoding');
  let ok = false, decLen = 0;
  try {
    const d = e === 'gzip' ? zlib.gunzipSync(buf) : e === 'br' ? zlib.brotliDecompressSync(buf) : e === 'deflate' ? zlib.inflateSync(buf) : buf;
    ok = d[0] === 0x7b; decLen = d.length;
  } catch { ok = false; }
  return `status=${res.statusCode} enc=${e ?? 'none'} wire=${buf.length} dec=${decLen} ${ok ? 'OK' : 'BROKEN'}`;
}

let out = 'START\n';
try {
  out += 'ping noenc: ' + (await probe('/ping')) + '\n';
  out += 'ping gzip:  ' + (await probe('/ping', 'gzip')) + '\n';
  out += 'ping br:    ' + (await probe('/ping', 'br')) + '\n';
  out += 'small noenc:' + (await probe('/small')) + '\n';
  out += 'small gzip: ' + (await probe('/small', 'gzip')) + '\n';
} catch (e) {
  out += 'ERR: ' + (e as Error).stack + '\n';
}
out += 'DONE\n';
writeFileSync('C:/tmp/kw16_result.txt', out);
app.close().then(() => process.exit(0)).catch(() => process.exit(0));
