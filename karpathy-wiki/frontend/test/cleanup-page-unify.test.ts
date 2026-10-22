// 缓存与日志清理页改造单测（T02470 / PRD §12 S1~S5）
// ------------------------------------------------------------------
// 这一页的风险点是「用户以为在预览，其实删了」，所以开关与按钮态的分支必须穷举：
// 页级开关（开/关）× 状态（未加载 / 有可清对象 / 为 0）× 4 类卡片。
// S3 的「技术词不再出现在主描述里」也用断言锁住——这类回退最容易在一次文案改动里悄悄发生。
import { describe, it, expect } from 'vitest';
import {
  CLEANUP_CARDS,
  CLEANUP_PAGE_TIP,
  CLEANUP_PAGE_TITLE,
  buildPreviewBanner,
  cardOf,
  cleanupButtonState,
  confirmText,
  modeChip,
  previewSwitchHint,
} from '../src/utils/cleanupPresentation';
import type { CleanupStorageStatus } from '../src/types';
import { menuItems } from '../src/config/menu';

function statusOf(over: Partial<CleanupStorageStatus> = {}): CleanupStorageStatus {
  return {
    // T02655：默认「无活跃任务」；被拦分支的用例在 cleanup-active-guard.test.ts 里显式覆盖
    active: { compile: 0, query: 0, blockedTargets: [], blockedReasons: [] },
    compileCache: {
      exists: true,
      sizeMb: 1.2,
      entryCount: 42,
      // T02887：四类目标都带真实目录清单（卡计数 = 各目录计数之和）
      dirs: [{ path: 'D:/wiki/karpathy-wiki/data/.harness', fileCount: 42, sizeMb: 1.2, role: 'canonical', exists: true }],
    },
    runState: {
      fileCount: 3,
      sizeMb: 0.1,
      oldest: '2026-09-01',
      // T02808：合并计数与目录清单必须成对给出（卡计数 = 各目录计数之和）
      dirs: [
        { path: 'D:/wiki/karpathy-wiki/data/.harness/state', fileCount: 1, sizeMb: 0.05, role: 'canonical', exists: true },
        { path: 'D:/wiki/karpathy-wiki/api/.harness/state', fileCount: 2, sizeMb: 0.05, role: 'legacy', exists: true },
      ],
    },
    runLogs: {
      fileCount: 12,
      sizeMb: 4.5,
      oldest: '2026-08-11',
      dirs: [{ path: 'D:/wiki/karpathy-wiki/data/.harness/logs', fileCount: 12, sizeMb: 4.5, role: 'canonical', exists: true }],
    },
    rawArchive: {
      fileCount: 7,
      sizeMb: 2.2,
      oldest: '2026-07-30',
      dirs: [{ path: 'D:/wiki/karpathy-wiki/data/vault/raw', fileCount: 7, sizeMb: 2.2, role: 'canonical', exists: true }],
    },
    ...over,
  };
}

describe('S5 命名统一：菜单名 = 页标题 = 一句话职责', () => {
  it('页标题与菜单 label 完全一致（术语单一来源）', () => {
    const menu = menuItems.find((m) => m.key === 'cleanup');
    expect(menu?.label).toBe(CLEANUP_PAGE_TITLE);
    expect(CLEANUP_PAGE_TITLE).toBe('缓存与日志清理');
  });

  it('不再叫「系统清理」——与「数据清洗」职责不可辨的原问题（S5）', () => {
    expect(CLEANUP_PAGE_TITLE).not.toContain('系统清理');
  });

  it('页头一句话明确「不改动知识库内容」，与数据清洗划清边界', () => {
    expect(CLEANUP_PAGE_TIP).toContain('只删临时文件');
    expect(CLEANUP_PAGE_TIP).toContain('不改动知识库内容');
  });
});

describe('S2 预览开关收敛为页级单开关', () => {
  it('默认（预览开着）不出现红色横幅，卡片也不会自称「真实删除」', () => {
    expect(buildPreviewBanner(true)).toBe('');
    expect(modeChip(true)).toEqual({ label: '当前：仅预览', danger: false });
  });

  it('关闭预览后横幅讲清「4 个按钮都会真实删除且不可撤销」', () => {
    const banner = buildPreviewBanner(false);
    expect(banner).toContain('真实删除');
    expect(banner).toContain('不可撤销');
    expect(modeChip(false).danger).toBe(true);
  });

  it('开关旁一句话解释开与关各自的后果，不靠用户猜', () => {
    expect(previewSwitchHint(true)).toContain('不会真删');
    expect(previewSwitchHint(false)).toContain('二次确认');
  });

  it('卡片元数据里没有 per-card 开关字段（dry_run 只能来自页级开关）', () => {
    for (const card of CLEANUP_CARDS) {
      expect((card as Record<string, unknown>).dry_run).toBeUndefined();
      expect(card.target).not.toBe('all');
    }
    expect(CLEANUP_CARDS).toHaveLength(4);
  });

  it('真实删除模式下的二次确认话术仍要求确认（S6 原有保护不回退）', () => {
    const text = confirmText('运行日志');
    expect(text).toContain('确认清理运行日志');
    expect(text).toContain('不可撤销');
  });
});

describe('S4 无可清对象时按钮转「无需清理」禁用态', () => {
  it('计数为 0 → 禁用 + 说明原因，不再给一个点了没反应的按钮', () => {
    const empty = statusOf({
      compileCache: { exists: false, sizeMb: 0, entryCount: 0, dirs: [] },
      runState: { fileCount: 0, sizeMb: 0, oldest: null, dirs: [] },
    });
    const cache = cleanupButtonState('compileCache', empty, true);
    expect(cache.disabled).toBe(true);
    expect(cache.label).toBe('无需清理');
    expect(cache.tip).toContain('没东西可清');
    const state = cleanupButtonState('runState', empty, false);
    expect(state.disabled).toBe(true);
    expect(state.tip).toContain('为 0');
  });

  it('有可清对象 → 按预览/真实删除给不同标签与提示', () => {
    const s = statusOf();
    expect(cleanupButtonState('runLogs', s, true)).toMatchObject({
      disabled: false,
      label: '清理运行日志',
      tip: '只列出会删哪些文件，不实际删除',
    });
    const real = cleanupButtonState('rawArchive', s, false);
    expect(real.disabled).toBe(false);
    expect(real.tip).toContain('将真实删除原始资料');
    expect(real.tip).toContain('二次确认');
  });

  it('状态还没加载回来时不置灰（避免刷新瞬间把按钮全禁用）', () => {
    for (const card of CLEANUP_CARDS) {
      expect(cleanupButtonState(card.key, null, true).disabled).toBe(false);
    }
  });
});

describe('S3 措辞：主界面讲人话，技术细节只在「高级」里', () => {
  const JARGON = ['.harness', 'SHA-256', 'JSONL', 'resume', 'input-*.md', 'compile-cache'];

  it('卡片主描述不含内部路径与实现词', () => {
    for (const card of CLEANUP_CARDS) {
      const visible = `${card.plain} ${card.consequence}`;
      for (const word of JARGON) {
        expect(visible, `${card.title} 的描述里出现了 ${word}`).not.toContain(word);
      }
      expect(card.plain.length).toBeGreaterThan(6);
      // 用户需要「删了有什么后果」才敢点，光说是什么不够
      expect(card.consequence).toMatch(/清掉后|删掉后|只删/);
    }
  });

  it('techPath 保留为「扫描口径」说明；实际位置改由 status 各卡 dirs 提供（T02887）', () => {
    expect(CLEANUP_CARDS.map((c) => c.techPath)).toEqual([
      '.harness/compile-cache.json',
      '.harness/state/*.json',
      '.harness/logs/*.log',
      'vault/raw/input-*.md',
    ]);
    expect(CLEANUP_CARDS.every((c) => c.techNote.length > 0)).toBe(true);
  });

  it('cardOf 按 key 取元数据，未知 key 直接抛错而不是静默兜底', () => {
    expect(cardOf('runLogs').target).toBe('run_logs');
    expect(cardOf('compileCache').showDays).toBe(false);
    expect(() => cardOf('nope' as never)).toThrow(/unknown cleanup card/);
  });

  it('只有按时间清理的两类暴露保留天数', () => {
    expect(CLEANUP_CARDS.filter((c) => c.showDays).map((c) => c.key)).toEqual(['runLogs', 'rawArchive']);
  });
});
