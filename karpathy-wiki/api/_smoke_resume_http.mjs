// X-2 HTTP 端到端冒烟：打真实运行中的后端（127.0.0.1:3000，需 dangerouslyDisableSandbox 以跨进程 TCP）。
// 覆盖：
//   A) 登录拿 token（验证 auth 链路）
//   B) GET /health => 200
//   C) GET / => 200 + index.html（验证新部署 SPA 可被服务）
//   D) 断线重连短路：POST /api/query {resume: <合法UUID但不存在>} => SSE error(code=RESUME_NOT_FOUND)
//   E) 可恢复首连：POST /api/query（带 agnes BYOK）→ 首帧 open{runId}；中途 abort（模拟刷新/断网）
//   F) 重连回放：POST /api/query {resume: runId} → 收到 done（证明 run 在后台跑完并被重连订阅者完整回放）
import { randomUUID } from 'node:crypto';

const BASE = 'http://127.0.0.1:3000';
const results = [];
function assert(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}

// ── SSE 读取器：按 \n\n 切分事件，回调 onEvent(event,dataObj)；到 maxMs 或流结束停止 ──
async function readSSE(response, { onEvent, maxMs = 60000, signal } = {}) {
  if (!response.body) throw new Error('no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + maxMs;
  while (true) {
    if (signal?.aborted) break;
    if (Date.now() > deadline) break;
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const raw of parts) {
      let ev = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        let obj;
        try { obj = JSON.parse(data); } catch { obj = data; }
        onEvent(ev, obj);
      }
    }
  }
  try { await reader.cancel(); } catch { /* ignore */ }
}

// ── A) 登录 ──
let token = null;
try {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const j = await r.json();
  token = j.token || null;
  assert('A) 登录 admin => 200 + token', r.statusCode === 200 || r.ok && token, `status=${r.status} hasToken=${!!token}`);
} catch (e) {
  assert('A) 登录 admin', false, e.message);
}
if (!token) {
  console.log('\nSMOKE ABORTED: 无 token，后续依赖鉴权的用例跳过');
  process.exit(1);
}
const authH = { Authorization: `Bearer ${token}` };

// ── B) 健康检查 ──
try {
  const r = await fetch(`${BASE}/health`);
  assert('B) GET /health => 200', r.status === 200, `status=${r.status}`);
} catch (e) {
  assert('B) GET /health => 200', false, e.message);
}

// ── C) SPA 根 ──
try {
  const r = await fetch(`${BASE}/`);
  const txt = await r.text();
  assert('C) GET / => 200 + index.html', r.status === 200 && txt.includes('<div id="app">'), `status=${r.status} len=${txt.length}`);
} catch (e) {
  assert('C) GET / => 200 + index.html', false, e.message);
}

// ── D) 断线重连短路：不存在的 runId ──
try {
  const fakeRun = randomUUID();
  const r = await fetch(`${BASE}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authH },
    body: JSON.stringify({ resume: fakeRun }),
  });
  let found = null;
  await readSSE(r, {
    maxMs: 5000,
    onEvent: (ev, obj) => { if (ev === 'error') found = obj; },
  });
  const ok = ev => false; // placeholder
  assert('D) resume 不存在 runId => error(RESUME_NOT_FOUND)',
    !!found && found.code === 'RESUME_NOT_FOUND',
    `code=${(found && found.code) || 'none'}`);
} catch (e) {
  assert('D) resume 不存在 runId => error(RESUME_NOT_FOUND)', false, e.message);
}

// ── E) 可恢复首连：发起到 open{runId}，再中途 abort ──
let runId = null;
let startText = '';
try {
  const ctrl = new AbortController();
  const r = await fetch(`${BASE}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authH },
    body: JSON.stringify({
      question: '用一句话解释什么是检索增强生成（RAG）？',
      stream: true,
      llmConfig: {
        provider: 'agnes',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        model: 'agnes-2.0-flash',
        apiKey: '***REDACTED-SECRET***',
      },
    }),
    signal: ctrl.signal,
  });
  // 读取到 open{runId} 且拿到部分 answer 后主动 abort（模拟客户端断网/刷新）
  const gotRun = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 45000);
    readSSE(r, {
      maxMs: 45000,
      signal: ctrl.signal,
      onEvent: (ev, obj) => {
        if (ev === 'open' && obj.runId) { runId = obj.runId; }
        if (ev === 'answer' && obj.text) { startText += obj.text; }
        // 拿到 runId 且已有一段正文（说明 LLM 在真正产出）→ 模拟断网
        if (runId && startText.length > 20) {
          clearTimeout(t);
          ctrl.abort(); // 断开首连，但后端 run 继续
          resolve('got');
        }
      },
    }).then(() => clearTimeout(t)).catch(() => {});
  });
  const st = await gotRun;
  // E 只需验证「可恢复首连已建立并下发 open{runId}」；正文产出由 F 的完整回放（replayLen>0）佐证。
  // 放宽首连正文量要求，避免 LLM 首 token 延迟 >45s 时的偶发误判（F 仍会拿到完整回放）。
  assert('E) 首连 open{runId}（可恢复首连建立）', !!runId, `runId=${runId ? 'yes' : 'no'} startLen=${startText.length} st=${st}`);
} catch (e) {
  assert('E) 首连 open{runId} + 产出正文', false, e.message);
}

// 若没拿到 runId（LLM 不可达），跳过 F
if (!runId) {
  console.log('  (跳过 F：未拿到 runId，可能因 LLM 不可达；replay 逻辑已由 _smoke_resume.ts 单元测试覆盖)');
} else {
  // ── F) 重连回放：用 runId 续接，应收到 done（证明后台 run 跑完并被重连订阅者完整回放）──
  try {
    const r = await fetch(`${BASE}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authH },
      body: JSON.stringify({ resume: runId }),
    });
    let done = false;
    let replayText = '';
    let errEv = null;
    let doneRunId = null;
    await readSSE(r, {
      maxMs: 120000,
      onEvent: (ev, obj) => {
        if (ev === 'answer' && obj.text) replayText += obj.text;
        if (ev === 'done') { done = true; doneRunId = obj.runId; }
        if (ev === 'error') errEv = obj;
      },
    });
    // F3 验证：done.runId 必须 ≠ open.runId（manager runId）。修复前二者相等（done 误用 manager runId），
    // 修复后 done.runId 为 harness runId（chunk.runId），供 X-1 步骤追踪；二者均为随机 UUID，几乎必然不同。
    const f3ok = doneRunId && doneRunId !== runId;
    const ok = done && replayText.length > 0 && f3ok;
    assert('F) resume 重连 => done + 完整回放', ok,
      `done=${done} replayLen=${replayText.length} doneRunId=${doneRunId || 'none'} openRunId=${runId || 'none'} doneRunId≠openRunId=${!!f3ok}${errEv ? ' err=' + JSON.stringify(errEv) : ''}`);
  } catch (e) {
    assert('F) resume 重连 => done + 完整回放', false, e.message);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
