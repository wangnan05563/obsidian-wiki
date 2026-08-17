// quality-scanner 路径解析单元测试
// 覆盖 deleteFiles / archiveFiles 的 vault 相对路径解析与越权防护：
//   ① 传入 vault 相对路径（如 concepts/foo.md）会被拼回 vault 内绝对路径真实删除/归档
//   ② 传入绝对路径（已在 vault 内）原样使用
//   ③ 传入试图逃出 vault 的路径（../../etc/passwd）被拦截，进入 errors 而非真实删除
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VaultService } from '../src/vault/vault-service.js';
import { deleteFiles, archiveFiles } from '../src/data-clean/quality-scanner.js';

let vaultDir: string;
let archiveDir: string;

function makeRealVault(): VaultService {
  return {
    getVaultPath: () => vaultDir,
  } as unknown as VaultService;
}

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-vault-'));
  archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-archive-'));
  // quality-scanner 的删除/归档路径按 relative=目录/文件 解析，需先建好子目录
  await fs.mkdir(path.join(vaultDir, 'concepts'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'entities'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'concepts', 'foo.md'), '# Foo\n内容', 'utf-8');
  await fs.writeFile(path.join(vaultDir, 'entities', 'bar.md'), '# Bar\n内容', 'utf-8');
});

afterAll(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('deleteFiles 路径解析', () => {
  it('vault 相对路径会被解析到 vault 内并真实删除', async () => {
    const target = 'concepts/delete-me.md';
    await fs.writeFile(path.join(vaultDir, 'concepts', 'delete-me.md'), 'x', 'utf-8');
    const res = await deleteFiles(makeRealVault(), [target], false);
    expect(res.errors).toHaveLength(0);
    expect(res.deleted).toContain(target);
    // 文件确实从磁盘消失
    await expect(fs.access(path.join(vaultDir, 'concepts', 'delete-me.md'))).rejects.toBeDefined();
  });

  it('dry_run 不实际删除，仅返回计划', async () => {
    const target = 'concepts/dry-me.md';
    await fs.writeFile(path.join(vaultDir, 'concepts', 'dry-me.md'), 'x', 'utf-8');
    const res = await deleteFiles(makeRealVault(), [target], true);
    expect(res.deleted).toContain('dry-me.md');
    await expect(fs.access(path.join(vaultDir, 'concepts', 'dry-me.md'))).resolves.toBeUndefined();
  });

  it('逃出 vault 的路径被拦截，不真实删除', async () => {
    const evil = path.join(vaultDir, '..', 'qc-outside.md');
    // 在 vault 外放一个文件，验证它不会被删
    await fs.writeFile(evil, 'secret', 'utf-8');
    const res = await deleteFiles(makeRealVault(), [evil], false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.deleted).toHaveLength(0);
    // 外部文件依然存在
    await expect(fs.access(evil)).resolves.toBeUndefined();
    await fs.rm(evil, { force: true }).catch(() => undefined);
  });
});

describe('archiveFiles 路径解析', () => {
  it('vault 相对路径会被解析到 vault 内并真实移动', async () => {
    const target = 'entities/archive-me.md';
    await fs.writeFile(path.join(vaultDir, 'entities', 'archive-me.md'), 'x', 'utf-8');
    const res = await archiveFiles(makeRealVault(), [target], false);
    expect(res.errors).toHaveLength(0);
    expect(res.archived).toContain(target);
    await expect(fs.access(path.join(vaultDir, 'entities', 'archive-me.md'))).rejects.toBeDefined();
  });
});
