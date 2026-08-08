#!/usr/bin/env node
// ============================================================================
// 会话本地化迁移脚本（对应 SRS §2.3 本地优先模型 + D-1 决策）
// ----------------------------------------------------------------------------
// 用途：
//   自「会话不存服务端、仅客户端本地维护 + 按 ownerId 隔离」改造后，
//   服务端 data/threads/ 与 data/conversations/ 中的会话副本已不再是权威数据。
//   本脚本将这两处既有的服务端会话数据【备份】到带时间戳的
//   data/_migrated_local_<YYYYMMDD-HHmmss>/ 目录，并从活动路径移除，
//   使新的默认行为（threadsPersist/conversationsPersist 均为 false）干净生效。
//
// 安全原则（绝不硬删）：
//   - 仅做「备份 + 移除活动路径」，原始数据完整保留在备份目录，可随时回滚。
//   - 空目录或不存在的目录直接跳过，不报错。
//
// 用法：
//   node scripts/migrate-sessions-local.mjs                 # 执行迁移（备份并移除）
//   node scripts/migrate-sessions-local.mjs --dry-run      # 仅打印将要执行的操作，不改动
//   node scripts/migrate-sessions-local.mjs --data <path>  # 指定 data 目录（默认脚本上级 ../data）
// ============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dataArgIdx = args.indexOf('--data');
const dataOverride = dataArgIdx >= 0 ? args[dataArgIdx + 1] : undefined;

// data 目录：默认 scripts/../data（即 karpathy-wiki/data）
const dataDir = path.resolve(dataOverride ?? path.join(__dirname, '..', 'data'));

// 需要迁移的子目录（服务端会话落盘路径）
const TARGETS = ['threads', 'conversations'];

async function dirEntryCount(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries;
  } catch {
    return null; // 目录不存在
  }
}

// 递归复制目录（rename 跨设备/权限失败时回退）
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// 将 src 移动到 dest：优先 rename（同文件系统原子），失败回退 copy + rm
async function moveDir(src, dest) {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  } catch {
    await copyDir(src, dest);
    await removeDir(src);
  }
}

async function run() {
  console.log(`[migrate-sessions-local] data 目录: ${dataDir}`);
  console.log(`[migrate-sessions-local] 模式: ${dryRun ? 'DRY-RUN（不改动）' : '执行迁移'}`);

  // 校验 data 目录存在
  const dataStat = await dirEntryCount(dataDir);
  if (dataStat === null) {
    console.error(`[migrate-sessions-local] 错误：data 目录不存在: ${dataDir}`);
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupRoot = path.join(dataDir, `_migrated_local_${ts}`);

  let migratedAny = false;

  for (const name of TARGETS) {
    const src = path.join(dataDir, name);
    const entries = await dirEntryCount(src);
    if (entries === null) {
      console.log(`[migrate-sessions-local] 跳过 ${name}/：目录不存在`);
      continue;
    }
    // 过滤掉 . 开头的系统项，统计真实内容
    const real = entries.filter((e) => !e.name.startsWith('.'));
    if (real.length === 0) {
      console.log(`[migrate-sessions-local] 跳过 ${name}/：为空目录`);
      continue;
    }

    const dest = path.join(backupRoot, name);
    console.log(
      `[migrate-sessions-local] ${dryRun ? '将备份' : '备份'} ${name}/ （${real.length} 项） → ${dest}`,
    );
    if (!dryRun) {
      await moveDir(src, dest);
    }
    migratedAny = true;
  }

  if (!migratedAny) {
    console.log('[migrate-sessions-local] 无需迁移：所有目标目录均不存在或为空。');
  } else {
    console.log(`[migrate-sessions-local] 备份根目录: ${backupRoot}`);
    console.log('[migrate-sessions-local] 原始数据已完整保留在备份中，如需回滚可直接将备份内容移回 data/<name>/。');
  }
  console.log('[migrate-sessions-local] 完成。');
}

run().catch((err) => {
  console.error('[migrate-sessions-local] 失败：', err);
  process.exit(1);
});
