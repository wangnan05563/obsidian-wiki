#!/usr/bin/env node
/**
 * analyze-query-logs.mjs
 * ---------------------------------------------------------------------------
 * 把 karpathy-wiki 问答管线的 stage 日志聚合为「每请求阶段耗时时间线 + 瓶颈定位」。
 *
 * 两类日志来源（均会被解析并合并）：
 *   1) 路由层 pino 日志：msg === "query-pipeline"
 *        {"time":<epoch ms>,"reqId":..,"threadId":..,"phase":"accepted|first-token|done|error","elapsedMs":..,"msg":"query-pipeline"}
 *   2) harness 内部 console.log：
 *        [query-stage] {"ts":<epoch ms>,"phase":"workflow-start|mw-resolved|harness-start|harness-run-done|harness-done|fallback-start|stream-first-delta|stream-done|workflow-done|...","elapsedMs":..,"q":"<前24字>",...}
 *
 * 用法：
 *   node analyze-query-logs.mjs [logfile ...] [--top N]
 *   无参数时自动在 cwd / api / api/logs / logs 下发现 *.log
 *
 * 设计：完全用绝对时间戳 ts/time 算相邻阶段差值（基准无关），不依赖各流各自的 elapsedMs 基线。
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';

const START_PHASES = new Set(['accepted', 'workflow-start']);
const TERMINAL_PHASES = new Set(['done', 'error', 'workflow-done', 'stream-done', 'fallback-done']);

// phase → 中文含义（给用户看）
const PHASE_DESC = {
  accepted: '路由接收(鉴权+BYOK+线程解析+上下文治理)',
  'first-token': '路由首个 answer token 发出',
  done: '路由整轮完成(SSE 收尾+refs 下发)',
  error: '路由错误',
  'workflow-start': 'queryWorkflow 启动',
  'mw-resolved': '中间件解析(stream/web/deep)完成',
  'harness-start': 'harness 执行开始',
  'harness-run-done': 'harness.run 整段 ReAct 循环结束(非流式)',
  'harness-done': 'harness 成功',
  'harness-failed': 'harness 失败→进入降级',
  'fallback-start': '降级链启动',
  'fallback-done': '降级成功',
  'fallback-failed': '降级失败→兜底',
  'stream-first-delta': 'harness.runStream 首个 LLM token(流式首响延迟)',
  'stream-done': 'harness.runStream 事件流结束',
  'workflow-done': 'queryWorkflow 结束',
};

function parseArgs(argv) {
  const files = [];
  let top = 10;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') top = parseInt(argv[++i] ?? '10', 10) || 10;
    else if (a.startsWith('--top=')) top = parseInt(a.split('=')[1], 10) || 10;
    else files.push(a);
  }
  return { files, top };
}

function discover() {
  const roots = [
    process.cwd(),
    path.resolve(process.cwd(), 'api'),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), 'karpathy-wiki/api'),
  ];
  const found = new Set();
  for (const r of roots) {
    for (const sub of ['logs', 'api/logs', 'karpathy-wiki/api/logs']) {
      const dir = path.resolve(r, sub);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.log')) found.add(path.join(dir, f));
        }
      } catch { /* ignore */ }
    }
  }
  return [...found];
}

function extractRecords(file) {
  const recs = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`[warn] 无法读取 ${file}: ${e.message}`);
    return recs;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // 1) pino JSON 行
    if (line.startsWith('{')) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && obj.msg === 'query-pipeline' && obj.phase) {
        const ts = typeof obj.time === 'number' ? obj.time : Date.parse(obj.time);
        if (Number.isFinite(ts)) {
          recs.push({ src: 'pipeline', ts, phase: obj.phase, elapsedMs: obj.elapsedMs, q: obj.q, reqId: obj.reqId, threadId: obj.threadId });
        }
      }
      continue;
    }
    // 2) 原始 [query-stage] 行（console.log 到 stdout）
    const idx = line.indexOf('[query-stage]');
    if (idx >= 0) {
      const jsonStr = line.slice(idx + '[query-stage]'.length).trim();
      let obj;
      try { obj = JSON.parse(jsonStr); } catch { continue; }
      if (obj && obj.phase) {
        const ts = Number(obj.ts);
        if (Number.isFinite(ts)) {
          recs.push({ src: 'stage', ts, phase: obj.phase, elapsedMs: obj.elapsedMs, q: obj.q, extra: obj });
        }
      }
    }
  }
  return recs;
}

function groupRequests(records) {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const FINAL = new Set(['done', 'error', 'workflow-done', 'stream-done', 'fallback-done']);
  const hasPhase = (g, p) => g.records.some((r) => r.phase === p);
  const shouldStartNew = (rec, cur) => {
    if (!cur) return true;
    if (rec.phase === 'accepted') return true; // 硬边界：每请求仅一个 accepted
    if (rec.phase === 'workflow-start') {
      if (cur.closed) return true; // 上一请求已结束
      if (hasPhase(cur, 'accepted')) return false; // 同请求的 harness 启动
      if (hasPhase(cur, 'workflow-start')) return true; // 新的纯 stage 请求
      return false; // 本组首个 workflow-start
    }
    return false;
  };
  const groups = [];
  let cur = null;
  for (const rec of sorted) {
    if (shouldStartNew(rec, cur)) {
      if (cur) groups.push(cur);
      cur = { records: [rec], closed: false };
    } else {
      cur.records.push(rec);
    }
    if (FINAL.has(rec.phase)) cur.closed = true;
  }
  if (cur) groups.push(cur);
  return groups;
}

function analyzeGroup(g, idx) {
  const recs = g.records;
  const firstTs = recs[0].ts;
  const lastTs = recs[recs.length - 1].ts;
  const total = lastTs - firstTs;
  const steps = [];
  let prevTs = firstTs;
  let bottleneck = null;
  for (const r of recs) {
    const gap = r.ts - prevTs;
    prevTs = r.ts;
    steps.push({ phase: r.phase, src: r.src, gap, ts: r.ts });
    if (gap > 0 && (!bottleneck || gap > bottleneck.gap)) {
      bottleneck = { phase: r.phase, gap, src: r.src };
    }
  }
  // 首 token 延迟（路由层）
  const accepted = recs.find((r) => r.phase === 'accepted');
  const firstTok = recs.find((r) => r.phase === 'first-token');
  const firstTokenLatency = accepted && firstTok ? firstTok.ts - accepted.ts : null;
  const q = recs.find((r) => r.q)?.q ?? '(未知问题)';
  return { idx, q, total, steps, bottleneck, firstTokenLatency, count: recs.length };
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function render(groups) {
  if (groups.length === 0) {
    console.log('未发现任何 query-pipeline / query-stage 日志。');
    console.log('提示：路由层日志走 pino（默认写入 api/logs/*.log），harness 内部日志走 console.log（stdout）。');
    console.log('      若两者分处不同文件，请把它们都作为参数传入：node analyze-query-logs.mjs api/logs/api-dev.log stdout.log');
    return;
  }
  const analyzed = groups.map(analyzeGroup);
  console.log(`\n=== 问答管线阶段耗时分析（共 ${analyzed.length} 个请求）===\n`);
  for (const a of analyzed) {
    const bnPct = a.bottleneck && a.total > 0 ? Math.round((a.bottleneck.gap / a.total) * 100) : 0;
    console.log(`#${a.idx + 1}  q="${a.q}"  总耗时 ${fmtMs(a.total)}  阶段数 ${a.count}`);
    if (a.firstTokenLatency != null) {
      console.log(`     首 token 延迟(路由): ${fmtMs(a.firstTokenLatency)}`);
    }
    for (const s of a.steps) {
      const desc = PHASE_DESC[s.phase] ?? s.phase;
      console.log(`     [${fmtMs(s.gap).padStart(7)}] ${s.phase.padEnd(20)} ${desc}  (${s.src})`);
    }
    if (a.bottleneck) {
      const bdesc = PHASE_DESC[a.bottleneck.phase] ?? a.bottleneck.phase;
      console.log(`     → 瓶颈: ${a.bottleneck.phase} (${fmtMs(a.bottleneck.gap)}, 占 ${bnPct}%)  ${bdesc}`);
    }
    console.log('');
  }
  // 最慢 Top N
  const top = analyzed.slice().sort((x, y) => y.total - x.total).slice(0, ARGS.top);
  console.log(`--- 最慢 Top ${top.length} ---`);
  for (const a of top) {
    const bn = a.bottleneck ? `${a.bottleneck.phase}=${fmtMs(a.bottleneck.gap)}` : '—';
    console.log(`  #${a.idx + 1}  ${fmtMs(a.total).padStart(7)}  q="${a.q}"  瓶颈: ${bn}`);
  }
}

const ARGS = parseArgs(process.argv.slice(2));
const files = ARGS.files.length ? ARGS.files : discover();
if (files.length === 0) {
  console.log('未发现日志文件，请显式传入：node analyze-query-logs.mjs <logfile> [<logfile2> ...]');
  process.exit(0);
}
console.log(`读取日志文件: ${files.join(', ')}`);
let all = [];
for (const f of files) all = all.concat(extractRecords(f));
console.log(`解析到 ${all.length} 条 stage 记录`);
const groups = groupRequests(all);
render(groups);
