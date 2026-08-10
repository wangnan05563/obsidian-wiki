// Zero-dependency OpenAI-compatible mock LLM server for performance testing.
// Purpose: isolate the karpathy-wiki backend from real LLM upstreams so that
// AI/SSE endpoints (POST /api/query, /api/compile, /api/tags/suggest, /api/podcast)
// can be load-tested with zero token cost and controllable latency.
//
// It implements the exact contract the harness expects (verified in
// wiki-harness .../llm/openai-compatible.ts):
//   - POST ${baseUrl}/chat/completions
//   - Authorization: Bearer <apiKey>  (any key accepted)
//   - SSE format:  data: {"choices":[{"delta":{"content":"..."}}]}\n\n ... data: [DONE]\n\n
//   - non-stream:  {"choices":[{"message":{"content":"..."}}]}
//   - single response must complete well under the harness 60s AbortSignal timeout.

import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 4000);
const HOST = process.env.MOCK_LLM_HOST || '127.0.0.1';
const LATENCY_MS = Number(process.env.MOCK_LLM_LATENCY_MS || 800);
const CHUNKS = Number(process.env.MOCK_LLM_CHUNKS || 8);
const CHUNK_GAP_MS = Number(process.env.MOCK_LLM_CHUNK_GAP_MS || 120);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FULL_TEXT =
  '这是一个用于性能测试的模拟回答。它会被切分成若干片段，通过 SSE 逐片下发给调用方，' +
  '用以模拟真实大模型流式输出的行为，从而压测后端在长连接、背压与并发场景下的表现。';

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function handleCompletions(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  readBody(req).then((body) => {
    const stream = body.stream === true || body.stream === 'true';
    // pick the last user message as echo text, else fixed text
    let echo = FULL_TEXT;
    try {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const last = msgs[msgs.length - 1];
      if (last && last.content) echo = String(last.content);
    } catch {
      /* ignore */
    }

    if (!stream) {
      // non-stream JSON response
      const payload = JSON.stringify({
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: FULL_TEXT }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: FULL_TEXT.length, total_tokens: 10 + FULL_TEXT.length },
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      setTimeout(() => {
        res.end(payload);
      }, LATENCY_MS);
      return;
    }

    // SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const pieces = [];
    const len = Math.ceil(echo.length / CHUNKS);
    for (let i = 0; i < CHUNKS; i++) pieces.push(echo.slice(i * len, (i + 1) * len));

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    let i = 0;
    let timer = null;
    const push = () => {
      if (closed || res.writableEnded) {
        if (timer) clearInterval(timer);
        return;
      }
      if (i < pieces.length) {
        const chunk = JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] });
        res.write(`data: ${chunk}\n\n`);
        i++;
      } else {
        res.write('data: [DONE]\n\n');
        if (timer) clearInterval(timer);
        res.end();
      }
    };

    // initial latency before first byte
    setTimeout(() => {
      if (closed || res.writableEnded) return;
      push();
      timer = setInterval(push, CHUNK_GAP_MS);
    }, LATENCY_MS);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (url === '/v1/models' || url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
    return;
  }
  if (url === '/v1/chat/completions' || url.startsWith('/v1/chat/completions')) {
    handleCompletions(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 130000;

server.listen(PORT, HOST, () => {
  console.log(`[mock-llm] listening on http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`[mock-llm] LATENCY_MS=${LATENCY_MS} CHUNKS=${CHUNKS} CHUNK_GAP_MS=${CHUNK_GAP_MS}`);
});

function shutdown() {
  console.log('\n[mock-llm] shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
