import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// T02476（PRD X2 / X8）：加载态与空态方言收敛后的守护用例。
// 这一轮把「5 套加载态 + 死胡同空态」折成 StateBlock 一种实现；
// 本用例负责的是下一轮——任何人再写一个裸 `<div>加载中…</div>`、再用回旧方言类名、
// 或新加一个没有下一步的空态，都在这里失败，而不是等 UX 评审重新发现。

const SRC_DIR = path.resolve(__dirname, '../src');

function collectVueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectVueFiles(full));
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

const FILES = collectVueFiles(SRC_DIR);

/** 取一个 `<StateBlock …>` 用法的完整文本：自闭合到 `/>`，否则到配对 `</StateBlock>` */
function stateBlockUsages(text: string): string[] {
  const out: string[] = [];
  let i = text.indexOf('<StateBlock');
  while (i !== -1) {
    const selfClose = text.indexOf('/>', i);
    const pairClose = text.indexOf('</StateBlock>', i);
    const hasActionInside = pairClose !== -1 && (selfClose === -1 || pairClose < selfClose);
    const end = hasActionInside ? pairClose + '</StateBlock>'.length : selfClose + 2;
    if (end < 2) break;
    out.push(text.slice(i, end));
    i = text.indexOf('<StateBlock', end);
  }
  return out;
}

/** 只扫模板里真正给用户看的部分：class 属性、元素文本、placeholder */
function templateOnly(text: string): string {
  const start = text.indexOf('<template>');
  const end = text.lastIndexOf('</template>');
  return start === -1 || end === -1 ? '' : text.slice(start, end);
}

describe('T02476 加载态/空态方言守护（PRD X2 / X8）', () => {
  it('扫描到足量 .vue 文件（守护不是空跑）', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('StateBlock 用法一律声明 state，且只有四态', () => {
    const bad: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      for (const usage of stateBlockUsages(fs.readFileSync(file, 'utf8'))) {
        const m = usage.match(/\sstate="([^"]+)"/);
        if (!m || !['ready', 'loading', 'empty', 'error'].includes(m[1])) {
          bad.push(`${rel}: ${usage.slice(0, 60).replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(bad, `state 属性缺失或不在四态内：\n${bad.join('\n')}`).toEqual([]);
  });

  it('用了 StateBlock 的文件必须真的 import 它（漏 import 会让整页编译期才炸）', () => {
    const missing: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      if (stateBlockUsages(text).length === 0) continue;
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'components/StateBlock.vue') continue;
      if (!/import\s+StateBlock\s+from\s+'[^']*StateBlock\.vue'/.test(text)) {
        missing.push(rel);
      }
    }
    expect(missing, `以下文件使用 <StateBlock> 但未导入：${missing.join(', ')}`).toEqual([]);
  });

  it('loading 态必须写中文场景文案（不许退回裸「加载中…」）', () => {
    const bad: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'components/StateBlock.vue') continue;
      for (const usage of stateBlockUsages(fs.readFileSync(file, 'utf8'))) {
        if (!/\sstate="loading"/.test(usage)) continue;
        const m = usage.match(/loading-text="([^"]+)"/);
        if (!m || !m[1].startsWith('正在') || !m[1].endsWith('…') || m[1] === '加载中…') {
          bad.push(`${rel}: ${m ? m[1] : '(缺 loading-text)'}`);
        }
      }
    }
    expect(bad, `loading 文案不合口径（应为「正在………」）：\n${bad.join('\n')}`).toEqual([]);
  });

  it('empty 态要么给主按钮、要么显式标 compact，主从选择型空态进白名单', () => {
    // X8 口径：页面级空态是「一句现状 + 一句原因 + 一个主按钮」；
    // 行内二级空态（搜索无结果、章节面板、日志面板）用 compact 表明它不是断头路。
    const MASTER_DETAIL = ['尚未选择草稿', '尚未选择页面', '还没有打开页面'];
    const bad: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'components/StateBlock.vue') continue;
      for (const usage of stateBlockUsages(fs.readFileSync(file, 'utf8'))) {
        if (!/\sstate="empty"/.test(usage)) continue;
        const title = usage.match(/empty-title="([^"]+)"/)?.[1] ?? '';
        if (!title) {
          bad.push(`${rel}: 缺 empty-title`);
          continue;
        }
        const hasAction = usage.includes('<template #action>');
        const isCompact = /\scompact(\s|"|>)/.test(usage) || usage.includes(' compact ');
        if (!hasAction && !isCompact && !MASTER_DETAIL.includes(title)) {
          bad.push(`${rel}: 「${title}」既无主按钮也未标 compact`);
        }
      }
    }
    expect(bad, `空态不符合 X8 模板：\n${bad.join('\n')}`).toEqual([]);
  });

  it('被退役的加载/空态方言类名不得再出现在模板里', () => {
    const DEAD = [
      'section-loading',
      'section-empty',
      'content-loading',
      'content-empty',
      'tree-empty',
      'run-skeleton',
      'run-empty',
      'file-toc-loading',
      'progress-empty',
      'empty-dots',
      'search-loading',
      'search-empty',
      // T02719：桌面端最后三处自写空态/加载方言并入 StateBlock 后置之名下，
      // 否则「换个类名再写一个裸 div」就能绕过整条守护。
      'empty-state',
      'result-empty',
      'diff-loading',
    ];
    const hits: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      const tpl = templateOnly(fs.readFileSync(file, 'utf8'));
      for (const cls of DEAD) {
        if (new RegExp(`class="[^"]*\\b${cls}\\b`, '').test(tpl)) hits.push(`${rel}: ${cls}`);
      }
    }
    expect(hits, `旧方言类名复活：\n${hits.join('\n')}`).toEqual([]);
  });

  it('用户可见文案不用英文省略号（…而非...）', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      const tpl = templateOnly(fs.readFileSync(file, 'utf8'));
      tpl.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('<!--') || t.startsWith('//')) return;
        if (/placeholder="[^"]*\.\.\./.test(t) || />[^<>]*\.\.\.</.test(t)) {
          hits.push(`${rel}:${i + 1} ${t.slice(0, 70)}`);
        }
      });
    }
    expect(hits, `可见文案里还有 ASCII「...」：\n${hits.join('\n')}`).toEqual([]);
  });

  it('三态措辞单一来源：除 StateBlock 外不得再写死「加载中…」', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'components/StateBlock.vue') continue;
      const tpl = templateOnly(fs.readFileSync(file, 'utf8'));
      tpl.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('<!--')) return;
        if (t.includes('加载中…') || t.includes('加载中...')) hits.push(`${rel}:${i + 1} ${t.slice(0, 70)}`);
      });
    }
    expect(hits, `「加载中…」应从 StateBlock 出口，不要散落：\n${hits.join('\n')}`).toEqual([]);
  });

  it('主从选择型空态白名单只减不增，且每条都仍在被使用', () => {
    // 白名单是「既不给主按钮也不标 compact」的唯一合法出口，加一条就等于承认一处死胡同空态。
    // 因此这里同时钉两件事：条目数不许超过已立据的 3 条；每条必须真的还能在源码里找到对应 empty-title
    // （防止白名单变成越攒越多的历史垃圾槽）。
    const MASTER_DETAIL = ['尚未选择草稿', '尚未选择页面', '还没有打开页面'];
    expect(MASTER_DETAIL).toHaveLength(3);
    const titles = FILES.flatMap((file) =>
      stateBlockUsages(fs.readFileSync(file, 'utf8'))
        .filter((u) => /\sstate="empty"/.test(u))
        .map((u) => u.match(/empty-title="([^"]+)"/)?.[1] ?? ''),
    );
    for (const w of MASTER_DETAIL) {
      expect(titles, `白名单条目「${w}」已无人使用，应直接从白名单删除`).toContain(w);
    }
  });

  it('T02719 桌面端残留三处已并入 StateBlock（加载门 + 行内空态）', () => {
    const read = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

    // 1) 草稿列表：必须 loading → error → empty 三态齐备，否则首帧仍闪空态卡片
    const browse = read('views/Browse.vue');
    const panels = [
      { loading: 'draftsLoading', error: 'draftsError', empty: 'drafts.length === 0', loader: 'loadDrafts()', label: '正在加载草稿列表…' },
      { loading: 'tagsLoading', error: 'tagsError', empty: 'pendingTagPages.length === 0', loader: 'loadPendingTags()', label: '正在加载标签建议…' },
    ];
    for (const p of panels) {
      expect(browse, `${p.loading} 标志位缺失`).toContain(`const ${p.loading} = ref(false);`);
      expect(browse, `${p.error} 标志位缺失`).toContain(`const ${p.error} = ref('');`);
      expect(browse, `${p.loading} 没有对应的 loading 分支`).toContain(`v-if="${p.loading}" state="loading" loading-text="${p.label}"`);
      expect(browse, `${p.error} 没有对应的 error 分支`).toContain(`v-else-if="${p.error}"`);
      expect(browse, `${p.error} 的重试必须回到同一个加载函数`).toContain(`@retry="${p.loader}"`);
      // 空态只能在三态链的最后一支：写成独立 v-if 就会在接口返回前先渲染一次空态卡片
      expect(browse, `${p.empty} 的空态未接在三态链末尾`).toContain(`v-else-if="${p.empty}"`);
    }

    // 2) DataClean：5 处分区空态 + 差异抽屉 spinner 全走 StateBlock，页面级空态带主按钮
    const clean = read('views/DataClean.vue');
    expect(clean).toMatch(/import\s+StateBlock\s+from\s+'[^']*StateBlock\.vue'/);
    expect(clean).toContain('<StateBlock v-if="diffLoading" state="loading" loading-text="正在加载差异…" />');
    expect(clean).toContain('empty-title="还没有加载到页面"');
    // 5 处分区空态 + 差异抽屉加载态：并入后本页共 6 个 StateBlock 出口
    expect(stateBlockUsages(clean)).toHaveLength(6);
    expect(clean, '页面级空态必须给主按钮（X8）').toContain('<template #action>');

    // 3) Cleanup：卡片结果区小块空态并入行内 compact 形态
    const cleanup = read('views/Cleanup.vue');
    expect(cleanup).toMatch(/import\s+StateBlock\s+from\s+'[^']*StateBlock\.vue'/);
    expect(cleanup).toContain('empty-title="这一项没有需要清理的内容"');
  });

  it('反向用例：旧方言写法必须被抓到（守护不是空跑）', () => {
    const sample = `<template><div class="section-loading">加载中...</div></template>`;
    expect(/class="[^"]*\bsection-loading\b/.test(templateOnly(sample))).toBe(true);
    expect(/>[^<>]*\.\.\.</.test(templateOnly(sample))).toBe(true);
    expect(stateBlockUsages(`<template><StateBlock state="empty" empty-title="暂无内容" /></template>`)).toHaveLength(1);
  });
});
