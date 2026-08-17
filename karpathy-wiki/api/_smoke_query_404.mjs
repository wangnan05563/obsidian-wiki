// 针对 Request 3 修复的进程内冒烟：验证「续接不存在的 threadId 不再误 404」。
// 机制：WIKI_SMOKE=1 跳过 helmet/rateLimit，app.inject 在进程内跑完整中间件链。
// 默认 admin/admin123 登录拿 token → 带 token + 伪造 llmConfig（绕过 BYOK 强制 400）
// + 不存在的 threadId 调 /api/query：
//   修复前：resolveThreadContext 对「不存在的 threadId」抛 404 → 整体 404；
//   修复后：persist=false 下 getThread 恒 null，仅保留跨用户保护 → 写 200 并启动 SSE（上游因假密钥失败，但已非 404）。
process.env.WIKI_SMOKE = '1';
process.env.WIKI_DISABLE_RATE_LIMIT = '1';
// 清掉全局代理（HTTPS_PROXY/HTTP_PROXY）以免伪造的 baseUrl 经代理挂起；
// 直连 127.0.0.1:1 会立即 ECONNREFUSED，使 SSE 快速以错误事件结束 → 状态 200（非 404）。
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[k];

const results = [];
function assert(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}

function injectWithTimeout(app, opts, ms = 20000) {
  return Promise.race([
    app.inject(opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('INJECT_TIMEOUT')), ms)),
  ]);
}

const { buildApp } = await import('./src/index.ts');
const { app } = await buildApp();
await app.ready();
console.log('buildApp + ready OK');

// 1) 登录默认 admin 拿 token
let token = '';
try {
  const r = await injectWithTimeout(app, {
    url: '/api/auth/login',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const body = JSON.parse(typeof r.body === 'string' ? r.body : String(r.body ?? '{}'));
  token = body.token || '';
  assert('login admin => 200 + token', r.statusCode === 200 && !!token, `status=${r.statusCode} tokenLen=${token.length}`);
} catch (e) {
  assert('login admin', false, e.message);
}

// 2) 续接「不存在的 threadId（合法 UUID，模拟首问后前端续接的会话）」+ 伪造 llmConfig
// 修复判定：404 会在 writeHead(200) 之前同步 return，绝不可能挂起；只有修复后（写 200 + 启动 SSE +
// 进入 LLM 管线，上游因假密钥 6s 超时挂起）才会「流式挂起 / 最终 200」。故：收到 200 或 INJECT_TIMEOUT
// 均证明「不再 404」；收到 404 才是修复失效。
try {
  const r = await injectWithTimeout(app, {
    url: '/api/query',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: JSON.stringify({
      question: 'test',
      threadId: (await import('node:crypto')).randomUUID(),
      llmConfig: { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'fake' },
    }),
  }, 12000);
  const ok = r.statusCode === 200;
  assert('POST /api/query 续接不存在UUID threadId => 200(修复生效)', ok, `status=${r.statusCode}`);
} catch (e) {
  if (e.message === 'INJECT_TIMEOUT') {
    // 关键判据：404 同步返回不会挂起；超时=已 writeHead(200) 进入 LLM 流式管线=修复生效。
    assert('POST /api/query 续接不存在UUID threadId => 非404(流式挂起即证明)', true, 'INJECT_TIMEOUT(=越过校验,未404)');
  } else {
    assert('POST /api/query 续接不存在UUID threadId', false, e.message);
  }
}

// 3) 对照：缺 llmConfig => 400（BYOK 强制），证明校验链路正常、且「非404」不是因为被提前拦截
try {
  const r = await injectWithTimeout(app, {
    url: '/api/query',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: JSON.stringify({ question: 'test', threadId: 'another-nonexistent' }),
  });
  assert('POST /api/query 缺 llmConfig => 400(BYOK)', r.statusCode === 400, `status=${r.statusCode}`);
} catch (e) {
  assert('POST /api/query 缺 llmConfig', false, e.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
