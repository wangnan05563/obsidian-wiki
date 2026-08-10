import Fastify from 'fastify';
import { writeFileSync } from 'node:fs';

const app = Fastify({ logger: false });
// trivial pass-through onSend hook
app.addHook('onSend', (_req, _reply, payload) => payload);
app.get('/ping', async (_req, reply) => reply.send({ ok: true, msg: 'x'.repeat(1300) }));

async function main() {
  let out = 'START\n';
  try {
    const res = await app.inject({ method: 'GET', url: '/ping', headers: {} });
    out += `status=${res.statusCode} bodyLen=${res.body.length}\n`;
  } catch (e) {
    out += 'ERR: ' + (e as Error).stack + '\n';
  }
  out += 'DONE\n';
  writeFileSync('C:/tmp/kw15_result.txt', out);
}
main().catch((e) => writeFileSync('C:/tmp/kw15_err.txt', 'MAIN ERR: ' + (e as Error).stack + '\n'));
