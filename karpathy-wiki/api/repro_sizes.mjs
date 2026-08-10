import Fastify from 'fastify';
import compress from '@fastify/compress';
import fs from 'node:fs';

const real = fs.readFileSync('C:/tmp/kw_stats.json', 'utf8');
const ascii1024 = JSON.stringify({ data: 'x'.repeat(1018) }); // ~1024 bytes
const cn1100 = JSON.stringify({ s: '中'.repeat(360) }); // ~1080 bytes utf8
const ascii2000 = JSON.stringify({ data: 'x'.repeat(2000) });

const app = Fastify();
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });
app.get('/real', async () => JSON.parse(real));
app.get('/a1024', async () => JSON.parse(ascii1024));
app.get('/cn1100', async () => JSON.parse(cn1100));
app.get('/a2000', async () => JSON.parse(ascii2000));

await app.listen({ port: 4600, host: '127.0.0.1' });
for (const p of ['real', 'a1024', 'cn1100', 'a2000']) {
  const res = await fetch(`http://127.0.0.1:4600/${p}`, { headers: { 'Accept-Encoding': 'gzip' } });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`${p}: ce=${res.headers.get('content-encoding')} cl=${res.headers.get('content-length')} bodyLen=${buf.length}`);
}
await app.close();
process.exit(0);
