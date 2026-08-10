// Performance matrix driver v2 — self-managing Node process.
// Fixes the v1 shell driver's two fatal flaws:
//   1. Backend lifecycle: spawns backend as a direct child (not an orphaned nohup),
//      so the process tree stays alive for the full run and is killed on exit.
//   2. Reliable waits: uses real setTimeout instead of the (missing) `sleep`/`seq` in Git Bash.
// Plus a hard preflight gate: aborts if login burst or request burst shows ANY 429
// (proves WIKI_DISABLE_RATE_LIMIT=1 is truly effective) so we never again produce
// rate-limit-polluted results.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库';
const API = path.join(ROOT, 'karpathy-wiki/api');
const PFX = path.join(ROOT, 'perf-tests');
const RESULTS = path.join(PFX, 'results');
const VAULT = path.join(ROOT, 'karpathy-wiki/data/vault');
const NODE = 'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const JM = 'D:/code/Jmeter/apache-jmeter-5.6.3/bin/jmeter.bat';
const TSX = path.join(API, 'node_modules/tsx/dist/cli.mjs');
const JAVA_HOME = 'D:/code/Java/zulu17.52.17-ca-jdk17.0.12-win_x64';

const LOG = fs.createWriteStream(path.join(RESULTS, '_matrix_v2.log'), { flags: 'w' });
function log(...a) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG.write(s + '\n');
  console.log(s);
}

const BACKEND_ENV = {
  WIKI_DISABLE_RATE_LIMIT: '1',
  WIKI_DISABLE_COMPRESSION: '1',
  UV_THREADPOOL_SIZE: '64',
  WIKI_SESSION_SECRET: 'fixed-perf-test-secret-1234567890',
  HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
  ALL_PROXY: '', all_proxy: '',
};
const MOCK_ENV = { MOCK_LLM_LATENCY_MS: '800', MOCK_LLM_CHUNKS: '8', MOCK_LLM_CHUNK_GAP_MS: '120' };

let backend = null;
let mock = null;

function killPort3000() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 1500"]);
}

function startBackend() {
  backend = spawn(NODE, [TSX, 'src/index.ts'], {
    cwd: API, env: { ...process.env, ...BACKEND_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => LOG.write('[be] ' + d));
  backend.stderr.on('data', (d) => LOG.write('[be!] ' + d));
  backend.on('exit', (c, s) => log(`[backend exited code=${c} signal=${s}]`));
  log('backend spawned pid=' + backend.pid);
}

function curlCode(url) {
  return new Promise((res) => {
    const p = spawn('curl', ['-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', url]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => res(out.trim()));
    p.on('error', () => res('000'));
  });
}

async function waitHealth(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await curlCode('http://127.0.0.1:3000/health');
    if (c === '200') return true;
    await sleep(1000);
  }
  return false;
}

function loginOnce() {
  return new Promise((res) => {
    const p = spawn('curl', ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}',
      '-X', 'POST', 'http://127.0.0.1:3000/api/auth/login',
      '-H', 'Content-Type: application/json',
      '-d', '{"username":"admin","password":"admin123"}']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => res(out.trim()));
    p.on('error', () => res('000'));
  });
}

// Warmup: retry login until it returns 200 (absorbs cold-start / transient sandbox
// write-hang where the first few requests get 000). Only a genuine 429 means the
// rate limiter is active and the data would be polluted -> hard abort.
async function warmupLogin(maxMs = 45000) {
  const t0 = Date.now();
  let last = '000';
  while (Date.now() - t0 < maxMs) {
    last = await loginOnce();
    if (last === '200') return { ok: true, waitedMs: Date.now() - t0 };
    if (last === '429') return { ok: false, rateLimited: true, code: last };
    await sleep(500);
  }
  return { ok: false, rateLimited: false, timedOut: true, last };
}

async function preflight() {
  const wu = await warmupLogin();
  // REAL rate-limit detection: a slow 40-request loop (< 60/min) is a FALSE NEGATIVE
  // (it stays under the global cap whether or not limiting is on). Fire a tight burst
  // of 100 rapid /health instead — if limiting is still active, most will be 429.
  let ok = 0, e429 = 0, other = 0;
  for (let i = 0; i < 100; i++) {
    const c = await curlCode('http://127.0.0.1:3000/health');
    if (c === '200') ok++; else if (c === '429') e429++; else other++;
  }
  return { warmup: wu, l429: wu.rateLimited ? 1 : 0, burstOk: ok, burst429: e429, burstOther: other };
}

async function ensureMock() {
  const c = await curlCode('http://127.0.0.1:4000/v1/models');
  if (c === '200') { log('mock already up'); return; }
  log('starting mock LLM');
  mock = spawn(NODE, [path.join(PFX, 'mock-llm/server.mjs')], {
    cwd: path.join(PFX, 'mock-llm'), env: { ...process.env, ...MOCK_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stdout.on('data', (d) => LOG.write('[mock] ' + d));
  mock.stderr.on('data', (d) => LOG.write('[mock!] ' + d));
  for (let i = 0; i < 30; i++) {
    if ((await curlCode('http://127.0.0.1:4000/v1/models')) === '200') { log('mock up'); return; }
    await sleep(1000);
  }
  log('WARN mock did not come up in 30s');
}

function runJmx(name, jmx, threads, duration) {
  return new Promise((resolve) => {
    log(`=== RUN ${name} threads=${threads} dur=${duration} ===`);
    const args = ['-n', '-t', jmx, '-l', path.join(RESULTS, name + '.jtl'),
      '-q', 'jmeter.properties', '-Jthreads=' + threads, '-Jduration=' + duration];
    const p = spawn(JM, args, { cwd: PFX, env: { ...process.env, JAVA_HOME }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => { LOG.write('[jm] ' + d); buf += d; });
    p.stderr.on('data', (d) => LOG.write('[jm!] ' + d));
    const guard = setTimeout(() => {
      log(`WARN ${name} exceeded 300s safety timeout -> killing`);
      try { p.kill('SIGTERM'); } catch {}
    }, 300000);
    p.on('close', (code) => { clearTimeout(guard); log(`=== DONE ${name} exit=${code} ===`); resolve(code); });
    p.on('error', (e) => { clearTimeout(guard); log('jmx spawn error ' + e.message); resolve(-1); });
  });
}

function deleteMatching(dir, re) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) deleteMatching(fp, re);
    else if (re.test(e.name)) { try { fs.unlinkSync(fp); } catch {} }
  }
}

async function restartBackend() {
  if (backend) { try { backend.kill('SIGTERM'); } catch {} }
  await sleep(2000);
  killPort3000();
  await sleep(1000);
  startBackend();
  const ok = await waitHealth();
  if (!ok) { log('FATAL backend not ready after restart'); process.exit(2); }
  const pf = await preflight();
  if (pf.l429 > 0 || pf.burst429 > 0) { log('FATAL preflight failed after restart (rate limit) ' + JSON.stringify(pf)); process.exit(3); }
  if (!pf.warmup.ok) { log('FATAL login never succeeded after restart ' + JSON.stringify(pf)); process.exit(4); }
  log('backend restarted & preflight ok');
}

const SCENARIOS = [
  ['A-small-baseline', 'karpathy-perf.jmx', 5, 12],
  ['A-small-high', 'karpathy-perf.jmx', 25, 12],
  ['A-small-peak', 'karpathy-perf.jmx', 50, 12],
  ['B-query-normal', 'karpathy-perf-ai.jmx', 5, 25],
  ['B-query-high', 'karpathy-perf-ai.jmx', 30, 25],
  ['B-query-peak', 'karpathy-perf-ai.jmx', 60, 25],
  ['C-write-normal', 'karpathy-perf-write.jmx', 5, 25],
  ['C-write-high', 'karpathy-perf-write.jmx', 20, 25],
  ['D-compilelock', 'karpathy-perf-compilelock.jmx', 10, 25],
];

async function main() {
  log('===== MATRIX V2 START ' + new Date().toISOString() + ' =====');
  killPort3000();
  await sleep(1000);
  startBackend();
  if (!(await waitHealth())) { log('FATAL backend not ready'); process.exit(2); }
  const pf = await preflight();
  log('preflight ' + JSON.stringify(pf));
  if (pf.l429 > 0 || pf.burst429 > 0) { log('FATAL preflight failed (rate limit STILL ACTIVE despite WIKI_DISABLE_RATE_LIMIT=1) — aborting'); process.exit(3); }
  if (!pf.warmup.ok) { log('FATAL login never succeeded after warmup — backend wedged'); process.exit(4); }
  await ensureMock();

  for (const [n, j, t, d] of SCENARIOS) {
    // make sure backend is still alive before each scenario
    const hc = await curlCode('http://127.0.0.1:3000/health');
    if (hc !== '200') { log('backend down before ' + n + ' -> restarting'); await restartBackend(); }
    await runJmx(n, j, t, d);
    // If JMeter aborted (transient setUp login 000 -> stoptestnow), the jtl is ~1 line.
    // Rerun once; if it still fails, leave the marker and continue (don't poison the aggregate).
    const jtl = path.join(RESULTS, n + '.jtl');
    let lines = 0;
    try { lines = fs.readFileSync(jtl, 'utf8').split('\n').filter(Boolean).length; } catch {}
    if (lines < 10) {
      log(`WARN ${n} produced only ${lines} lines (likely aborted) -> rerun once`);
      await runJmx(n, j, t, d);
    }
  }
  deleteMatching(path.join(VAULT, 'perf-test'), /^load-.*\.md$/);
  log('cleaned perf-test load-*.md');

  // Phase 2: large vault
  log('=== generating large vault ===');
  spawnSync(NODE, [path.join(PFX, 'gen-large-vault.mjs'), VAULT, PFX], { cwd: PFX, stdio: 'pipe' });
  await restartBackend();
  await runJmx('A-large-baseline', 'karpathy-perf.jmx', 5, 12);
  await runJmx('A-large-high', 'karpathy-perf.jmx', 25, 12);
  for (const n of ['A-large-baseline', 'A-large-high']) {
    const jtl = path.join(RESULTS, n + '.jtl');
    let lines = 0;
    try { lines = fs.readFileSync(jtl, 'utf8').split('\n').filter(Boolean).length; } catch {}
    if (lines < 10) { log(`WARN ${n} tiny (${lines} lines) -> rerun once`); await runJmx(n, 'karpathy-perf.jmx', 25, 12); }
  }
  deleteMatching(VAULT, /^synthetic-.*\.md$/);
  log('restored small vault (deleted synthetic-*.md)');
  await restartBackend();

  log('===== MATRIX V2 COMPLETE ' + new Date().toISOString() + ' =====');
  if (backend) try { backend.kill('SIGTERM'); } catch {}
  if (mock) try { mock.kill('SIGTERM'); } catch {}
  LOG.end();
  process.exit(0);
}
main().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
