import Fastify from 'fastify';
import compress from '@fastify/compress';

const app = Fastify();
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });

app.get('/big', async () => {
  return { data: 'x'.repeat(2000) };
});

await app.listen({ port: 3999, host: '127.0.0.1' });

const res = await fetch('http://127.0.0.1:3999/big', { headers: { 'Accept-Encoding': 'gzip' } });
const buf = Buffer.from(await res.arrayBuffer());
console.log('NODE', process.version);
console.log('content-encoding:', res.headers.get('content-encoding'));
console.log('content-length:', res.headers.get('content-length'));
console.log('decoded body length:', buf.length);
console.log('decoded starts:', buf.slice(0, 40).toString());

await app.close();
process.exit(0);
