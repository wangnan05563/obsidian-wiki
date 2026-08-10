import Fastify from 'fastify';
import { registerCompression } from './src/compression.js';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

process.on('unhandledRejection', (e) => {
  writeFileSync('C:/tmp/kw13_err.txt', 'UNHANDLED: ' + (e as Error).stack + '\n');
});

const app = Fastify({ logger: false });
registerCompression(app, { threshold: 1024 });
app.get('/ping', async (_req, reply) => reply.send({ ok: true, msg: 'x'.repeat(1300) }));

async function main() {
  let out = '';
  try {
    const res = await app.inject({ method: 'GET', url: '/ping', headers: {} });
    const bodyBuf: Buffer = (res as any).rawPayload ?? Buffer.from(res.body, 'binary');
    const e = res.headers['content-encoding'];
    out += `status=${res.statusCode} enc=${e ?? 'none'} wire=${bodyBuf.length}\n`;
  } catch (e) {
    out += 'INJECT ERROR: ' + (e as Error).stack + '\n';
  }
  writeFileSync('C:/tmp/kw13_result.txt', out);
}

main().catch((e) => writeFileSync('C:/tmp/kw13_err.txt', 'MAIN ERR: ' + (e as Error).stack + '\n'));
