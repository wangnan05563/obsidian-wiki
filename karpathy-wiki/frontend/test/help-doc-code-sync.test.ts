// T02784（PRD「与代码同源」推广）批次 1：帮助文档章节文案与单一来源模块的咬合测试。
// DOC_SECTIONS 已从 Help.vue 抽到 utils/helpDocSections（可 import），
// 本测试按章节 id 定位断言「文档含导出值」而不是「文档含我手写的那句」——
// 单一来源改名时文档自动跟随（实现取自导出），谁要是改回手抄字面量，
// 下一次来源变更时这里的断言就会红。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_SECTIONS } from '../src/utils/helpDocSections';
import { menuItems } from '../src/config/menu';
import { CONFIG_TAB_GROUPS } from '../src/utils/configTabs';
import { CLEANUP_CARDS, CLEANUP_PAGE_TITLE, buildPreviewBanner } from '../src/utils/cleanupPresentation';
import { ISSUE_CATEGORIES, PAGE_SCOPE_DIRS } from '../src/utils/dataCleanPresentation';
import { STEP_LABEL } from '../src/stores/compile';

const sectionOf = (id: string) => DOC_SECTIONS.find((s) => s.id === id);

function textOf(id: string): string {
  const s = sectionOf(id);
  expect(s, `帮助文档应有 #${id} 章节`).toBeTruthy();
  return JSON.stringify(s!);
}

describe('帮助文档与代码同源：菜单/页签实名（T02784）', () => {
  it('与菜单同名的章节，标题一律与 menuItems label 同词', () => {
    for (const s of DOC_SECTIONS) {
      const m = menuItems.find((item) => item.key === s.id);
      if (!m) continue;
      // T02475 特例：about 章标题是「实名 + 副题」（关于 / 版本信息），只要求实名开头
      if (s.id === 'about') {
        expect(s.title.startsWith(m.label), `章节 #about 标题应以菜单实名「${m.label}」开头`).toBe(true);
      } else {
        expect(s.title, `章节 #${s.id} 标题应与菜单实名同词`).toBe(m.label);
      }
    }
  });

  it('章节 id 全部可溯源：要么是菜单 key，要么是文档专有条目（quickstart / mcp）', () => {
    const known = new Set<string>([...menuItems.map((m) => m.key), 'quickstart', 'mcp']);
    for (const s of DOC_SECTIONS) {
      expect(known.has(s.id), `未知章节 id：${s.id}`).toBe(true);
    }
  });

  it('每个直达按钮的 view 是真实菜单、tab 是真实配置页签', () => {
    const tabNames = new Set(CONFIG_TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t.name)));
    for (const s of DOC_SECTIONS) {
      for (const b of s.blocks) {
        if (!b.action) continue;
        expect(
          menuItems.some((m) => m.key === b.action!.view),
          `#${s.id} 直达 view「${b.action.view}」应存在于菜单`,
        ).toBe(true);
        if (b.action.tab) {
          expect(
            tabNames.has(b.action.tab),
            `#${s.id} 直达 tab「${b.action.tab}」应存在于配置中心页签`,
          ).toBe(true);
        }
      }
    }
  });

  it('直达按钮文案与页签实名同源（AI 服务 / 系统配置）', () => {
    const labelOf = (name: string) =>
      CONFIG_TAB_GROUPS.flatMap((g) => g.tabs).find((t) => t.name === name)?.label;
    const quick = sectionOf('quickstart');
    const config = sectionOf('config');
    expect(quick?.blocks.find((b) => b.action)?.action?.label).toBe(`前往：配置中心 → ${labelOf('ai')}`);
    expect(config?.blocks.find((b) => b.action)?.action?.label).toBe(
      `前往：配置中心 → ${labelOf('config')}`,
    );
  });
});

describe('帮助文档与代码同源：cleanup 章节（T02784 批次 1）', () => {
  it('四类目标名/说明来自 CLEANUP_CARDS，章节标题与页面标题同词', () => {
    const raw = textOf('cleanup');
    expect(sectionOf('cleanup')?.title).toBe(CLEANUP_PAGE_TITLE);
    for (const c of CLEANUP_CARDS) {
      expect(raw).toContain(c.title);
      expect(raw).toContain(c.plain.slice(0, 12)); // 每类的「删的是什么」说明进入文档
    }
  });

  it('target/days 行不再手抄目标清单：由卡片定义拼接', () => {
    const targets = CLEANUP_CARDS.map((c) => c.target).join('/');
    const daysTargets = CLEANUP_CARDS.filter((c) => c.showDays).map((c) => c.target).join('/');
    expect(textOf('cleanup')).toContain(`清理目标：${targets}/all`);
    expect(textOf('cleanup')).toContain(`保留天数（仅 ${daysTargets} 使用）`);
  });

  it('「仅预览」关闭后果与页面红色横幅同源', () => {
    expect(textOf('cleanup')).toContain(buildPreviewBanner(false));
  });
});

describe('帮助文档与代码同源：dataclean 章节（T02784 批次 1）', () => {
  it('问题分类实名全部来自 ISSUE_CATEGORIES', () => {
    const raw = textOf('dataclean');
    for (const c of ISSUE_CATEGORIES) expect(raw).toContain(c.label);
  });

  it('批量动作实名与页面按钮同源（缺元信息 → 批量补元信息）', () => {
    const fill = ISSUE_CATEGORIES.find((c) => c.key === 'missingFrontmatter')!;
    const raw = textOf('dataclean');
    expect(raw).toContain(fill.action);
    expect(raw).toContain(`「${fill.label}」卡的「${fill.action}」`);
  });

  it('页面目录口径与 dataCleanPresentation.PAGE_SCOPE_DIRS 一致', () => {
    expect(textOf('dataclean')).toContain(`${PAGE_SCOPE_DIRS.join(' / ')} 六类页面`);
  });
});

describe('帮助文档与代码同源：progress 章节（T02784 批次 1）', () => {
  const chain = ['read_schema', 'extract', 'generate_page', 'update_index']
    .map((k) => STEP_LABEL[k] ?? k)
    .join(' → ');

  it('阶段链来自 compile store 的 STEP_LABEL，不再手抄阶段名', () => {
    expect(textOf('progress')).toContain(`编译进度：${chain} → 完成`);
  });

  it('快速开始里的阶段链与 progress 章同源', () => {
    expect(textOf('quickstart')).toContain(`观察「${chain}」各阶段进度`);
  });
});

describe('帮助文档与代码同源：手抄回归守护（T02784）', () => {
  // 上面的断言与实现同取一个导入，来源变更时文档自动跟随（这是「同源」的期望行为，
  // 对它变异不该红）。本用例守护的是真正的失败模式：有人把推导改回手抄字面量——
  // 眼下字面量恰好等于当前值、测试照样绿，等来源一变文档就漂。按行禁掉这些手抄形态。
  const modSrc = fs.readFileSync(path.resolve(__dirname, '../src/utils/helpDocSections.ts'), 'utf8');

  it('实名清单不得在文档模块里手抄（必须经单一来源导出拼接）', () => {
    expect(modSrc, '清理目标链被手抄回字面量').not.toContain('compile_cache/run_state/run_logs/raw_archive');
    expect(modSrc, '编译阶段链被手抄回字面量').not.toContain('读取结构规范 → 抽取要点');
    expect(modSrc, '问题分类实名被手抄回字面量').not.toContain('缺元信息、标题重复');
    const handCopiedTitles = [...modSrc.matchAll(/title: menuLabel\('(\w+)'\)/g)].map((m) => m[1]);
    // 每个经 menuLabel 提供的章节标题，都不允许同文件里再出现同名字面量标题
    for (const key of handCopiedTitles) {
      const label = menuItems.find((m) => m.key === key)?.label;
      if (!label) continue;
      expect(modSrc.includes(`title: '${label}'`), `章节 #${key} 的菜单实名「${label}」被手抄回字面量`).toBe(false);
    }
    expect(handCopiedTitles.length, 'menuLabel 提供的章节标题数应不少于 13').toBeGreaterThanOrEqual(13);
  });
});
