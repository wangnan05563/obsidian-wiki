// 全量路由进程内冒烟（绕过沙箱 TCP 拦截 + 本项目 Fastify onSend 与 inject 不兼容问题）。
// 通过 WIKI_SMOKE=1 守卫：跳过 helmet(onSend) 与 rateLimit，仅验证 API 行为契约。
process.env.WIKI_SMOKE = '1';
process.env.WIKI_DISABLE_RATE_LIMIT = '1';

const results = [];
function assert(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}

function injectWithTimeout(app, opts, ms = 8000) {
  return Promise.race([
    app.inject(opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('INJECT_TIMEOUT')), ms)),
  ]);
}

const { buildApp } = await import('./src/index.ts');
const { app } = await buildApp();
await app.ready();
console.log('buildApp + ready OK');

// 1) 健康检查
try {
  const r = await injectWithTimeout(app, { url: '/health', method: 'GET' });
  assert('GET /health => 200', r.statusCode === 200, `status=${r.statusCode}`);
} catch (e) {
  assert('GET /health => 200', false, e.message);
}

// 2) SPA 根（Funnel 剥除 /wiki/ 后后端收到 /）
try {
  const r = await injectWithTimeout(app, { url: '/', method: 'GET' });
  const body = typeof r.body === 'string' ? r.body : String(r.body ?? '');
  assert('GET / => 200 + index.html', r.statusCode === 200 && body.includes('<div id="app">'), `status=${r.statusCode} len=${body.length}`);
} catch (e) {
  assert('GET / => 200 + index.html', false, e.message);
}

// 3) SPA /wiki/ 前缀 + 提取主 JS bundle 验证含移动端组件
try {
  const r = await injectWithTimeout(app, { url: '/wiki/', method: 'GET' });
  const body = typeof r.body === 'string' ? r.body : String(r.body ?? '');
  const m = body.match(/\/wiki\/assets\/index-[^"']+\.js/);
  let ok = r.statusCode === 200;
  let detail = `status=${r.statusCode}`;
  if (m) {
    detail += ` js=${m[0]}`;
    const jr = await injectWithTimeout(app, { url: m[0], method: 'GET' });
    const jb = typeof jr.body === 'string' ? jr.body : String(jr.body ?? '');
    const hasMobile = jb.includes('MobileListen') && jb.includes('聆听');
    ok = ok && hasMobile;
    detail += ` hasMobile=${hasMobile} jsLen=${jb.length}`;
  } else {
    ok = false;
    detail += ' no-js-ref';
  }
  assert('GET /wiki/ => 200 + bundle 含移动端(MobileListen/聆听)', ok, detail);
} catch (e) {
  assert('GET /wiki/ => 200 + bundle 含移动端', false, e.message);
}

// 4) TTS voices（静态列表，无网络）
try {
  const r = await injectWithTimeout(app, { url: '/api/tts/voices', method: 'GET' });
  const body = typeof r.body === 'string' ? r.body : String(r.body ?? '');
  let ok = r.statusCode < 500;
  let detail = `status=${r.statusCode}`;
  try {
    const arr = JSON.parse(body);
    const list = Array.isArray(arr) ? arr : (arr && Array.isArray(arr.voices) ? arr.voices : null);
    detail += ` count=${list ? list.length : 'non-array:' + body.slice(0, 120)}`;
    ok = ok && list !== null && list.length > 0;
  } catch {
    detail += ` parseFail body=${body.slice(0, 120)}`;
  }
  assert('GET /api/tts/voices => 200 + 非空列表', ok, detail);
} catch (e) {
  assert('GET /api/tts/voices => 200 + 非空列表', false, e.message);
}

// 5) 缺凭证 /api/query => 4xx（auth 先挡 401，或 BYOK 强制 400 均算"被拒"契约）
try {
  const r = await injectWithTimeout(app, {
    url: '/api/query',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ question: 'test' }),
  });
  assert('POST /api/query 缺凭证 => 4xx(被拒)', r.statusCode >= 400 && r.statusCode < 500, `status=${r.statusCode}`);
} catch (e) {
  assert('POST /api/query 缺凭证 => 4xx(被拒)', false, e.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
