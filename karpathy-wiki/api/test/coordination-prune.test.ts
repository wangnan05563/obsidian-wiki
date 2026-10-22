// T02896 崩溃残留协调文件的回收通道。
// ------------------------------------------------------------------
// T02817 把跨进程协调落在 cleanup.lock 与 activity/<pid>.json，读取侧已按
// 「pid 死亡 / 心跳超时 / 不可解析」过滤陈旧条目，但写侧没有回收：进程被强杀时
// finally 不执行，死 pid 的文件永久堆积。本文件锁三件事：
//   1) 回收只删死条目——崩溃模拟用**真子进程 kill**（与 cleanup-cross-process.test.ts
//      同口径：崩溃只能是真进程被杀，注入 isPidAlive 覆盖不到平台判定本身）；
//   2) 活条目（活 pid / 心跳新鲜 / 本进程自己的登记 / busy 标记）一根手指都不碰；
//   3) 启动接线真的发生了：index.ts 在 setCoordinationPaths 之后调用回收并落审计。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  activityDirIn,
  claimCleanupMarker,
  cleanupMarkerFileIn,
  COORDINATION_BASENAMES,
  DEFAULT_ACTIVITY_TTL_MS,
  DEFAULT_MARKER_MAX_AGE_MS,
  pruneStaleCoordinationFiles,
  releaseCleanupMarker,
  writeActivityRecord,
  type CoordinationPruneEntry,
} from '../src/cleanup-cross-process.js';

async function tmpHarness(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coord-prune-'));
}

// 存活脚本不含任何时长字面量：进程靠父进程持有的 stdin 管道活着，
// T02836 的等待守护只豁免 cleanup-cross-process.test.ts 一处，本文件不再新增口子。
function spawnLingerChild() {
  return spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
}

async function spawnThenKill(): Promise<number> {
  const child = spawnLingerChild();
  const pid = child.pid as number;
  await once(child, 'spawn');
  child.kill('SIGKILL');
  await once(child, 'exit');
  return pid;
}

async function spawnAlive(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawnLingerChild();
  await once(child, 'spawn');
  return {
    pid: child.pid as number,
    stop: async () => {
      child.kill('SIGKILL');
      await once(child, 'exit');
    },
  };
}

describe('T02896 回收只删死条目，活条目不动', () => {
  it('真子进程 kill 后：死 pid 的 activity 登记被删且审计点名，活 pid 登记仍在', async () => {
    const harness = await tmpHarness();
    const activityDir = activityDirIn(harness);
    const deadPid = await spawnThenKill();
    await writeActivityRecord(activityDir, { pid: deadPid, instance: 'crashed', compile: 1, query: 0, updatedAt: Date.now() });
    // 活条目同样是真子进程：两条判定都走真实 process.kill(pid,0)，不注入 isPidAlive
    const live = await spawnAlive();
    await writeActivityRecord(activityDir, { pid: live.pid, instance: 'live', compile: 0, query: 2, updatedAt: Date.now() });

    const pruned: CoordinationPruneEntry[] = [];
    const removed = await pruneStaleCoordinationFiles({
      markerFile: cleanupMarkerFileIn(harness),
      activityDir,
      onPruned: async (e): Promise<void> => {
        pruned.push(e);
      },
    });

    try {
      await expect(fs.access(path.join(activityDir, `${deadPid}.json`))).rejects.toThrow();
      await expect(fs.access(path.join(activityDir, `${live.pid}.json`))).resolves.toBeUndefined();
      expect(removed.map((e) => e.pid)).toContain(deadPid);
      expect(removed.map((e) => e.pid)).not.toContain(live.pid);
      expect(pruned.find((e) => e.pid === deadPid)).toMatchObject({ kind: 'activity', reason: 'pid_dead' });
    } finally {
      await live.stop();
      await fs.rm(harness, { recursive: true, force: true });
    }
  });

  it('心跳超时与不可解析的登记回收；.tmp 与本进程登记跳过', async () => {
    const harness = await tmpHarness();
    const activityDir = activityDirIn(harness);
    await writeActivityRecord(activityDir, { pid: 111, instance: 'stalled', compile: 0, query: 1, updatedAt: Date.now() - DEFAULT_ACTIVITY_TTL_MS - 5_000 });
    await fs.writeFile(path.join(activityDir, '222.json'), 'not-json{', 'utf8');
    await fs.writeFile(path.join(activityDir, '333.json.999.tmp'), '{}', 'utf8'); // 写方原子写中态，绝不能碰
    await writeActivityRecord(activityDir, { pid: process.pid, instance: 'self', compile: 0, query: 0, updatedAt: Date.now() });

    const removed = await pruneStaleCoordinationFiles({
      markerFile: cleanupMarkerFileIn(harness),
      activityDir,
      isPidAlive: () => true,
    });

    await expect(fs.access(path.join(activityDir, '111.json'))).rejects.toThrow();
    await expect(fs.access(path.join(activityDir, '222.json'))).rejects.toThrow();
    await expect(fs.access(path.join(activityDir, '333.json.999.tmp'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(activityDir, `${process.pid}.json`))).resolves.toBeUndefined();
    expect(removed.find((e) => e.pid === 111)).toMatchObject({ reason: 'too_old' });
    expect(removed.find((e) => e.pid === 222)).toMatchObject({ reason: 'unreadable' });
    await fs.rm(harness, { recursive: true, force: true });
  });
});

describe('T02896 cleanup.lock 的回收口径与 claim 同源', () => {
  it('busy 标记与本进程遗留标记不动；陈旧标记回收且 reason 同 readCleanupMarker', async () => {
    const harness = await tmpHarness();
    const lockFile = cleanupMarkerFileIn(harness);

    // busy：另一活实例刚抢的标记 → 不动
    await claimCleanupMarker({ lockFile, instance: 'live-other', target: 'run_state', selfPid: 424242, isPidAlive: () => true });
    let removed = await pruneStaleCoordinationFiles({
      markerFile: lockFile,
      activityDir: activityDirIn(harness),
      selfPid: 1,
      isPidAlive: () => true,
    });
    expect(removed).toEqual([]);
    await expect(fs.access(lockFile)).resolves.toBeUndefined();
    await releaseCleanupMarker(lockFile, 424242);

    // 陈旧：持标进程已死 → 回收，reason=pid_dead
    await claimCleanupMarker({ lockFile, instance: 'crashed', target: 'all', selfPid: 424243, isPidAlive: () => false });
    removed = await pruneStaleCoordinationFiles({
      markerFile: lockFile,
      activityDir: activityDirIn(harness),
      selfPid: 1,
      isPidAlive: () => false,
    });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ kind: 'cleanup_lock', pid: 424243, reason: 'pid_dead' });
    await expect(fs.access(lockFile)).rejects.toThrow();
    await releaseCleanupMarker(lockFile, 424243);

    // too_old：活 pid 但 startedAt 超过真删最长时长 → 回收（直接写标记文件，精确控制 startedAt）
    const tooOld = { pid: 424244, instance: 'slow', target: 'all', startedAt: Date.now() - (DEFAULT_MARKER_MAX_AGE_MS + 1000) };
    await fs.writeFile(lockFile, `${JSON.stringify(tooOld)}\n`, 'utf8');
    removed = await pruneStaleCoordinationFiles({
      markerFile: lockFile,
      activityDir: activityDirIn(harness),
      selfPid: 1,
      isPidAlive: () => true,
    });
    expect(removed[0]).toMatchObject({ kind: 'cleanup_lock', pid: 424244, reason: 'too_old' });

    // 本进程遗留（pid === selfPid）：readCleanupMarker 判 idle，绝不能自删
    await claimCleanupMarker({ lockFile, instance: 'self', target: 'all', selfPid: 1, isPidAlive: () => true });
    removed = await pruneStaleCoordinationFiles({
      markerFile: lockFile,
      activityDir: activityDirIn(harness),
      selfPid: 1,
      isPidAlive: () => true,
    });
    expect(removed).toEqual([]);
    await expect(fs.access(lockFile)).resolves.toBeUndefined();
    await releaseCleanupMarker(lockFile, 1);
    await fs.rm(harness, { recursive: true, force: true });
  });

  it('目录/文件尚不存在时回收为空操作不抛错', async () => {
    const harness = await tmpHarness();
    const removed = await pruneStaleCoordinationFiles({
      markerFile: cleanupMarkerFileIn(harness),
      activityDir: activityDirIn(harness),
    });
    expect(removed).toEqual([]);
    await fs.rm(harness, { recursive: true, force: true });
  });
});

describe('T02896 启动接线与审计口径锁', () => {
  const indexSrc = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
    'utf8',
  );

  it('index.ts 在 setCoordinationPaths 之后调用 pruneStaleCoordinationFiles 并落 coordination_stale_pruned 审计', () => {
    const wiring = indexSrc.indexOf('setCoordinationPaths(');
    const prune = indexSrc.indexOf('pruneStaleCoordinationFiles(');
    expect(wiring).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(wiring);
    expect(indexSrc).toContain('coordination_stale_pruned: true');
    // 审计必须与清理路由同一份日志、同一套滚动口径，不许另开一个文件
    expect(indexSrc).toContain('auditFileIn(harnessDirs[0])');
    expect(indexSrc).toContain('rotateAuditLog(coordinationAuditFile, AUDIT_ROTATE_BYTES)');
  });

  it('启动回收绝不能进清理删除面：cleanup-surface 对协调文件恒 null（接线锁回读）', async () => {
    const { deletedSurfaceOf } = await import('../src/utils/cleanup-surface.js');
    expect(COORDINATION_BASENAMES).toContain('cleanup.lock');
    expect(deletedSurfaceOf('C:/x/data/.harness/cleanup.lock')).toBeNull();
    expect(deletedSurfaceOf('C:/x/data/.harness/activity/123.json')).toBeNull();
  });
});
