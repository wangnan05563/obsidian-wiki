// 缓存与日志清理页的展示口径（T02470 / PRD §12 S2+S3+S4+S5）
// ------------------------------------------------------------------
// 为什么抽出来：这一页原来把「删的是什么、会不会真删、有没有东西可删」三件事
// 全写在模板字符串里（且写的是 .harness/*.json、SHA-256、JSONL、resume 这类实现词），
// 既没法在浏览器外锁住，也没法保证页级预览开关和 4 张卡的说法一致。
// 收敛成纯函数后：措辞单一来源，页级开关的行为分支可以用单测穷举。
import type { CleanupActiveState, CleanupStorageStatus, CleanupTarget } from '../types';

/** S5：菜单名 = 页标题 = 帮助文档条目名，不再叫含糊的「系统清理」 */
export const CLEANUP_PAGE_TITLE = '缓存与日志清理';

/** S5：一句划清与「页面质量清洗」（原名「数据清洗」）的职责边界——本页只删临时文件 */
export const CLEANUP_PAGE_TIP = '只删临时文件，不改动知识库内容';

export type CleanupCardKey = 'compileCache' | 'runState' | 'runLogs' | 'rawArchive';

export interface CleanupCardMeta {
  key: CleanupCardKey;
  title: string;
  target: CleanupTarget;
  /** S3：人话——这一类删掉的到底是什么 */
  plain: string;
  /** S3：删了有什么后果（用户真正需要的决策信息） */
  consequence: string;
  /** S3：技术细节折叠到「高级」面板里，不再直抛给用户 */
  techPath: string;
  techNote: string;
  /** 保留天数只对按时间清理的两类有意义 */
  showDays: boolean;
  /** S4：这一类现在有多少可清对象，0 就按钮转禁用态 */
  countOf: (status: CleanupStorageStatus) => number;
  /** 计数单位文案 */
  counterLabel: (status: CleanupStorageStatus) => string;
}

export const CLEANUP_CARDS: CleanupCardMeta[] = [
  {
    key: 'compileCache',
    title: '编译缓存',
    target: 'compile_cache',
    plain: '记录哪些资料已经编译过，用来跳过重复编译。',
    consequence: '清掉后下次编译会把所有资料重跑一遍，更慢也更费 token。',
    techPath: '.harness/compile-cache.json',
    techNote: '增量编译的 SHA-256 内容哈希缓存',
    showDays: false,
    countOf: (s) => s.compileCache.entryCount,
    counterLabel: (s) => (s.compileCache.exists ? `${s.compileCache.entryCount} 条缓存` : '还没生成过'),
  },
  {
    key: 'runState',
    title: '运行状态',
    target: 'run_state',
    plain: '编译、问答等任务中断后接着跑所需的历史进度。',
    // T02655：把「删历史进度」和「删进行中任务的进度」两种代价分开说清——
    // 原来只说「重跑」，用户以为最坏就是慢一点，实际正在跑的那次会直接失败。
    consequence:
      '清掉后没能跑完的历史任务只能从头再来，已经生成的内容不受影响。代价分两种：删历史进度是那些任务重跑一次；删正在跑的任务的进度，是这次任务直接失败。',
    techPath: '.harness/state/*.json',
    techNote: '断点续传（resume）的历史任务状态文件',
    showDays: false,
    countOf: (s) => s.runState.fileCount,
    counterLabel: (s) => `${s.runState.fileCount} 个文件`,
  },
  {
    key: 'runLogs',
    title: '运行日志',
    target: 'run_logs',
    plain: '程序自己记的技术流水，排查问题时会用到。',
    consequence: '只删超过保留天数的旧日志；正在跑的任务日志不会被删。',
    techPath: '.harness/logs/*.log',
    techNote: 'harness 运行的 JSONL 技术日志，按保留天数清理',
    showDays: true,
    countOf: (s) => s.runLogs.fileCount,
    counterLabel: (s) => `${s.runLogs.fileCount} 个文件`,
  },
  {
    key: 'rawArchive',
    title: '原始资料',
    target: 'raw_archive',
    plain: '你投递进来的资料原件备份。',
    consequence: '删掉后无法回看原始文件，也不能再从原件重新编译；已生成的知识页面不受影响。',
    techPath: 'vault/raw/input-*.md',
    techNote: '投递原始存档，按保留天数清理',
    showDays: true,
    countOf: (s) => s.rawArchive.fileCount,
    counterLabel: (s) => `${s.rawArchive.fileCount} 个文件`,
  },
];

export function cardOf(key: CleanupCardKey): CleanupCardMeta {
  const meta = CLEANUP_CARDS.find((c) => c.key === key);
  if (!meta) throw new Error(`unknown cleanup card: ${key}`);
  return meta;
}

/**
 * S2：预览模式从 4 个卡内开关收敛成 1 个页级开关。
 * 关闭预览必须在页顶出现红色横幅——原来 4 个开关各自为政，
 * 用户以为「我只是关了一张卡」，实际另外三卡也可能已关。
 */
export function buildPreviewBanner(preview: boolean): string {
  return preview
    ? ''
    : '预览开关已关闭：下面 4 个「清理」按钮都会真实删除文件，且不可撤销。';
}

/** 页级开关旁的一句话，让「开/关」不用猜 */
export function previewSwitchHint(preview: boolean): string {
  return preview
    ? '开着时只会列出会删哪些文件，不会真删。'
    : '已切到真实删除，每次点击都会先弹二次确认。';
}

export interface ModeChip {
  label: string;
  danger: boolean;
}

/** 卡片只呈现「当前模式」，不再自带开关 */
export function modeChip(preview: boolean): ModeChip {
  return preview ? { label: '当前：仅预览', danger: false } : { label: '当前：真实删除', danger: true };
}

export interface CleanupButtonState {
  disabled: boolean;
  label: string;
  /** data-tip：为什么可以点 / 为什么不能点 */
  tip: string;
}

/**
 * T02655：这一类目标当前是否被「有任务在跑」拦住，以及拦它的原文原因。
 * 原因文案直接取自后端 status.active.blockedReasons——措辞只有一份，
 * 后端 409 说的是什么，前端置灰解释的就是什么。
 * 返回 null 表示不拦（含后端未给出 active 的情况，按不拦处理，避免整页假置灰）。
 */
export function blockedTipFor(
  target: CleanupTarget,
  active: CleanupActiveState | null | undefined,
): string | null {
  if (!(active?.blockedTargets ?? []).includes(target)) return null;
  const reasons = (active?.blockedReasons ?? [])
    .filter((r) => r.target === target)
    .map((r) => r.reason);
  return reasons.length > 0 ? reasons.join(' ') : '后端检测到进行中的任务，已拦截这一类的真实删除。';
}

/**
 * S4：可清对象为 0 时不再给一个「点了没反应」的红色按钮，
 * 而是转成「无需清理」禁用态并说明原因。status 还没回来时不置灰（避免刷新瞬间误判）。
 * T02655：真实删除模式下，被活跃任务拦住的那几类同样转禁用态，
 * 并把后端原因写进 data-tip——不能只靠二次确认文案里那句「建议先确认无活跃任务」。
 */
export function cleanupButtonState(
  key: CleanupCardKey,
  status: CleanupStorageStatus | null,
  preview: boolean,
): CleanupButtonState {
  const meta = cardOf(key);
  const base = preview ? '只列出会删哪些文件，不实际删除' : `将真实删除${meta.title}，执行前有二次确认`;
  if (!status) {
    return { disabled: false, label: `清理${meta.title}`, tip: `${base}（状态加载中）` };
  }
  if (meta.countOf(status) === 0) {
    return {
      disabled: true,
      label: '无需清理',
      tip: meta.key === 'compileCache' ? '还没有编译缓存，本来就没东西可清' : '这一类目前没有文件，可清对象为 0',
    };
  }
  // 预览模式不拦：预览不删文件，拦它只会让用户连「会删哪些」都看不到
  const blocked = preview ? null : blockedTipFor(meta.target, status.active);
  if (blocked) {
    return {
      disabled: true,
      label: '有任务进行中',
      tip: `${blocked}（切到「仅预览」仍可先看会删哪些文件；后端也会拒绝这次真实删除）`,
    };
  }
  return { disabled: false, label: `清理${meta.title}`, tip: base };
}

/** 非预览模式下的二次确认话术（S6 原有保护要保住，措辞随页级开关走） */
export function confirmText(title: string): string {
  // T02655：原来这里写的是「建议先确认无活跃编译/问答任务」——纯建议，用户看不到怎么确认。
  // 现在后端会硬拦，话术改成陈述事实：有任务在跑时这次删除会被拒绝，不需要用户自己判断。
  return `确认清理${title}？此操作不可撤销。若有编译或问答任务正在进行，后端会直接拒绝这次删除。`;
}

/** 「高级」面板：技术细节集中一处，主界面不再出现 .harness / SHA-256 / JSONL / resume */
export function advancedRows(): { title: string; path: string; note: string }[] {
  return CLEANUP_CARDS.map((c) => ({ title: c.title, path: c.techPath, note: c.techNote }));
}
