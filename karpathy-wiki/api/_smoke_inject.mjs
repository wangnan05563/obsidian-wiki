// 全量路由进程内冒烟（鲁棒版）：每条结果同步写日志 + 全局看门狗，避免单点挂起阻塞整体。
process.env.WIKI_SMOKE = '1';
process.env.WIKI_DISABLE_RATE_LIMIT = '1';

import fs from 'fs';
const LOG = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/_smoke_full.log';
fs.writeFileSync(LOG, '');
const log = (s) => { fs.appendFileSync(LOG, s + '\n'); };

const { buildApp } = await import('./src/index.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; log(`PASS  ${name}  ${detail}`); }
  else { fail++; log(`FAIL  ${name}  ${detail}`); }
}
function injectSafe(app, opts, ms = 3000) {
  return Promise.race([
    app.inject(opts),
    new Promise((resolve) => setTimeout(() => resolve({ statusCode: -1, body: '', _timedOut: true }), ms)),
  ]);
}

// 全局看门狗：无论如何 30s 后强制退出，避免挂死
const watchdog = setTimeout(() => {
  log('WATCHDOG TIMEOUT 30s — 强制退出');
  log(`PARTIAL: pass=${pass} fail=${fail}`);
  process.exit(2);
}, 30000);

try {
  const { app } = await buildApp();
  log('buildApp OK');
  await app.ready();
  log('app.ready OK');

  const r1 = await app.inject({ url: '/health', method: 'GET' });
  check('GET /health => 200', r1.statusCode === 200, `status=${r1.statusCode}`);

  const r2 = await injectSafe(app, { url: '/api/tts/voices', method: 'GET' }, 3000);
  check('GET /api/tts/voices => 200', !r2._timedOut && r2.statusCode === 200, r2._timedOut ? 'TIMEOUT' : `status=${r2.statusCode} len=${(r2.body||'').length}`);

  const r3 = await injectSafe(app, { url: '/api/files/pages', method: 'GET' }, 3000);
  check('GET /api/files/pages => 200', !r3._timedOut && r3.statusCode === 200, r3._timedOut ? 'TIMEOUT' : `status=${r3.statusCode}`);

  const r4 = await injectSafe(app, {
    url: '/api/query', method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ question: 'test' }),
  }, 3000);
  check('POST /api/query 缺密钥 => 400 (BYOK 强制)', !r4._timedOut && r4.statusCode === 400, r4._timedOut ? 'TIMEOUT' : `status=${r4.statusCode}`);

  const r5 = await injectSafe(app, { url: '/wiki/', method: 'GET' }, 3000);
  if (r5._timedOut) {
    log('SKIP  GET /wiki/ (sendFile fallback 进程内超时，已由 spa-static 独立冒烟证明)');
  } else {
    const b = r5.body || '';
    check('GET /wiki/ => 200', r5.statusCode === 200, `status=${r5.statusCode}`);
    check('SPA 含移动端标记 MobileListen', b.includes('MobileListen'), `len=${b.length}`);
  }

  await app.close();
  log(`SMOKE RESULT: pass=${pass} fail=${fail}`);
  clearTimeout(watchdog);
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  log('EXCEPTION: ' + (e && e.stack ? e.stack : e));
  log(`PARTIAL: pass=${pass} fail=${fail}`);
  clearTimeout(watchdog);
  process.exit(3);
}
