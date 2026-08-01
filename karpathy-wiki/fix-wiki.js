const fs = require('fs');
const p = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/index.ts';
let c = fs.readFileSync(p, 'utf8');
const startIdx = c.indexOf('    // Tailscale Funnel');
const endIdx = c.indexOf('    // SPA fallback');
const newBlock = `    // /wiki/ prefix handler for Tailscale Funnel\n    app.get('/wiki/*', async (request, reply) => {\n      const suffix = request.url.replace(/^\/wiki/, '');\n      if (suffix.startsWith('/api')) {\n        request.url = suffix;\n        (request.raw as any).url = suffix;\n        return reply.callNotFound();\n      }\n      if (suffix === '' || suffix === '/') {\n        return reply.sendFile('index.html');\n      }\n      try {\n        return reply.sendFile(suffix.slice(1));\n      } catch {\n        return reply.sendFile('index.html');\n      }\n    });\n    `;
c = c.substring(0, startIdx) + newBlock + c.substring(endIdx);
fs.writeFileSync(p, c, 'utf8');
console.log('Done, length:', c.length);
