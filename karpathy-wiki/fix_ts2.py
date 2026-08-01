import sys
sys.stdout.reconfigure(encoding='utf-8')
p = r'D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\index.ts'
c = open(p, 'r', encoding='utf-8').read()
c = c.replace("import Fastify from 'fastify';", "import Fastify, { FastifyRequest, FastifyReply } from 'fastify';", 1)
old_start = '  if (spaRoot) {'
old_end = '  } else {'
idx1 = c.index(old_start)
idx2 = c.index(old_end, idx1)
new_block = """  if (spaRoot) {
    app.addHook('preParsing', async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.url.startsWith('/wiki/')) {
        request.url = request.url.replace(/^\\/wiki/, '');
        (request.raw as any).url = request.url;
      }
    });
    await app.register(fastifyStatic, { root: spaRoot, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
    console.log('[SPA] served from ' + spaRoot);
  } else {"""
c = c[:idx1] + new_block + c[idx2:]
open(p, 'w', encoding='utf-8').write(c)
print('Done')
