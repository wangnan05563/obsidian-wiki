const base = 'http://127.0.0.1:3000';
function get(path, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(base + path, { signal: ctrl.signal })
    .then(async (r) => {
      const body = await r.text();
      clearTimeout(t);
      return { ok: true, status: r.status, len: body.length, head: body.slice(0, 60) };
    })
    .catch((e) => ({ ok: false, err: e.name === 'AbortError' ? 'TIMEOUT' : e.message }));
}
function post(path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      const txt = await r.text();
      clearTimeout(t);
      return { ok: true, status: r.status, len: txt.length, head: txt.slice(0, 80) };
    })
    .catch((e) => ({ ok: false, err: e.name === 'AbortError' ? 'TIMEOUT' : e.message }));
}
(async () => {
  console.log('ROOT / =>', JSON.stringify(await get('/')));
  console.log('ASSET index.js =>', JSON.stringify(await get('/assets/index-BpP6ZQ_c.js')));
  console.log('TTS voices =>', JSON.stringify(await get('/api/tts/voices')));
  console.log('QUERY no-key =>', JSON.stringify(await post('/api/query', { question: 'test' })));
  console.log('WIKI root =>', JSON.stringify(await get('/wiki/', 8000)));
})();
