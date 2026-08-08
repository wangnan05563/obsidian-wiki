import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 静态服务「修复后生产构建」并代理后端鉴权 API。
// 构建 base 为 /wiki/，故静态资源路径形如 /wiki/assets/x.js，需要剥离 /wiki 前缀映射到磁盘 root。
const root = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/prod_editresend_20260806_224652';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // 代理 /wiki/api/* -> http://localhost:3000/api/*（剥离 /wiki 前缀），使真实后端鉴权 API 可用
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
  // 静态资源：剥离 /wiki 前缀（构建 base 为 /wiki/）
  let p = decodeURIComponent(url);
  if (p.startsWith('/wiki')) p = p.slice(5) || '/';
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    res.end(d);
  });
});
server.listen(8088, () => console.log('serving fixed build on 8088 (proxy /wiki/api -> :3000)'));
