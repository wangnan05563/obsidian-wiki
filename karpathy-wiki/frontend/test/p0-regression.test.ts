// T02478（wiki三期 / M10 10.1）P0 需求回归门禁
// ------------------------------------------------------------------
// 这一份不是「把各单测重抄一遍」，而是 14 项 P0（对应 17 条需求编号 REQ-001/003/007/008/011/
// 014/018/019/025/026/028/030/032/033/035/037/038）的**跨视图 / 跨端不变量**：
// 单项功能测试锁得住一个函数，锁不住「改了 A 页把 B 页口径带歪」「重构时把主 CTA 的文字又删掉」
// 这类三期评审反复出现的回归。断言分两类：
//   ① 纯函数行为（dirBarWidth / graphTopN / healthList / configEffects / tunnelDiagnostics / useHashView）
//      —— 直接调用，失败即真实行为变了；
//   ② 源码不变量（读 .vue/.ts 原文正则断言）—— 用于「必须在界面上看得见」这类无法用函数表达的要求
//      （例如 X7 主 CTA 必须带文字、N2 侧栏必须有「还有 N 项」提示）。
// ②类刻意断言「特征必须存在」而不是行号或整段文本，避免与实现细节绑死（教训见 T02293）。
//
// 各 P0 的专项单测（graph-top-n / health-list-governance / help-doc-path-align / tunnel-self-check-ui /
// terminology-single-source / dataclean-scope-and-table / useHashView 等）仍然有效，本文件是其上的总闸门；
// 逐条验收标准与实测证据见 docs/wiki三期/04-P0需求回归测试报告.md。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { menuItems, menuGroupDefs, groupMenuItems } from '../src/config/menu';
import { DOC_SECTIONS } from '../src/utils/helpDocSections';
import { parseHashView, formatViewHash } from '../src/composables/useHashView';
import { dirBarWidth } from '../src/utils/dirBar';
import { topNGraphData } from '../src/utils/graphTopN';
import {
  buildIssueRows,
  filterRows,
  takeVisible,
  splitByActionable,
  groupRowsByDir,
  type IssueRow,
} from '../src/utils/healthList';
import {
  badgeFor,
  indexEffectItems,
  restartItemsOfTab,
  type ConfigEffectItem,
} from '../src/utils/configEffects';
import {
  CONFIG_TAB_GROUPS,
  allConfigTabs,
  configTabNames,
  isTabLocked,
  resolveInitialTab,
  LOCKED_TAB_HINT,
} from '../src/utils/configTabs';
import {
  prereqTone,
  summarizePrereq,
  classifyStartError,
  adviceFor,
  buildStartErrorView,
  focusTarget,
  formatErrorAgo,
} from '../src/utils/tunnelDiagnostics';
import { PAGE_SCOPE_DIRS, PAGE_TOTAL_HINT } from '../src/utils/dataCleanPresentation';
import { CLEANUP_PAGE_TITLE } from '../src/utils/cleanupPresentation';

const SRC = path.resolve(__dirname, '..', 'src');
const REPO = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  const file = path.join(SRC, rel);
  expect(fs.existsSync(file), `源码缺失：${rel}`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** 跨端读源码（frontend ↔ api 同仓）：P0 里 several 条本质是前后端契约，必须一起锁 */
function readApi(rel: string): string {
  const file = path.join(REPO, 'api', rel);
  expect(fs.existsSync(file), `后端源码缺失：api/${rel}`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** views/ 或 components/ 下的全部 .vue（移动端另一套实现，桌面 P0 口径不含它，见 T02706） */
function vueFiles(dir: 'views' | 'components'): string[] {
  const base = path.join(SRC, dir);
  return fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.vue'))
    .map((f) => path.join(base, f));
}

// X7 扫描用：按钮体内可见文字（{{ 插值 }} 算动态文字，与人工走查口径一致）
const BUTTON_RE = /<(el-button|button)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const MUSTACHE_RE = /\{\{[\s\S]*?\}\}/g;
const TAG_RE = /<[^>]+>/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

function visibleText(inner: string): string {
  return inner.replace(MUSTACHE_RE, 'x').replace(TAG_RE, '').replace(COMMENT_RE, '').trim();
}

/** 剥掉注释后的源码：负向断言（「不该再出现 X」）必须用它，否则会被解释性注释里的历史提法误判 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(COMMENT_RE, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|=?\s*\/\/)/.test(l))
    .join('\n');
}

function primaryButtonsWithoutText(file: string): Array<{ line: number; attrs: string }> {
  const src = fs.readFileSync(file, 'utf8');
  const hits: Array<{ line: number; attrs: string }> = [];
  for (const m of src.matchAll(BUTTON_RE)) {
    const attrs = m[2] ?? '';
    const inner = m[3] ?? '';
    if (!attrs.includes('type="primary"')) continue;
    if (visibleText(inner)) continue;
    hits.push({
      line: src.slice(0, m.index ?? 0).split('\n').length,
      attrs: attrs.replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }
  return hits;
}

describe('P0-1 [N2/REQ-001] 侧栏分组与 15 项全项可达', () => {
  it('菜单单一来源：15 项 / key 唯一 / 分组渲染不丢项', () => {
    expect(menuItems).toHaveLength(15);
    expect(new Set(menuItems.map((m) => m.key)).size).toBe(15);
    const groups = groupMenuItems(menuItems, menuGroupDefs);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(15);
  });

  it('溢出时有「还有 N 项」下行提示与滚动动作，不靠用户自己发现滚动条', () => {
    const app = readSrc('App.vue');
    expect(app).toMatch(/const hiddenCount = ref\(0\)/);
    expect(app).toMatch(/还有 \{\{ hiddenCount \}\} 项/);
    expect(app).toMatch(/function scrollMenuDown/);
    // 提示条必须可点，也可键盘触发（无障碍）
    expect(app).toMatch(/@click="scrollMenuDown"/);
    expect(app).toMatch(/@keydown\.enter\.prevent="scrollMenuDown"/);
  });

  it('选中态用 aria-current="page"，读屏能说出「当前页」', () => {
    const app = readSrc('App.vue');
    const count = (app.match(/:aria-current="currentView === tab\.key \? 'page'/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2); // 分组导航与折叠态两套渲染都要有
  });
});

describe('P0-2 [N4/REQ-003] URL hash 与视图状态同步', () => {
  it('hash 解析与生成互为逆运算，非法输入不切换视图', () => {
    expect(parseHashView('#/query')).toBe('query');
    expect(parseHashView('#/query/abc')).toBe('query');
    expect(parseHashView('#/Data-Clean_x')).toBe('data-clean_x');
    expect(parseHashView('')).toBeNull();
    expect(parseHashView('javascript:alert(1)')).toBeNull();
    expect(parseHashView('#/')).toBeNull();
    expect(formatViewHash('graph')).toBe('#/graph');
  });

  it('全站不引入 vue-router，hash 同步是自建通道且已接入 App.vue', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['vue-router']).toBeUndefined();
    expect(pkg.devDependencies?.['vue-router']).toBeUndefined();

    const app = readSrc('App.vue');
    expect(app).toMatch(/useHashView\(/);
    expect(app).toMatch(/syncHash\(/);
    expect(app).toMatch(/applyHashView/);
  });

  it('菜单 key 与 hash 视图名同源：15 项都能写成 #/<key> 并解析回来', () => {
    for (const m of menuItems) {
      expect(parseHashView(formatViewHash(m.key))).toBe(m.key);
    }
  });
});

describe('P0-3 [N8/REQ-007] 悬浮问答首屏不遮挡', () => {
  it('默认折叠：localStorage 无记录时 isOpen 为 false，展开状态只跟随用户偏好', () => {
    const fc = readSrc('components/FloatingChat.vue');
    expect(fc).toMatch(
      /const isOpen = ref\(localStorage\.getItem\(STORAGE_KEYS\.FLOATING_CHAT_OPEN\) === 'true'\)/,
    );
    // 收起态只剩悬浮按钮：面板与按钮互斥渲染，不会两个都占住首屏
    expect(fc).toMatch(/v-if="isOpen"/);
    expect(fc).toMatch(/v-if="!isOpen"/);
    // 关闭要落盘（曾出现「关闭控件残留气泡」：状态没写回，下次进页又弹开）
    expect(fc).toMatch(/setOpen\(false\)/);
    expect(fc).toMatch(/localStorage\.setItem\(STORAGE_KEYS\.FLOATING_CHAT_OPEN/);
  });

  it('问答页不叠加第二个悬浮问答（同页两个输入框）', () => {
    const app = readSrc('App.vue');
    expect(app).toMatch(/<FloatingChat v-if="isLoggedIn && currentView !== 'query'"/);
  });
});

describe('P0-4 [X7/REQ-018] 主 CTA 必须带文字', () => {
  it('全站主按钮（type="primary"）无纯图标：逐文件扫描，违规列出文件与行号', () => {
    const offenders: string[] = [];
    for (const f of [...vueFiles('views'), ...vueFiles('components')]) {
      for (const hit of primaryButtonsWithoutText(f)) {
        offenders.push(`${path.basename(f)}:L${hit.line} ${hit.attrs}`);
      }
    }
    expect(offenders, `主 CTA 缺文字：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('问答页发送/停止这对主 CTA 带「发送」「停止」文字（本轮回归实测补回）', () => {
    const q = readSrc('views/Query.vue');
    expect(q).toMatch(/class="send-btn"[\s\S]{0,300}<span>发送<\/span>/);
    expect(q).toMatch(/class="stop-btn"[\s\S]{0,300}<span>停止<\/span>/);
    // 仍保留 tooltip 与无障碍名
    expect(q).toMatch(/data-tip="发送问题/);
    expect(q).toMatch(/aria-label="停止生成/);
  });

  it('高频工具栏允许纯图标，但必须配 tooltip（Q1 输入条即此形态）', () => {
    const toolbar = readSrc('components/InputToolbar.vue');
    expect(toolbar).toMatch(/:title="toolTip\(tool\)"/);
    expect(toolbar).toMatch(/:data-tip="toolTip\(tool\)"/);
  });
});

describe('P0-5 [Q1/REQ-019] 输入条：未实现项撤下或标灰、高频项可读', () => {
  it('禁用工具走「灰显 + 即将上线」，不再把「暂未实现」摆在主路径', () => {
    const toolbar = readSrc('components/InputToolbar.vue');
    expect(toolbar).toMatch(/return tool\.disabledReason \|\| '即将上线'/);
    expect(toolbar).toMatch(/disabled: tool\.disabled/);
    expect(stripComments(toolbar)).not.toMatch(/暂未实现/);
    // 禁用了就不派发选择事件
    expect(toolbar).toMatch(/if \(tool\.disabled\) return/);
  });

  it('问答页主工具条不带未实现项，芯片与输出模式联动而非并列两套', () => {
    const q = readSrc('views/Query.vue');
    const toolsBlock = /const toolbarTools = \[([\s\S]*?)\];/.exec(q);
    expect(toolsBlock, 'toolbarTools 定义应仍在 Query.vue').not.toBeNull();
    expect(toolsBlock?.[1]).not.toMatch(/disabled/);
    expect(toolsBlock?.[1]).toMatch(/label: '快速'/);
    expect(q).toMatch(/outputMode\.value = mode/); // 芯片 → 输出模式单一联动
  });
});

describe('P0-6 [B1/REQ-011] 仪表盘目录分布条按真实占比', () => {
  it('最大值恒 100%，小类按 count/max 收缩（旧口径 count*10 会把 44 也画满）', () => {
    expect(dirBarWidth(166, 166)).toBe(100);
    expect(dirBarWidth(44, 166)).toBe(27);
    expect(dirBarWidth(0, 0)).toBe(0);
    expect(dirBarWidth(5, 0)).toBe(0);
  });

  it('仪表盘确实走这个口径，且没有残留 *10 的旧算法', () => {
    const d = readSrc('views/Dashboard.vue');
    expect(d).toMatch(/import \{ dirBarWidth \} from '..\/utils\/dirBar'/);
    expect(d).toMatch(/dirBarWidth\(count, dirMax\.value\)/);
    expect(stripComments(d)).not.toMatch(/Math\.min\(100,\s*\w+\s*\*\s*10\)/);
  });
});

describe('P0-7 [X6·L1·P1/REQ-014+REQ-038] 跨视图数据一致性', () => {
  it('前后端「页面目录口径」必须逐字相同——任何一侧改动都会再造「两个总数对不上」', () => {
    const scope = readApi('src/vault/page-scope.ts');
    const apiDirs = /export const PAGE_DIRS: string\[\] = \[([^\]]+)\]/.exec(scope)?.[1];
    expect(apiDirs, 'api/src/vault/page-scope.ts 应导出 PAGE_DIRS 数组').toBeTruthy();
    const parsed = apiDirs
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(parsed).toEqual(PAGE_SCOPE_DIRS);
  });

  it('口径要印在数字旁边，而不是只藏在代码里', () => {
    expect(PAGE_TOTAL_HINT).toContain('口径与仪表盘一致');
    for (const d of PAGE_SCOPE_DIRS) expect(PAGE_TOTAL_HINT).toContain(d);
    const dc = readSrc('views/DataClean.vue');
    expect(dc).toMatch(/页面总数/);
    expect(dc).toMatch(/\{\{ PAGE_TOTAL_HINT \}\}/);
  });

  it('两个视图各取一个权威端点，前端不再自造目录清单', () => {
    const dash = readSrc('views/Dashboard.vue');
    const dc = readSrc('views/DataClean.vue');
    expect(dash).toMatch(/apiFetch\(`\$\{API_BASE\}\/stats`\)/);
    expect(dc).toMatch(/apiFetch\(`\$\{API_BASE\}\/data-clean\/pages`\)/);
    const copy = /'entities'\s*,\s*'concepts'/;
    expect(dash).not.toMatch(copy);
    expect(dc).not.toMatch(copy);
  });
});

describe('P0-8 [G1+G2/REQ-025+REQ-026] 图谱可读与核心操作可见', () => {
  it('Top-N 按连接度取，且丢弃悬空边（默认 70，不全量渲染）', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'a' },
      { from: 'd', to: 'e' },
    ];
    const out = topNGraphData({ nodes, edges }, 3);
    expect(out.nodes.sort()).toEqual(['a', 'b', 'c']);
    // d/e 被裁掉后那条边不能留下（悬空边会让渲染层报错或画出幽灵线）
    expect(out.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'a' },
    ]);
    expect(out.edges.every((e) => out.nodes.includes(e.from) && out.nodes.includes(e.to))).toBe(true);
    // N 够大时原样返回，且不改入参
    const full = topNGraphData({ nodes, edges }, 999);
    expect(full.nodes).toHaveLength(5);
    expect(nodes).toHaveLength(5);
  });

  it('图谱页：默认 Top-70、全图开关、搜索定位、显式「打开页面/找相关页面」与一次性指引', () => {
    const g = readSrc('views/Graph.vue');
    expect(g).toMatch(/const DEFAULT_TOP_N = 70/);
    expect(g).toMatch(/topNGraphData\(/);
    expect(g).toMatch(/placeholder="搜索节点并定位"/);
    expect(g).toMatch(/找相关页面/);
    expect(g).toMatch(/打开页面/);
    expect(g).toMatch(/karpathy:graph-tour-dismissed/); // 首次一次性提示，可关且不再骚扰
    expect(g).toMatch(/精简视图：仅显示连接度最高的前/); // 「看到的是子集」要说出来
  });
});

describe('P0-9 [H1+H2/REQ-028+REQ-030] 体检列表可筛可批量、批量修复可续跑', () => {
  const rows = (): IssueRow[] =>
    buildIssueRows({
      orphans: ['entities/a.md', 'concepts/b.md'],
      brokenLinks: [{ from: 'entities/c.md', to: 'entities/missing.md' }],
      stale: ['entities/d.md'],
      knowledgeStale: ['concepts/e.md'],
    });

  it('四类问题摊平成同一行模型：可自动修复 / 需人工判断分账报警', () => {
    const r = rows();
    expect(r).toHaveLength(5);
    const split = splitByActionable(r);
    expect(split.autoFixable).toBe(3); // orphan×2 + broken×1
    expect(split.manualReview).toBe(2); // stale + knowledgeStale 不走 LLM 批量
    expect(split.total).toBe(5);
  });

  it('搜索大小写不敏感并命中断链目标；默认 Top-N 折叠而不是 597 行一把梭', () => {
    const r = rows();
    expect(filterRows(r, 'MISSING').map((x) => x.key)).toEqual(['broken:entities/c.md->entities/missing.md']);
    expect(filterRows(r, ' concepts ')).toHaveLength(2);
    const collapsed = takeVisible(r, 2, false);
    expect(collapsed.visible).toHaveLength(2);
    expect(collapsed.hiddenCount).toBe(3);
    expect(takeVisible(r, 2, true).hiddenCount).toBe(0);
    // 目录聚合：根目录排最后，不抢首屏
    const dirs = groupRowsByDir(filterRows(r, 'entities/')).map((x) => x.dir);
    expect(dirs).toEqual(['entities']);
  });

  it('体检页有搜索/暂停/「预计剩余」，批量修复不再是刷不回的黑盒', () => {
    const h = readSrc('views/Health.vue');
    expect(h).toMatch(/placeholder="搜索路径或断链目标"/);
    expect(h).toMatch(/暂停/);
    expect(h).toMatch(/预计剩余 \{\{ formatDuration\(batchEtaMs\) \}\}/);
    expect(h).toMatch(/加载更多|展开全部/);
    const store = readSrc('stores/health.ts');
    // 恢复口径是快照而非事件流：事件只用于直播刷新
    expect(store).toMatch(/\/batch\/current/);
    expect(store).toMatch(/batch_resume/);
    expect(store).toMatch(/avgMsPerIssue/);
  });

  it('后端批量作业：可暂停/续跑/取消，且落盘原子（H2 断线恢复的硬前提）', () => {
    const job = readApi('src/workflows/batch-fix-job.ts');
    expect(job).toMatch(/async pause\(/);
    expect(job).toMatch(/async resume\(/);
    expect(job).toMatch(/async cancel\(/);
    // 本轮 P0 回归实测抓到的真实缺陷：快照/统计非原子写 → 恢复时读到半截 JSON（T02638）
    expect(job).toMatch(/writeAtomic/);
    expect(job).toMatch(/\.tmp/);
    expect(job).toMatch(/async flush\(/);
  });
});

describe('P0-10 [C1+C2/REQ-032+REQ-033] 配置中心分组与生效路径标注', () => {
  const item = (over: Partial<ConfigEffectItem>): ConfigEffectItem => ({
    key: 'k',
    label: 'L',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'ai',
    reason: 'r',
    ...over,
  });

  it('界面保存与改文件是两套口径，徽标不互相冒充；未登记字段宁可不显示', () => {
    const idx = indexEffectItems([
      item({ key: 'a', effect: 'restart', viaFile: 'restart' }),
      item({ key: 'b', effect: 'instant', viaFile: 'instant' }),
    ]);
    expect(badgeFor(idx.get('a'), 'ui')?.label).toBe('需重启服务');
    expect(badgeFor(idx.get('a'), 'file')?.label).toBe('改文件需重启');
    expect(badgeFor(idx.get('b'), 'ui')?.label).toBe('即时生效');
    expect(badgeFor(idx.get('b'), 'file')?.label).toBe('改文件即生效');
    expect(badgeFor(idx.get('zz'), 'ui')).toBeUndefined();
    expect(
      restartItemsOfTab([item({ key: 'x', effect: 'restart' }), item({ key: 'y', effect: 'instant' })], 'ai').map(
        (i) => i.key,
      ),
    ).toEqual(['x']);
  });

  it('12 个 tab 收成 3 组，生效方式唯一可信源在服务端登记表', () => {
    // T02482（PRD D4x）：「数据备份」页签承接原帮助文档的本地数据保护表单，11 → 12（仍 3 组）
    expect(allConfigTabs()).toHaveLength(12);
    expect(CONFIG_TAB_GROUPS.map((g) => g.key)).toEqual(['personal', 'ai', 'system']);
    const registry = readApi('src/utils/config-effects.ts');
    expect(registry).toMatch(/instant/);
    expect(registry).toMatch(/restart/);
    const route = readApi('src/routes/config.ts');
    expect(route).toMatch(/\/api\/config\/effects/);
    const effects = readSrc('utils/configEffects.ts');
    expect(effects).not.toMatch(/key: '/); // 前端不副本化字段表（否则服务端一改界面就说谎）
  });

  it('无权限 tab 置灰保留并标注，不静默把用户跳走', () => {
    const locked = allConfigTabs().filter((t) => isTabLocked(t, false));
    expect(locked.length).toBeGreaterThan(0);
    expect(LOCKED_TAB_HINT).toContain('仅管理员');
    expect(resolveInitialTab('schema', false)).not.toBe('schema');
    expect(resolveInitialTab(null, false)).toBe('tts');
    expect(resolveInitialTab(null, true)).toBe('config');
    const cfg = readSrc('views/Config.vue');
    expect(cfg).toMatch(/navGroupsFor/);
    expect(cfg).toMatch(/<ConfigEffectTag/);
    expect(cfg).toMatch(/pending-restart-bar/);
  });
});

describe('P0-11 [T1/REQ-035] 内网穿透启动失败可见可循', () => {
  it('后端异常串翻译成人话建议，并给出自检直达项', () => {
    expect(classifyStartError('未检测到 tailscale，请先安装')).toBe('tailscale_install');
    expect(classifyStartError('Tailscale 需要登录')).toBe('tailscale_login');
    expect(classifyStartError('cpolar.exe 下载失败')).toBe('binary_download');
    expect(classifyStartError('奇怪错误', 'tailscale')).toBe('tailscale_login');
    expect(classifyStartError('奇怪错误', 'cpolar')).toBe('generic');
    expect(adviceFor('magicdns')).toContain('MagicDNS');
    const view = buildStartErrorView({
      message: '路径不存在：D:/nope/tailscale.exe',
      at: Date.now(),
      provider: 'tailscale',
      source: 'boot',
    });
    expect(view.kind).toBe('bad_binary_path');
    expect(view.focus).toBe('binary');
    expect(focusTarget('binary')?.selector).toBe('#tunnel-binary-path');
    // 开机自启失败与手动启动失败的紧迫感不同，措辞必须分开
    expect(view.title).toContain('开机自动建立隧道失败');
  });

  it('自检三态各有中文结论与 aria 说明，旧灯要标明是几点检测的', () => {
    expect(prereqTone('ok').label).toBe('已满足');
    expect(prereqTone('fail').label).toBe('未满足');
    expect(prereqTone('unknown').label).toBe('待确认');
    const sum = summarizePrereq([
      { id: '1', label: 'a', state: 'ok', detail: '', fix: '', focus: 'binary' },
      { id: '2', label: 'b', state: 'fail', detail: '', fix: '', focus: 'login' },
    ]);
    expect(sum.ok).toBe(1);
    expect(sum.fail).toBe(1);
    expect(sum.allSatisfied).toBe(false);
    expect(sum.headline).toContain('1 项没满足');
    expect(summarizePrereq([]).headline).toBe('还没有检测过');
    expect(formatErrorAgo(0)).toBe('时间未知');
    const t = readSrc('views/Tunnel.vue');
    expect(t).toMatch(/startErrorView/);
    expect(t).toMatch(/\/tunnel\/prerequisites/);
  });
});

describe('P0-12 [D1x/REQ-037] 帮助文档路径与实名一致', () => {
  // T02784：章节数据迁至 utils/helpDocSections（Help.vue 只渲染）；
  // 直达按钮文案经 tabLabel('<tab key>') 模板拼接，故对文案只查前缀与拼接键，实名比对由 help-doc-code-sync 承担
  it('「前往：配置中心 → AI 服务」的每一段都是页面上真实存在的名字', () => {
    const help = readSrc('utils/helpDocSections.ts');
    const actions = [
      ...help.matchAll(
        /action: \{ label: (`[^`]+`|'[^']+'), view: '([^']+)'(?:, tab: '([^']+)')? \}/g,
      ),
    ];
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      const [, rawLabel, view, tab] = a;
      const menu = menuItems.find((m) => m.key === view);
      expect(menu, `文档里的 view "${view}" 必须是菜单 key`).toBeTruthy();
      expect(rawLabel.startsWith('`前往：') || rawLabel.startsWith(`'${'前往：'}`)).toBe(true);
      if (tab) {
        expect(configTabNames()).toContain(tab); // 第二段必须是配置中心真实 tab
        // 文案里拼进来的 tab key 必须与本 action 的 tab 同一个（防止文案与落点各说一套）
        const keyInLabel = rawLabel.match(/tabLabel\('([^']+)'\)/)?.[1];
        expect(keyInLabel, `直达按钮文案应经 tabLabel('${tab}') 拼接`).toBe(tab);
      }
    }
  });

  it('文档不再出现内部实现词（用户照做也找不到按钮的那类词）', () => {
    // T02784：改查渲染后的章节数据（阶段词经 STEP_LABEL 转实名后才进文档）
    const rendered = JSON.stringify(DOC_SECTIONS);
    for (const w of ['read_schema', 'generate_page', 'update_index']) {
      expect(rendered).not.toContain(w);
    }
  });
});

describe('P0-13 [A1/REQ-008] 默认口令不再明文暴露', () => {
  it('默认账户提示受服务端 bootstrap 门控，取不到就默认隐藏', () => {
    const login = readSrc('views/Login.vue');
    expect(login).toMatch(/\$\{API_BASE\}\/auth\/bootstrap/);
    expect(login).toMatch(/showDefaultHint\.value = data\.ok === true && data\.showDefaultAccountHint === true/);
    expect(login).toMatch(/v-if="showDefaultHint"/);
    expect(login).toMatch(/仅本地调试/);
    // 失败兜底必须是关，而不是猜一个 true
    expect(login).toMatch(/showDefaultHint\.value = false/);
  });

  it('服务端 bootstrap 端点只在 localOnly 下给提示，种子账号已加固', () => {
    const routes = readApi('src/routes/auth.ts');
    expect(routes).toMatch(/\/api\/auth\/bootstrap/);
    expect(routes).toMatch(/localOnly/);
    const store = readApi('src/auth/user-store.ts');
    expect(store).toMatch(/enabled: false/);
    expect(store).toMatch(/mustChangePassword: true/);
    expect(store).toMatch(/hardenSeedUsers/);
  });
});

describe('P0-14 [X1/REQ-029] 术语单一来源（与 9.1 守护联动）', () => {
  it('术语表存在，且 15 个菜单实名全部进表', () => {
    const glossaryPath = path.join(REPO, 'docs', '术语表.md');
    expect(fs.existsSync(glossaryPath), `术语表缺失：${glossaryPath}`).toBe(true);
    const glossary = fs.readFileSync(glossaryPath, 'utf8');
    for (const m of menuItems) {
      expect(glossary, `菜单名「${m.label}」应在术语表里`).toContain(m.label);
    }
  });

  it('菜单名 = 页标题：改名过的三页实测仍在原位显示实名', () => {
    // 清理页走常量（T02475 单一来源），体检/清洗页是模板字面量——两种写法都要断言到
    expect(CLEANUP_PAGE_TITLE).toBe(menuItems.find((m) => m.key === 'cleanup')?.label);
    expect(readSrc('views/Cleanup.vue')).toMatch(/\{\{ CLEANUP_PAGE_TITLE \}\}/);
    expect(readSrc('views/DataClean.vue')).toContain('页面质量清洗');
    expect(readSrc('views/Health.vue')).toContain('体检中心');
  });
});
