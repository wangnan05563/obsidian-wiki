import http from 'node:http';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3000, path, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

(async () => {
  const results = {};
  // 1. health
  try { const r = await get('/health'); results.health = r.status; } catch (e) { results.health = 'ERR ' + e.message; }
  // 2. index
  let indexStatus = 'ERR', jsUrl = '', indexBody = '';
  try {
    const r = await get('/');
    indexStatus = r.status; indexBody = r.body;
    const m = indexBody.match(/assets\/(index-[^"']+\.js)/);
    if (m) jsUrl = '/assets/' + m[1];
  } catch (e) { indexStatus = 'ERR ' + e.message; }
  results.index = indexStatus;
  results.jsUrl = jsUrl;
  // 3. fetch JS and check theme features
  if (jsUrl) {
    try {
      const r = await get(jsUrl);
      const b = r.body;
      results.jsStatus = r.status;
      results.hasLightBusiness = b.includes('light-business');
      results.hasLabel = b.includes('商务浅白');
      results.hasLightBusinessCss = b.includes('light-business');
    } catch (e) { results.js = 'ERR ' + e.message; }
  }
  // 4. wiki route
  try { const r = await get('/wiki/'); results.wiki = r.status; } catch (e) { results.wiki = 'ERR ' + e.message; }
  // 5. presets (expect 401 unauth)
  try { const r = await get('/api/ai/presets'); results.presets = r.status; } catch (e) { results.presets = 'ERR ' + e.message; }

  console.log(JSON.stringify(results, null, 2));
  const ok = results.health === 200 && results.index === 200 && results.jsStatus === 200 && results.hasLightBusiness && results.hasLabel && results.wiki === 200 && results.presets === 401;
  console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
})();
