import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';

const app = Fastify();
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });

// per-route rateLimit config (like real stats route)
app.get('/perroute', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async () => ({ data: 'x'.repeat(2000) }));

await app.listen({ port: 4500, host: '127.0.0.1' });
const res = await fetch('http://127.0.0.1:4500/perroute', { headers: { 'Accept-Encoding': 'gzip' } });
const buf = Buffer.from(await res.arrayBuffer());
console.log('per-route-rateLimit+compress ce=' + res.headers.get('content-encoding') + ' cl=' + res.headers.get('content-length') + ' bodyLen=' + buf.length);
await app.close();
process.exit(0);
