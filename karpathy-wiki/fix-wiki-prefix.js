const fs=require('fs');
const p='D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/index.ts';
let c=fs.readFileSync(p,'utf8');
const startIdx=c.indexOf('    // Tailscale Funnel');
const endIdx=c.indexOf('    // SPA fallback');
const oldBlock=c.substring(startIdx, endIdx);
const newBlock=    // /wiki/ prefix handler for Tailscale Funnel
    app.get('/wiki/*', async (request, reply) => {
      const suffix = request.url.replace(/^\/wiki/, '');
      if (suffix.startsWith('/api')) {
        request.url = suffix;
        (request.raw as any).url = suffix;
        return reply.callNotFound();
      }
      if (suffix === '' || suffix === '/') {
        return reply.sendFile('index.html');
      }
      try {
        return reply.sendFile(suffix.slice(1));
      } catch {
        return reply.sendFile('index.html');
      }
    });
    ;
c = c.substring(0, startIdx) + newBlock + c.substring(endIdx);
fs.writeFileSync(p, c, 'utf8');
console.log('Done, new length:', c.length);
