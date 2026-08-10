import Fastify from 'fastify';
import { writeFileSync } from 'node:fs';

const app = Fastify({ logger: false });
// NO compression hook
app.get('/ping', async (_req, reply) => reply.send({ ok: true, msg: 'x'.repeat(1300) }));
app.get('/small', async (_req, reply) => reply.send({ ok: true }));

async function probe(url: string, enc?: string) {
  const res = await app.inject({ method: 'GET', url, headers: enc ? { 'accept-encoding': enc } : {} });
  return `status=${res.statusCode} bodyLen=${res.body.length}`;
}

let out = 'START\n';
try {
  out += 'ping noenc: ' + (await probe('/ping')) + '\n';
  out += 'ping gzip:  ' + (await probe('/ping', 'gzip')) + '\n';
  out += 'small:      ' + (await probe('/small')) + '\n';
} catch (e) {
  out += 'ERROR: ' + (e as Error).stack + '\n';
}
out += 'DONE\n';
writeFileSync('C:/tmp/kw12_result.txt', out);
