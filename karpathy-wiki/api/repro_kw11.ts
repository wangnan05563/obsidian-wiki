import Fastify from 'fastify';
import { registerCompression } from './src/compression.js';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

const app = Fastify({ logger: false });
registerCompression(app, { threshold: 1024 });

app.get('/ping', async (_req, reply) => reply.send({ ok: true, msg: 'x'.repeat(1300) }));
app.get('/small', async (_req, reply) => reply.send({ ok: true }));

async function probe(url: string, enc?: string) {
  const res = await app.inject({ method: 'GET', url, headers: enc ? { 'accept-encoding': enc } : {} });
  const bodyBuf: Buffer = (res as any).rawPayload ?? Buffer.from(res.body, 'binary');
  const e = res.headers['content-encoding'];
  let ok = false, decLen = 0;
  try {
    const d = e === 'gzip' ? zlib.gunzipSync(bodyBuf) : e === 'br' ? zlib.brotliDecompressSync(bodyBuf) : e === 'deflate' ? zlib.inflateSync(bodyBuf) : bodyBuf;
    ok = d[0] === 0x7b; decLen = d.length;
  } catch { ok = false; }
  return `status=${res.statusCode} enc=${e ?? 'none'} wire=${bodyBuf.length} dec=${decLen} ${ok ? 'OK' : 'BROKEN'}`;
}

let out = 'START\n';
try {
  out += 'ping noenc: ' + (await probe('/ping')) + '\n';
  out += 'ping gzip:  ' + (await probe('/ping', 'gzip')) + '\n';
  out += 'ping br:    ' + (await probe('/ping', 'br')) + '\n';
  out += 'small noenc:' + (await probe('/small')) + '\n';
  out += 'small gzip: ' + (await probe('/small', 'gzip')) + '\n';
} catch (e) {
  out += 'ERROR: ' + (e as Error).stack + '\n';
}
out += 'DONE\n';
writeFileSync('C:/tmp/kw11_result.txt', out);
