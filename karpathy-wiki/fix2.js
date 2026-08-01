const fs = require('fs');
const p = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/index.ts';
let c = fs.readFileSync(p, 'utf8');

// Fix import line to include FastifyRequest and FastifyReply
c = c.replace("import Fastify from 'fastify';", "import Fastify, { FastifyRequest, FastifyReply } from 'fastify';");

// Replace the entire SPA block
const start = '  if (spaRoot) {';
const end = '  } else {';
const startIdx = c.indexOf(start);
const endIdx = c.indexOf(end);
console.log('startIdx:', startIdx, 'endIdx:', endIdx);

const newBlock =   if (spaRoot) {
    // preParsing hook: runs before route matching to rewrite /wiki/ prefix
    app.addHook('preParsing', async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.url.startsWith('/wiki/')) {
        request.url = request.url.replace(/^\\/wiki/, '');
        (request.raw as any).url = request.url;
      }
    });

    await app.register(fastifyStatic, {
      root: spaRoot,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
    console.log(\[SPA] SPA static assets served from \\);
  } else {;

const newC = c.substring(0, startIdx) + newBlock + c.substring(endIdx);
fs.writeFileSync(p, newC, 'utf8');
console.log('Done, length:', newC.length);
