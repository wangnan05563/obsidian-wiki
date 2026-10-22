// T02888：batch-fix 快照与 cleanup-audit.log 的清理归属收口。
// ------------------------------------------------------------------
// 本机取证：`data/.harness/` 下有两样清理面不认识的产物——
//   1) `batch-fix/`：批量修复快照，回收只发生在**下一次起跑时**（TTL 7 天），
//      用过一次就不再用的用户，终态快照永远留在盘上，清理页看不到也删不掉；
//   2) `cleanup-audit.log`：审计台账，永久追加、无上限无轮转。
// 裁决（选「启动即回收」路线，不设第五类清理目标）：
//   快照是「断点续传/恢复」语义（与 run-state 同族），删掉的代价=可恢复作业丢失，
//   与运行状态卡几乎重复；TTL 是特性自有的保留策略，归属特性自身——
//   管理器构造（进程启动）时按同一 TTL 回收，不再依赖用户再次使用该功能。
//   审计是台账不是垃圾，不并入删除面，改按大小滚动（保留一代 .1 归档）。
// 本文件锁四件事：
//   A) 启动即回收：过期快照/过期临时文件消失，未过期快照与 stats.json 保留；
//   B) 清理 POST 真删四类目标时**不会**误删 batch-fix 快照（不在删除面内的因果锁）；
//      反证形态：status 响应体不含 batch-fix 类别（「没实现」必须是显式取舍而非漏报）；
//   C) 审计滚动：达到阈值改名 .1（顶掉上一代），新写入继续追加主文件；
//   D) 删除面判定：batch-fix 快照与审计日志（含 .1）都判 null——
//      「不会误删」由判定函数锁住，而不是靠_pattern 恰好不匹配。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { BatchFixJobManager } from '../src/workflows/batch-fix-job.js';
import { registerCleanupRoute, rotateAuditLog } from '../src/routes/cleanup.js';
import { deletedSurfaceOf } from '../src/utils/cleanup-surface.js';
import type { EngineAdapter } from '../src/types.js';
import type { VaultService } from '../src/vault/vault-service.js';

const stubAdapter = {} as EngineAdapter;
const stubVault = (vaultPath: string): VaultService => ({ getVaultPath: () => vaultPath }) as unknown as VaultService;
const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
const stubGuards = () => ({ enabled: false, requireAuth: passThrough, requireAdmin: passThrough });

// 比 TTL（7 天）再老一天，避免用例在边界值附近抖动
async function backdate(file: string): Promise<void> {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(file, old, old);
}

async function writeSnapshot(dir: string, jobId: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ jobId, status: 'completed', total: 1, doneCount: 1 }),
    'utf8',
  );
  return file;
}

describe('T02888 batch-fix 快照：启动即回收', () => {
  let tempRoot = '';
  let jobsDir = '';

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('构造管理器（进程启动）就回收过期快照与过期临时文件，不依赖下一次起跑（本单的原始缺口）', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-batch-fix-retention-'));
    jobsDir = path.join(tempRoot, 'batch-fix');

    const expired = await writeSnapshot(jobsDir, 'expired-job');
    await backdate(expired);
    const fresh = await writeSnapshot(jobsDir, 'fresh-job');
    const expiredTmp = path.join(jobsDir, `old.123.tmp`);
    await fs.writeFile(expiredTmp, 'partial', 'utf8');
    await backdate(expiredTmp);
    const freshTmp = path.join(jobsDir, `new.456.tmp`);
    await fs.writeFile(freshTmp, 'partial', 'utf8');

    const manager = new BatchFixJobManager(jobsDir, stubAdapter);
    await manager.startupPrune;

    await expect(fs.stat(expired)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
    await expect(fs.stat(path.join(jobsDir, 'stats.json'))).rejects.toThrow(); // 没写过就不该凭空造出来
    await expect(fs.stat(expiredTmp)).rejects.toThrow();
    await expect(fs.stat(freshTmp)).resolves.toBeTruthy();
  });

  it('stats.json 与未过期快照在重复回收下原样保留（幂等，回收不碰台账样本）', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-batch-fix-retention-'));
    jobsDir = path.join(tempRoot, 'batch-fix');
    await writeSnapshot(jobsDir, 'fresh-job');
    await fs.writeFile(path.join(jobsDir, 'stats.json'), JSON.stringify({ samples: 3, totalMs: 1000, avgMs: 333 }), 'utf8');

    const manager = new BatchFixJobManager(jobsDir, stubAdapter);
    await manager.startupPrune;
    await manager.pruneOldSnapshots();

    const names = (await fs.readdir(jobsDir)).sort();
    expect(names).toEqual(['fresh-job.json', 'stats.json']);
  });
});

describe('T02888 batch-fix 快照：不在清理删除面内（显式取舍的因果锁）', () => {
  let tempRoot = '';
  let vaultPath = '';
  let jobsDir = '';
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('POST /api/cleanup 真删全部四类目标后，batch-fix 快照原样保留', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-surface-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    jobsDir = path.join(tempRoot, 'data', '.harness', 'batch-fix');
    const snapshot = await writeSnapshot(jobsDir, 'keep-me');

    app = Fastify();
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards());
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'all', dry_run: false } });
    expect(res.statusCode).toBe(200);

    await expect(fs.stat(snapshot)).resolves.toBeTruthy();
  });

  it('反证形态：status 响应体没有 batch-fix 类别——「不实现」是登记过的取舍，不是漏报', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-surface-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');

    app = Fastify();
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards());
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/api/cleanup/status' })).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['active', 'compileCache', 'rawArchive', 'runLogs', 'runState']);
  });

  it('删除面判定：batch-fix 快照、审计日志（含 .1 归档）都判 null', () => {
    expect(deletedSurfaceOf(path.join('D:', 'wiki', 'data', '.harness', 'batch-fix', 'some-job.json'))).toBeNull();
    expect(deletedSurfaceOf(path.join('D:', 'wiki', 'data', '.harness', 'cleanup-audit.log'))).toBeNull();
    expect(deletedSurfaceOf(path.join('D:', 'wiki', 'data', '.harness', 'cleanup-audit.log.1'))).toBeNull();
  });
});

describe('T02888 cleanup-audit.log：按大小滚动', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('达到阈值：主文件改名 .1（顶掉上一代归档），随后写入继续追加新主文件', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-audit-rotate-'));
    const auditLog = path.join(tempRoot, 'cleanup-audit.log');

    // 第一代：写满 → 滚动成 .1
    await fs.writeFile(auditLog, 'x'.repeat(200), 'utf8');
    await rotateAuditLog(auditLog, 100);
    await expect(fs.stat(auditLog)).rejects.toThrow();
    await expect(fs.readFile(auditLog + '.1', 'utf8')).resolves.toBe('x'.repeat(200));

    // 第二代：新主文件再写满 → .1 被顶掉（只保留一代，不无限攒归档）
    await fs.writeFile(auditLog, 'y'.repeat(150), 'utf8');
    await rotateAuditLog(auditLog, 100);
    await expect(fs.readFile(auditLog + '.1', 'utf8')).resolves.toBe('y'.repeat(150));
  });

  it('未达阈值：原样保留（滚动不能把还小的日志也搬走）', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-audit-rotate-'));
    const auditLog = path.join(tempRoot, 'cleanup-audit.log');
    await fs.writeFile(auditLog, '{"ts":1}\n', 'utf8');
    await rotateAuditLog(auditLog, 1024 * 1024);
    await expect(fs.readFile(auditLog, 'utf8')).resolves.toBe('{"ts":1}\n');
    await expect(fs.stat(auditLog + '.1')).rejects.toThrow();
  });

  it('主文件不存在时不报错（首次清理前目录里还没有审计文件）', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-audit-rotate-'));
    await expect(rotateAuditLog(path.join(tempRoot, 'cleanup-audit.log'), 100)).resolves.toBeUndefined();
  });
});
