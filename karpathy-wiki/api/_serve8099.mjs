import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/prod_20260806_020754';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // proxy /wiki/api/* -> http://localhost:3000/api/* (strip /wiki)
  if (url.startsWith('/wiki/api')) {
    const target = 'http://localhost:3000' + url.replace(/^\/wiki/, '');
    const proxyReq = http.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { res.writeHead(502); res.end('proxy err'); });
    req.pipe(proxyReq);
    return;
  }
  let p = decodeURIComponent(url);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    res.end(d);
  });
});
server.listen(8099, () => console.log('serving fixed build on 8099 (proxy /wiki/api -> :3000)'));
