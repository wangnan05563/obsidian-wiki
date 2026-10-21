// T02773 清理响应字段契约：前后端「镜像类型不同源」导致的静默错配。
// ------------------------------------------------------------------
// 缺陷形态很特殊——功能是好的，显示是坏的：后端一直把释放量算对（审计日志里能看到），
// 但响应体里的键叫后端私有的 camelCase，前端读的是 snake_case，于是
// `data.total_freed_mb` 恒为 undefined，「释放 X MB」在任何一个清理目标下都不出现。
//
// 为什么编译器没拦住：api 与 frontend 的 tsconfig include 都只有各自的 src/**/*，
// 两侧 CleanupResult 是手工抄写的同名类型，字段名错配属于「跨服务契约」问题，
// tsc / vue-tsc 永远看不见。所以这一单补的是编译器缺的那一半——可执行契约：
//   A) 真发一次请求，锁住响应 JSON 的键名与数值（并锁审计与响应同源）；
//   B) 锁住「没删任何文件」「仅预览」两种情况下字段缺省（前端据此不渲染，而不是渲染 0）；
//   C) 逐字比对 api 与 frontend 两份 CleanupResult 的字段名集合，任何一侧改名都红；
//   D) 锁住前端确实读这个键、且存在性判断仍是 !== undefined
//      （0 是合法值，被 lint 的 S7735「auto-fix」改成 truthy 判断就会重新吃掉显示）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { preHandlerHookHandler } from 'fastify';
import { __resetActivitiesForTest, beginActivity } from '../src/activity.js';
import { registerCleanupRoute } from '../src/routes/cleanup.js';
import type { VaultService } from '../src/vault/vault-service.js';
import type { CleanupResult } from '../src/types.js';

const BYTES_PER_MB = 1024 * 1024;
/** 与 src/routes/cleanup.ts 的 bytesToMb 同口径（两位小数四舍五入） */
function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

function stubVault(vaultPath: string): VaultService {
  return { getVaultPath: () => vaultPath } as unknown as VaultService;
}

// 守卫放行：本文件测的是响应契约，不是 RBAC（后者由 user-admin-guard.test.ts 覆盖）
const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
function stubGuards() {
  return { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };
}

describe('T02773 清理响应体字段契约（真实请求）', () => {
  let tempRoot = '';
  let app: FastifyInstance | null = null;
  let logsDir = '';
  let harnessDir = '';
  let vaultPath = '';

  async function seed(): Promise<void> {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-contract-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    harnessDir = path.join(tempRoot, 'data', '.harness');
    logsDir = path.join(harnessDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(path.join(vaultPath, 'raw'), { recursive: true });

    app = Fastify();
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards());
    await app.ready();
  }

  /** 写一个「足够旧」的文件，保证落在 days 窗口外被清理 */
  async function writeOldLog(name: string, bytes: number): Promise<string> {
    const file = path.join(logsDir, name);
    await fs.writeFile(file, Buffer.alloc(bytes, 0x61));
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);
    return file;
  }

  async function post(payload: Record<string, unknown>): Promise<Response> {
    if (!app) throw new Error('路由未注册');
    return app.inject({ method: 'POST', url: '/api/cleanup', payload });
  }

  /** 审计日志最后一条（JSONL） */
  async function lastAudit(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(harnessDir, 'cleanup-audit.log'), 'utf8');
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    expect(lines.length, '清理必须留审计').toBeGreaterThan(0);
    return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
  }

  beforeEach(async () => {
    __resetActivitiesForTest();
    await seed();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('真实删除运行日志后，响应 JSON 用 snake_case 键回报释放量，且审计与响应同源', async () => {
    const big = await writeOldLog('big.log', 1.5 * BYTES_PER_MB);
    const small = await writeOldLog('small.log', 1234);

    const res = await post({ target: 'run_logs', days: 30, dry_run: false });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CleanupResult;

    // 键名：前端读的就是这个名字，写错一个字母这个断言就红
    expect(body.total_freed_mb, '响应缺少 total_freed_mb 字段').toBe(toMb(1.5 * BYTES_PER_MB + 1234));
    expect(Object.prototype.hasOwnProperty.call(body, 'total_freed_mb')).toBe(true);
    // 旧名不得以任何一种形态回流到响应体
    expect(JSON.stringify(body)).not.toContain('totalFreedMb');
    expect(JSON.stringify(body)).not.toContain('TotalFreedMb');

    // 本响应体约定 snake_case（dry_run 就是多词字段的既有写法）；
    // 出现 camelCase 多词键 = 又造了一个「前端取不到」的字段
    const camelKeys = Object.keys(body).filter((k) => /[a-z][A-Z]/.test(k));
    expect(camelKeys, `响应体出现 camelCase 多词键：${camelKeys.join(', ')}`).toEqual([]);

    // 数值口径：两个文件都真删了，释放量 = 两者字节和
    await expect(fs.stat(big)).rejects.toThrow();
    await expect(fs.stat(small)).rejects.toThrow();
    expect(body.count).toBe(2);
    expect(body.errors).toEqual([]);

    const audit = await lastAudit();
    expect(audit.total_freed_mb, '审计与响应给的释放量必须同一个数').toBe(body.total_freed_mb);
  });

  it('只删掉几 KB 时报 0.01 而不是 0（真删了就不能说「没释放」）', async () => {
    await writeOldLog('tiny.log', 1234);
    const res = await post({ target: 'run_logs', days: 30, dry_run: false });
    const body = res.json() as CleanupResult;

    expect(toMb(1234), '前提：2 位小数下这个字节数会舍入成 0').toBe(0);
    expect(body.total_freed_mb).toBe(0.01);
    // 审计必须写同一个数：界面显示 0.01 而审计记 0，事后回溯就对不上账
    const audit = await lastAudit();
    expect(audit.total_freed_mb).toBe(body.total_freed_mb);
  });

  it('一个文件都没删时字段整体缺省，让前端「不显示」而不是「显示 0 MB」', async () => {
    // 新日志（mtime=现在）落在 30 天窗口内 → 不该被清理
    await fs.writeFile(path.join(logsDir, 'fresh.log'), Buffer.alloc(1024), 'utf8');
    const res = await post({ target: 'run_logs', days: 30, dry_run: false });
    const body = res.json() as Record<string, unknown>;

    expect(body.count).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(body, 'total_freed_mb'), '没有释放量时不能带这个键').toBe(false);
  });

  it('仅预览模式不回报释放量（预览不删文件，报数会让人以为已经清理过了）', async () => {
    const keep = await writeOldLog('preview.log', 2 * BYTES_PER_MB);
    const res = await post({ target: 'run_logs', days: 30, dry_run: true });
    const body = res.json() as Record<string, unknown>;

    expect(body.dry_run).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, 'total_freed_mb')).toBe(false);
    expect(String((body.cleaned as string[])[0])).toContain('[预览]');
    await expect(fs.stat(keep)).resolves.toBeTruthy();
  });

  it('释放量口径覆盖全部 4 类目标：清编译缓存同样回报（与 run_logs 同一累加器）', async () => {
    const cacheFile = path.join(harnessDir, 'compile-cache.json');
    await fs.writeFile(cacheFile, JSON.stringify({ 'a.md': { hash: 'x' } }), 'utf8');
    const size = (await fs.stat(cacheFile)).size;

    const res = await post({ target: 'compile_cache', dry_run: false });
    const body = res.json() as CleanupResult;
    expect(body.total_freed_mb).toBe(Math.max(0.01, toMb(size)));
    await expect(fs.stat(cacheFile)).rejects.toThrow();
  });

  it('释放量只累加「删除成功」的字节：每处 += 都紧跟在 fs.unlink 之后', async () => {
    // 为什么用结构断言而不是造一个删不掉的文件：Windows 下 chmod 只读并不能稳定让
    // fs.unlink 失败（本用例实测就删掉了），拿不确定的失败去锁口径会变成随机红的测试。
    // 这里锁的是「释放量不会虚报」的成因——累加语句只能出现在 unlink 成功后，
    // unlink 抛错时走 catch 进 errors，字节数压根不会进 totalFreedBytes。
    const route = readFileSync(path.resolve(__dirname, '../src/routes/cleanup.ts'), 'utf8');
    const lines = route.split(/\r?\n/);
    const accumulators = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line.trim().startsWith('totalFreedBytes +='));
    expect(accumulators.length, '释放量累加点数量变化：清理分支被改写，请复核口径').toBe(4);
    for (const { idx } of accumulators) {
      const window = lines.slice(Math.max(0, idx - 2), idx).join('\n');
      expect(window, `第 ${idx + 1} 行的字节累加没有紧跟在 unlink 之后（会虚报释放量）`).toContain('await fs.unlink(');
    }
    // 预览分支不得累加：预览没删文件，报释放量会让人以为已经清理过
    const previewBranch = lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith('if (dryRun) {'));
    expect(previewBranch.length, 'dry_run 分支结构变化，请复核释放量口径').toBeGreaterThan(0);
  });

  it('被活跃任务硬拦时（409）不给出释放量：那次删除根本没执行', async () => {
    // run_state 属于会被拦的两类；这里只验证 409 响应体不带释放量
    const stateDir = path.join(harnessDir, 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'run-a.json'), '{}', 'utf8');
    const release = beginActivity('compile');
    try {
      const res = await post({ target: 'run_state', dry_run: false });
      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res.json())).not.toContain('total_freed_mb');
      await expect(fs.readFile(path.join(stateDir, 'run-a.json'), 'utf8')).resolves.toBe('{}');
    } finally {
      release();
    }
  });
});

describe('T02773 前后端镜像类型不再各写一份名字', () => {
  const apiTypesPath = path.resolve(__dirname, '../src/types.ts');
  const feTypesPath = path.resolve(__dirname, '../../frontend/src/types.ts');
  const feViewPath = path.resolve(__dirname, '../../frontend/src/views/Cleanup.vue');

  /** 取接口体内的字段名（先剥掉注释，避免把注释里的字段名当成声明） */
  function interfaceFields(file: string, name: string): string[] {
    expect(existsSync(file), `契约对端文件缺失：${file}`).toBe(true);
    const text = readFileSync(file, 'utf8');
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(code);
    expect(block, `${name} 接口未找到（${file}）`).toBeTruthy();
    return [...block![1].matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]);
  }

  it('api 与 frontend 的 CleanupResult 字段名集合逐字相同', () => {
    const apiFields = interfaceFields(apiTypesPath, 'CleanupResult');
    const feFields = interfaceFields(feTypesPath, 'CleanupResult');
    expect(apiFields).toContain('total_freed_mb');
    expect(feFields).toContain('total_freed_mb');
    // 排序比较：这一条就是「编译器查不出来的那一半」，任何一侧改名/加字段都会在这里红
    expect([...feFields].sort()).toEqual([...apiFields].sort());
  });

  it('两份清理类型里都不允许再出现后端私有 camelCase 的释放量字段', () => {
    for (const file of [apiTypesPath, feTypesPath]) {
      const code = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(code, `${file} 里出现了旧字段名`).not.toMatch(/\btotalFreedMb\b/);
    }
  });

  it('后端路由确实把释放量写到 snake_case 键上（不是只在类型里改个名）', () => {
    const route = readFileSync(path.resolve(__dirname, '../src/routes/cleanup.ts'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(route).toMatch(/result\.total_freed_mb\s*=\s*Math\.max\(MIN_REPORTED_MB,\s*bytesToMb\(totalFreedBytes\)\)/);
    expect(route).toMatch(/total_freed_mb:\s*result\.total_freed_mb\s*\?\?\s*0/);
  });

  it('前端读的是同一个键，且存在性判断没有被改成 truthy（0 MB 是合法值）', () => {
    const view = readFileSync(feViewPath, 'utf8');
    expect(view).toContain('data.total_freed_mb !== undefined');
    expect(view).toContain('total_freed_mb !== undefined');
    // toast + 结果区两处消费点都必须是 !== undefined
    const guards = view.match(/total_freed_mb !== undefined/g) ?? [];
    expect(guards.length, '前端存在性判断少于 2 处：toast 或结果区被改坏了').toBeGreaterThanOrEqual(2);
    expect(view).not.toMatch(/if\s*\(\s*[\w.[\]!]*total_freed_mb\s*\)/);
    expect(view).not.toContain('totalFreedMb');
  });
});
