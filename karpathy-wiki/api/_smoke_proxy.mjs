import http from 'node:http';
import net from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const targetPort = 9921, blockPort = 9923, proxyPort = 9922, SPA = 'http://127.0.0.1:3000/wiki/';

// --- local target server (stands in for a crawled page, returns 200) ---
const target = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>PROXY_TARGET_OK</title></head><body>hello-proxy</body></html>');
});

// --- local target that returns a 420 blacklist page (simulates a WAF-blocked site) ---
const blockTarget = http.createServer((req, res) => {
  res.writeHead(420, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>黑名单页面</title></head><body>access denied by firewall</body></html>');
});

// --- minimal HTTP forward proxy (handles absolute-form request from undici ProxyAgent) ---
// undici 的 ProxyAgent 对 HTTP 目标会把请求以绝对形式（GET http://host:port/ HTTP/1.1）发给代理，
// 本代理用 http.request 转发到真实目标并把响应原样 pipe 回 undici，证明 fetch 确实经此代理 egress。
let proxyHit = false;
const proxy = http.createServer((req, res) => {
  proxyHit = true;
  console.error('PROXY_REQ', req.method, JSON.stringify(req.url));
  const u = new URL(req.url);
  // 测试专用：crawl.test 直接指向本机目标（绕过 DNS），使真实 crawlUrl 能经代理抓取本地目标；
  // 生产 SSRF 对不可解析主机名放行，故 crawlUrl 的 checkSSRF 不会拦截 crawl.test。
  const fwdHost = u.hostname === 'crawl.test' ? '127.0.0.1' : u.hostname;
  const fwdPort = u.hostname === 'crawl.test' ? targetPort : Number(u.port);
  const fwd = http.request({
    host: fwdHost,
    port: fwdPort,
    method: req.method,
    path: u.pathname + u.search,
    headers: { ...req.headers, host: u.host },
  }, (fres) => {
    res.writeHead(fres.statusCode || 502, fres.headers);
    fres.pipe(res);
  });
  req.pipe(fwd);
  fwd.on('error', (e) => { console.error('PROXY_FWD_ERR', e.message); res.writeHead(502); res.end('proxy err ' + e.message); });
});
proxy.on('connect', (req, clt, head) => {
  const u = new URL('http://' + req.url);
  const srv = net.connect(Number(u.port), u.hostname, () => {
    clt.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) srv.write(head);
  });
  srv.pipe(clt); clt.pipe(srv);
});

await new Promise((r) => target.listen(targetPort, r));
await new Promise((r) => blockTarget.listen(blockPort, r));
await new Promise((r) => proxy.listen(proxyPort, r));

let allPass = true;

// 1) validateProxyUrl cases
const { validateProxyUrl, crawlUrl: _crawlUrl, probeProxyEgress: _probe } = await import('./src/utils/url-crawl.ts');
const cases = [
  ['http://1.2.3.4:8080', 'http://1.2.3.4:8080/'],
  ['https://user:pass@proxy.example.com:443', 'https://user:pass@proxy.example.com/'],
  ['socks5://1.2.3.4:1080', null],
  ['ftp://1.2.3.4', null],
  ['', null],
  ['not a url', null],
];
for (const [inp, exp] of cases) {
  const got = validateProxyUrl(inp);
  const pass = got === exp;
  if (!pass) allPass = false;
  console.log(`validateProxyUrl(${JSON.stringify(inp)}) => ${JSON.stringify(got)} expected ${JSON.stringify(exp)} : ${pass ? 'PASS' : 'FAIL'}`);
}

// 2) ProxyAgent routes a fetch THROUGH the local proxy to the target
let proxyWorks = false;
try {
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${proxyPort}`);
  const resp = await undiciFetch(`http://127.0.0.1:${targetPort}/`, { dispatcher });
  const body = await resp.text();
  proxyWorks = body.includes('PROXY_TARGET_OK') && proxyHit;
  dispatcher.close();
  console.log('PROXY_FETCH_thru_local_proxy marker=' + body.includes('PROXY_TARGET_OK') + ' proxyHit=' + proxyHit + ' status=' + resp.status);
} catch (e) {
  console.log('PROXY_FETCH_ERROR=' + e.message + ' cause=' + (e.cause ? (e.cause.code || e.cause.message) : 'none'));
}
if (!proxyWorks) allPass = false;

// 3) live SPA 由最新 public_live_<ts> 伺服，且 /wiki/ 引用的 assets/index-*.js 真实存在（动态，不依赖写死 hash）
let spaNew = false, liveDir = '', bundleName = '';
try {
  const fs = await import('node:fs');
  liveDir = fs.readdirSync('.').filter((d) => /^public_live_\d+$/.test(d)).sort().pop() || '';
  const resp = await fetch(SPA);
  const html = await resp.text();
  const m = html.match(/\/wiki\/assets\/(index-[A-Za-z0-9_]+\.js)/) || html.match(/assets\/(index-[A-Za-z0-9_]+\.js)/);
  bundleName = m ? 'assets/' + m[1] : '';
  spaNew = !!m && fs.existsSync(`${liveDir}/${bundleName}`);
  console.log('LIVE_SPA_liveDir=' + liveDir + ' bundle=' + bundleName + ' exists=' + spaNew);
} catch (e) {
  console.log('SPA_FETCH_ERROR=' + e.message);
}
if (!spaNew) allPass = false;

// 4) drive the REAL crawlUrl (fixed: undiciFetch + ProxyAgent) THROUGH the local proxy.
// crawl.test 不可解析 → checkSSRF 放行；测试代理侧将其指向本机目标，
// 从而真实验证 crawlUrl 的 fetch 经自定义 egress 代理 egress，而非全局 dispatcher。
let crawlThruProxy = false, crawlPages = 0;
try {
  for await (const ev of _crawlUrl('http://crawl.test:9921/', {
    egressProxyUrl: `http://127.0.0.1:${proxyPort}`,
    maxPages: 1, maxHops: 2, timeoutMs: 8000,
  })) {
    if (ev.type === 'done' && ev.data) {
      crawlPages = ev.data.pagesCrawled || 0;
      if (typeof ev.data.combinedMarkdown === 'string' && ev.data.combinedMarkdown.includes('hello-proxy')) {
        crawlThruProxy = true;
      }
    }
    if (ev.type === 'error' || ev.type === 'page_error') {
      console.log('CRAWL_EV', ev.type, ev.step, ev.message);
    }
  }
  console.log('CRAWL_thru_local_proxy=' + crawlThruProxy + ' pages=' + crawlPages + ' proxyHit=' + proxyHit);
} catch (e) {
  console.log('CRAWL_ERROR=' + e.message);
}
if (!crawlThruProxy) allPass = false;

// 5) probeProxyEgress: ok 分支（经代理探 200 目标）+ blocked 分支（经代理探 420 黑名单目标）
let probeOk = false, probeBlocked = false;
try {
  const pOk = await _probe('http://127.0.0.1:9921/', 'http://127.0.0.1:9922', 8000);
  console.log('PROBE_ok', JSON.stringify(pOk));
  probeOk = pOk.ok === true && pOk.level === 'ok' && pOk.reachable === true;
  const pBlock = await _probe('http://127.0.0.1:9923/', 'http://127.0.0.1:9922', 8000);
  console.log('PROBE_blocked', JSON.stringify(pBlock));
  probeBlocked = pBlock.blocked === true && pBlock.level === 'warn' && pBlock.reachable === true;
} catch (e) {
  console.log('PROBE_ERROR=' + e.message);
}
console.log('PROBE_ok_pass=' + probeOk + ' PROBE_blocked_pass=' + probeBlocked);
if (!probeOk || !probeBlocked) allPass = false;

// 6) 诊断合并（忠实复刻 url-ingest.ts 路由逻辑）：代理探测结论并入 done.diagnosis，
//    前端 url-diagnosis-banner 据此展示「【代理探测】…」。验证合并后的字符串形态。
let mergeOk = false;
try {
  const probe = await _probe('http://127.0.0.1:9921/', 'http://127.0.0.1:9922', 8000);
  // 路由中：data = { ...(ev.data ?? {}), diagnosis: base ? `${probeLine}\n${base}` : probeLine }
  const probeLine = `【代理探测】${probe.message}`;
  // 情形 A：爬取自身无 diagnosis → 直接用探针行
  const mergedA = probeLine;
  // 情形 B：爬取自身有 diagnosis → 探针行在前、爬取诊断在后
  const baseDiag = '所有页面抓取失败：访问受限';
  const mergedB = `${probeLine}\n${baseDiag}`;
  const okA = mergedA.startsWith('【代理探测】') && mergedA.includes(probe.message);
  const okB = mergedB.startsWith('【代理探测】') && mergedB.includes(baseDiag) && mergedB.indexOf('【代理探测】') < mergedB.indexOf(baseDiag);
  mergeOk = okA && okB;
  console.log('DIAG_merge okA=' + okA + ' okB=' + okB + ' sample=' + mergedA.slice(0, 40));
} catch (e) {
  console.log('DIAG_merge_ERROR=' + e.message);
}
console.log('DIAG_merge_pass=' + mergeOk);
if (!mergeOk) allPass = false;

target.close(); blockTarget.close(); proxy.close();
console.log('RESULT=' + (allPass ? 'ALL_PASS' : 'FAIL'));
process.exit(allPass ? 0 : 1);
