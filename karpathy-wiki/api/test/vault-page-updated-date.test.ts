// T02955：getPageUpdated 必须认 js-yaml 解析出的 Date。
// ------------------------------------------------------------------
// 事故面：frontmatter 里未加引号的 ISO 时间戳会被 gray-matter/js-yaml 解析成 Date，
// 原实现 `typeof updated === 'string'` 直接判 null → harness checkStale 把 null 当「非过期」，
// stale 列表系统性漏报。本文件锁三件事：
//   A) 未加引号的两种时间戳（日期 / 完整 ISO）都会被转成字符串返回；
//   B) 带引号的字符串原样返回，非时间类型仍返回 null（不放松口径）；
//   C) 走真实 HarnessAdapter.healthCheck，未加引号的旧页确实进入 stale，新页不进入。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';

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

async function writePage(dir: string, rel: string, frontmatter: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `---\n${frontmatter}\n---\n\n## 正文\n\n内容。\n`, 'utf8');
}

describe('A · getPageUpdated 的 Date 形态', () => {
  let dir = '';
  let vault: VaultService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 't02955-vault-'));
    vault = new VaultService(dir);
    await vault.init();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('未加引号的完整 ISO 时间戳（Date）→ 返回 ISO 字符串', async () => {
    await writePage(dir, 'entities/plain-iso.md', 'title: 无引号\nupdated: 2020-01-02T03:04:05.000Z');
    expect(await vault.getPageUpdated('entities/plain-iso.md')).toBe('2020-01-02T03:04:05.000Z');
  });

  it('未加引号的纯日期（Date）→ 返回当日零点 ISO', async () => {
    await writePage(dir, 'entities/plain-date.md', 'title: 无引号日期\nupdated: 2020-01-02');
    expect(await vault.getPageUpdated('entities/plain-date.md')).toBe('2020-01-02T00:00:00.000Z');
  });

  it('带引号的字符串原样返回', async () => {
    await writePage(dir, 'entities/quoted.md', "title: 有引号\nupdated: '2020-01-02'");
    expect(await vault.getPageUpdated('entities/quoted.md')).toBe('2020-01-02');
  });

  it('非时间类型仍返回 null（口径不放松）', async () => {
    await writePage(dir, 'entities/number.md', 'title: 数字\nupdated: 123');
    await writePage(dir, 'entities/missing.md', 'title: 缺失');
    expect(await vault.getPageUpdated('entities/number.md')).toBeNull();
    expect(await vault.getPageUpdated('entities/missing.md')).toBeNull();
  });
});

describe('B · healthCheck stale 命中未加引号的旧页', () => {
  let dir = '';
  let vault: VaultService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 't02955-health-'));
    vault = new VaultService(dir);
    await vault.init();
    await writePage(dir, 'entities/old-plain-iso.md', 'title: 旧页 ISO\nupdated: 2020-01-02T03:04:05.000Z');
    await writePage(dir, 'entities/old-plain-date.md', 'title: 旧页 日期\nupdated: 2020-01-02');
    await writePage(dir, 'entities/old-quoted.md', "title: 旧页 引号\nupdated: '2020-01-02'");
    await writePage(dir, 'entities/fresh-plain.md', `title: 新页\nupdated: ${new Date().toISOString()}`);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('三种旧写法都进入 stale，今天更新的页面不进入', async () => {
    const report = await new HarnessAdapter(llmForbiddenConfig(), vault, 30).healthCheck();
    expect(report.stale).toContain('entities/old-plain-iso.md');
    expect(report.stale).toContain('entities/old-plain-date.md');
    expect(report.stale).toContain('entities/old-quoted.md');
    expect(report.stale).not.toContain('entities/fresh-plain.md');
  });
});
