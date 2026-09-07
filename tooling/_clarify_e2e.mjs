// 意图澄清端到端验证脚本（临时）：mock LLM + 真实 HTTP SSE 链路。
// 前置：后端已启动（WIKI_DISABLE_RATE_LIMIT=1），本脚本自带 mock LLM 服务（:9099）。
// 验证三段链路：
//   1. 首轮提问（无 clarifyId）→ SSE 收到 clarify 事件（round=1，无 done）
//   2. 用户选择后重发（clarifyId + choiceIndex）→ 仍歧义且轮次未满 → 再收 clarify（round=2）
//   3. 再次选择后重发 → 轮次已满 → 正常回答（收到 answer + done）
// 运行：node tooling/_clarify_e2e.mjs
import http from 'node:http';

const MOCK_PORT = 9099;
const API = 'http://127.0.0.1:3000';

// ── mock LLM：所有 chat/completions 请求都返回同一个"歧义报告"JSON ──
// planner 调用拿到它只当计划文本；detectAmbiguity 解析它得到 ambiguous=true。
const AMBIGUOUS_JSON = JSON.stringify({
  ambiguous: true,
  confidence: 0.9,
  interpretations: [
    { label: '水果苹果', description: '指可食用的苹果水果' },
    { label: '苹果公司', description: '指 Apple 公司相关话题' },
    { label: '苹果设备', description: '指 iPhone / Mac 等设备' },
  ],
  recommendedIndex: 0,
});

const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: AMBIGUOUS_JSON } }] }));
  });
});

// ── 解析 SSE 流：返回 [事件类型, 数据] 列表 ──
async function postQuery(body) {
  const res = await fetch(`${API}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const events = [];
  for (const block of text.split('\n\n')) {
    let type = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (type && data) {
      try { events.push({ type, data: JSON.parse(data) }); } catch { events.push({ type, data }); }
    }
  }
  return events;
}

function baseBody() {
  return {
    question: '什么是苹果？',
    // BYOK：指向 mock LLM
    llmConfig: { provider: 'mock', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, model: 'mock', apiKey: 'e2e-test-key' },
    stream: false,
  };
}

function summary(events) {
  return events.map((e) => {
    const d = e.data;
    if (e.type === 'clarify') return `clarify(round=${d.round}, id=${d.id.slice(0, 8)}, options=${d.interpretations.length})`;
    if (e.type === 'answer') return 'answer';
    if (e.type === 'done') return `done(thread=${(d.threadId || '').slice(0, 8)})`;
    return e.type;
  }).join(', ');
}

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

mockServer.listen(MOCK_PORT, '127.0.0.1', async () => {
  console.log(`[mock-llm] listening :${MOCK_PORT}`);
  try {
    // ── 阶段 1：首轮提问 → 应中断并下发澄清卡片 ──
    const e1 = await postQuery(baseBody());
    const c1 = e1.find((e) => e.type === 'clarify');
    assert(!!c1, `阶段1 收到 clarify 事件（实际: ${e1.map((e) => e.type).join(',')}）`);
    assert(c1?.data.round === 1, `阶段1 round=1（实际 ${c1?.data.round}）`);
    assert(c1?.data.interpretations?.length === 3, `阶段1 选项数=3（实际 ${c1?.data.interpretations?.length}）`);
    assert(!e1.some((e) => e.type === 'done'), '阶段1 无 done 事件（中断而非完成）');
    assert(c1?.data.prompt?.includes('请选择'), '阶段1 提示语含引导文案');
    const id = c1.data.id;
    const threadId = c1.data.threadId;

    // ── 阶段 2：用户选择选项 1 → 仍歧义且轮次未满 → 再次中断（round=2，同一 id）──
    const e2 = await postQuery({ ...baseBody(), threadId, clarifyId: id, choiceIndex: 1 });
    const c2 = e2.find((e) => e.type === 'clarify');
    assert(!!c2, `阶段2 收到第二轮 clarify（实际: ${e2.map((e) => e.type).join(',')}）`);
    assert(c2?.data.round === 2, `阶段2 round=2（实际 ${c2?.data.round}）`);
    assert(c2?.data.id === id, '阶段2 同一 clarifyId');
    assert(!e2.some((e) => e.type === 'done'), '阶段2 无 done');

    // ── 阶段 3：再次选择 → 轮次已满 → 正常回答（answer + done）──
    const e3 = await postQuery({ ...baseBody(), threadId, clarifyId: id, choiceIndex: 0 });
    const hasAnswer = e3.some((e) => e.type === 'answer');
    const hasDone = e3.some((e) => e.type === 'done');
    const hasClarify = e3.some((e) => e.type === 'clarify');
    assert(!hasClarify, `阶段3 不再中断（实际: ${e3.map((e) => e.type).join(',')}）`);
    assert(hasAnswer && hasDone, `阶段3 收到 answer+done（answer=${hasAnswer}, done=${hasDone}）`);

    // ── 阶段 4：非法 clarifyId（不存在）→ 视为新提问，重新检测 → 仍中断 round=1 ──
    const e4 = await postQuery({ ...baseBody(), threadId, clarifyId: 'no-such-id', choiceIndex: 0 });
    const c4 = e4.find((e) => e.type === 'clarify');
    assert(!!c4 && c4?.data.round === 1, `阶段4 非法 clarifyId 重新检测（round=${c4?.data.round ?? '无'}）`);

    console.log('\n事件流摘要：');
    console.log('  阶段1:', summary(e1));
    console.log('  阶段2:', summary(e2));
    console.log('  阶段3:', summary(e3));
    console.log('  阶段4:', summary(e4));
    console.log(`\n结果: ${failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'}`);
  } catch (err) {
    console.error('E2E 出错:', err.message);
    failures++;
  } finally {
    mockServer.close();
    process.exit(failures === 0 ? 0 : 1);
  }
});
