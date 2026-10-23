// T02923：修复工具 write_file 的收窄写面与护栏。
// ------------------------------------------------------------------
// 事故：修孤立页时 LLM 整页重写 entities/bill-system.md，静默把 updated 从 2025-07-20
// 改成伪造的 2026-08-14。本文件锁四件事：
//   A 已存在页面：frontmatter 以原页为准逐字保留，候选内容里的变更被忽略并写进 log.md；
//   B 正文护栏：删除标题/大段正文默认拒绝（落盘字节不变），allowRestructure 显式放行；
//   C 字段修改只能显式声明，updated 永远拒绝；
//   D stale 语义不被修复动作污染（修复前后 stale 列表一致）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';
import { createFixTools } from '../src/workflows/health-check-fix-workflow.js';
import {
  checkBodyDeletions,
  splitFrontmatter,
} from '../src/vault/page-write-guard.js';
import type { ToolDefinition } from '@wiki/harness';

const BILL_PAGE = `---
title: 票据系统
type: concept
updated: '2025-07-20'
tags: [bill]
---

## 系统概述

票据系统负责承兑、贴现与转贴现的全流程登记。

## 关键流程

出票、承兑、背书、贴现四个环节依次流转。

## 相关系统

与本页相关的上下游系统见 [[票据交易所]]。
`;

async function makeVault(): Promise<{ dir: string; vault: VaultService; write: ToolDefinition }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't02923-vault-'));
  const vault = new VaultService(dir);
  await vault.init();
  const write = createFixTools(vault).find((t) => t.name === 'write_file')!;
  return { dir, vault, write };
}

function callWrite(write: ToolDefinition, args: unknown) {
  return write.handler(args, {} as never) as Promise<{
    ok: boolean;
    frontmatterPreserved: boolean;
    frontmatterIgnored: Array<{ key: string; from: string | null; to: string | null }>;
    frontmatterApplied: Array<{ key: string; from: string | null; to: string | null }>;
  }>;
}

// 任何对 harnessConfig 的属性访问都抛错：healthCheck 若误入 LLM 配置立即红
function llmForbiddenConfig(): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('健康检查不应触碰 LLM 配置');
      },
    },
  ) as never;
}

describe('A · 已存在页面：frontmatter 逐字保留 + 忽略变更入审计', () => {
  let dir = '';
  let vault: VaultService;
  let write: ToolDefinition;

  beforeEach(async () => {
    ({ dir, vault, write } = await makeVault());
    await vault.writeFile('entities/bill-system.md', BILL_PAGE);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('整页重写且篡改 updated → 原 frontmatter 原样保留，旧值→新值写入 log.md', async () => {
    const headerBefore = splitFrontmatter(BILL_PAGE).header;
    const tampered = BILL_PAGE
      .replace("updated: '2025-07-20'", "updated: '2026-08-14'")
      .replace('## 相关系统', '## 与成都市对账\n\n见 [[huipiao-chengdui]]。\n\n## 相关系统');

    const result = await callWrite(write, { path: 'entities/bill-system.md', content: tampered });

    const after = await vault.readFile('entities/bill-system.md');
    expect(splitFrontmatter(after).header).toBe(headerBefore);
    expect(after).toContain("updated: '2025-07-20'");
    expect(after).not.toContain('2026-08-14');
    expect(after).toContain('[[huipiao-chengdui]]');
    expect(result.frontmatterPreserved).toBe(true);
    expect(result.frontmatterIgnored).toEqual([{ key: 'updated', from: '2025-07-20', to: '2026-08-14' }]);

    const log = await vault.readFile('log.md');
    expect(log).toContain('updated: 2025-07-20 → 2026-08-14');
  });

  it('候选内容不含 frontmatter（只给正文）也能正常写入，frontmatter 不变', async () => {
    const bodyOnly = splitFrontmatter(BILL_PAGE).body + '\n- 追加一行。\n';
    const result = await callWrite(write, { path: 'entities/bill-system.md', content: bodyOnly });

    const after = await vault.readFile('entities/bill-system.md');
    expect(splitFrontmatter(after).header).toBe(splitFrontmatter(BILL_PAGE).header);
    expect(after).toContain('追加一行');
    expect(result.frontmatterIgnored).toEqual([]);
  });

  it('修正断链所在行（单行改写）不被护栏误伤', async () => {
    const fixed = BILL_PAGE.replace('[[票据交易所]]', '[[上海票据交易所]]');
    await callWrite(write, { path: 'entities/bill-system.md', content: fixed });
    const after = await vault.readFile('entities/bill-system.md');
    expect(after).toContain('[[上海票据交易所]]');
    expect(after).not.toContain('[[票据交易所]]');
  });
});

describe('B · 正文删除护栏', () => {
  let dir = '';
  let vault: VaultService;
  let write: ToolDefinition;

  beforeEach(async () => {
    ({ dir, vault, write } = await makeVault());
    await vault.writeFile('entities/bill-system.md', BILL_PAGE);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('删掉原页三个小节 → 拒绝写入，落盘字节不变', async () => {
    const stripped = splitFrontmatter(BILL_PAGE).header + '\n';
    await expect(callWrite(write, { path: 'entities/bill-system.md', content: stripped }))
      .rejects.toThrow(/删除了原页 3 个标题/);

    expect(await vault.readFile('entities/bill-system.md')).toBe(BILL_PAGE);
  });

  it('无标题但大段清空（超阈值）同样拒绝', async () => {
    const flat = Array.from({ length: 20 }, (_, i) => `- 第 ${i + 1} 条记录`).join('\n') + '\n';
    await vault.writeFile('concepts/flat.md', `---\ntitle: 清单\n---\n\n${flat}`);
    const half = flat.split('\n').slice(0, 8).join('\n') + '\n';

    await expect(callWrite(write, { path: 'concepts/flat.md', content: half }))
      .rejects.toThrow(/删除了 12 行原有内容/);
    expect(await vault.readFile('concepts/flat.md')).toContain('第 20 条记录');
  });

  it('allowRestructure: true 显式声明 → 放行并记入 log.md', async () => {
    const stripped = splitFrontmatter(BILL_PAGE).body.split('## 关键流程')[0];
    const result = await callWrite(write, {
      path: 'entities/bill-system.md',
      content: stripped,
      allowRestructure: true,
    });
    expect(result.ok).toBe(true);
    const after = await vault.readFile('entities/bill-system.md');
    expect(after).not.toContain('## 关键流程');
    expect(await vault.readFile('log.md')).toContain('allowRestructure');
  });

  it('纯新增（含新增标题）不受护栏影响', () => {
    const body = splitFrontmatter(BILL_PAGE).body;
    const report = checkBodyDeletions(body, `${body}\n## 新章节\n\n新内容。\n`);
    expect(report.ok).toBe(true);
    expect(report.removedNonEmpty).toBe(0);
  });
});

describe('C · frontmatter 字段只能显式声明修改', () => {
  let dir = '';
  let vault: VaultService;
  let write: ToolDefinition;

  beforeEach(async () => {
    ({ dir, vault, write } = await makeVault());
    await vault.writeFile('entities/bill-system.md', BILL_PAGE);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('显式 frontmatter 参数生效，其余字段逐字保留，变更入 log.md', async () => {
    const body = splitFrontmatter(BILL_PAGE).body;
    const result = await callWrite(write, {
      path: 'entities/bill-system.md',
      content: body,
      frontmatter: { tags: ['bill', 'invoice'] },
    });

    const after = await vault.readFile('entities/bill-system.md');
    expect(after).toContain('tags: ["bill","invoice"]');
    expect(after).toContain("updated: '2025-07-20'");
    expect(after).toContain('title: 票据系统');
    expect(result.frontmatterApplied).toEqual([
      { key: 'tags', from: '["bill"]', to: '["bill","invoice"]' },
    ]);
    expect(await vault.readFile('log.md')).toContain('tags: ["bill"] → ["bill","invoice"]');
  });

  it('显式改 updated → 拒绝，文件不变', async () => {
    await expect(
      callWrite(write, {
        path: 'entities/bill-system.md',
        content: splitFrontmatter(BILL_PAGE).body,
        frontmatter: { updated: '2026-08-14' },
      }),
    ).rejects.toThrow(/updated 由知识库维护/);
    expect(await vault.readFile('entities/bill-system.md')).toBe(BILL_PAGE);
  });

  it('新建页面：内容原样落盘（无原页可保护）', async () => {
    const created = `---\ntitle: 新页\nupdated: '2026-10-23'\n---\n\n正文。\n`;
    const result = await callWrite(write, { path: 'entities/new-page.md', content: created });
    expect(result.frontmatterPreserved).toBe(false);
    expect(await vault.readFile('entities/new-page.md')).toBe(created);
  });
});

describe('D · stale 列表不被修复写入污染', () => {
  let dir = '';
  let vault: VaultService;
  let write: ToolDefinition;

  beforeEach(async () => {
    ({ dir, vault, write } = await makeVault());
    await vault.writeFile(
      'entities/old.md',
      "---\ntitle: 旧页\nupdated: '2020-01-01'\n---\n\n## 一\n\n旧内容。\n",
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('修复写入前后 stale 均包含该页，updated 原值不变', async () => {
    const before = await new HarnessAdapter(llmForbiddenConfig(), vault).healthCheck();
    expect(before.stale).toContain('entities/old.md');

    await callWrite(write, {
      path: 'entities/old.md',
      content:
        "---\ntitle: 旧页\nupdated: '2026-10-23'\n---\n\n## 一\n\n旧内容。\n\n见 [[旧页备份]]。\n",
    });
    expect(await vault.getPageUpdated('entities/old.md')).toBe('2020-01-01');

    const after = await new HarnessAdapter(llmForbiddenConfig(), vault).healthCheck();
    expect(after.stale).toContain('entities/old.md');
    expect(after.stale.length).toBe(before.stale.length);
  });
});
