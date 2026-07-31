// Vault 备份/恢复脚本
// 为什么需要：大 vault 测试会污染数据，需先备份后恢复
// 备份策略：硬链接复制（同盘符秒级完成），不复制 raw/ 子目录减少体积
import fs from 'node:fs';
import path from 'node:path';

const VAULT = process.argv[2] || '../karpathy-wiki/data/vault';
const ROOT = process.argv[3] || process.cwd();
const BACKUP_SUFFIX = process.argv[4] || '.backup-small';
const SKIP_DIRS = new Set(['raw']); // raw/ 数据量大且不参与链接图，备份时跳过

function copyDir(src, dst, skipDirs) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, skipDirs);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) rmDir(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function main() {
  const vaultPath = path.resolve(ROOT, VAULT);
  const backupPath = vaultPath + BACKUP_SUFFIX;

  if (!fs.existsSync(vaultPath)) {
    console.error(`[错误] vault 路径不存在: ${vaultPath}`);
    process.exit(1);
  }

  const isBackup = !fs.existsSync(backupPath);
  if (isBackup) {
    // 备份模式
    console.log(`[备份] ${vaultPath} → ${backupPath}`);
    copyDir(vaultPath, backupPath, SKIP_DIRS);
    console.log('[备份] 完成');
  } else {
    // 恢复模式：删除当前 vault 中除 raw 外的内容，从 backup 复制回来
    console.log(`[恢复] 从 ${backupPath} 恢复到 ${vaultPath}`);
    // 清空当前 vault（保留 raw 目录）
    for (const entry of fs.readdirSync(vaultPath, { withFileTypes: true })) {
      if (entry.name === 'raw' || entry.name === '.git' || entry.name === '.obsidian') continue;
      const p = path.join(vaultPath, entry.name);
      if (entry.isDirectory()) rmDir(p);
      else fs.unlinkSync(p);
    }
    // 从备份复制
    copyDir(backupPath, vaultPath, new Set());
    // 清理合成数据（synthetic- 前缀的文件）
    for (const entry of fs.readdirSync(vaultPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirFull = path.join(vaultPath, entry.name);
      for (const f of fs.readdirSync(dirFull)) {
        if (f.startsWith('synthetic-')) {
          fs.unlinkSync(path.join(dirFull, f));
        }
      }
    }
    // 删除备份
    rmDir(backupPath);
    console.log('[恢复] 完成，备份已清理');
  }
}

main();
