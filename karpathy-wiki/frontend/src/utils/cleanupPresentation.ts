// 缓存与日志清理页的展示口径（T02470 / PRD §12 S2+S3+S4+S5）
// ------------------------------------------------------------------
// 为什么抽出来：这一页原来把「删的是什么、会不会真删、有没有东西可删」三件事
// 全写在模板字符串里（且写的是 .harness/*.json、SHA-256、JSONL、resume 这类实现词），
// 既没法在浏览器外锁住，也没法保证页级预览开关和 4 张卡的说法一致。
// 收敛成纯函数后：措辞单一来源，页级开关的行为分支可以用单测穷举。
import type { CleanupActiveState, CleanupRunStateDir, CleanupRunStateRole, CleanupStorageStatus, CleanupTarget } from '../types';

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
export type CleanupMode = 'preview' | 'live';

export function buildPreviewBanner(mode: CleanupMode): string {
  if (mode === 'preview') return '';
  return '预览开关已关闭：下面 4 个「清理」按钮都会真实删除文件，且不可撤销。';
}

/** 页级开关旁的一句话，让「开/关」不用猜 */
export function previewSwitchHint(mode: CleanupMode): string {
  if (mode === 'preview') return '开着时只会列出会删哪些文件，不会真删。';
  return '已切到真实删除，每次点击都会先弹二次确认。';
}

export interface ModeChip {
  label: string;
  danger: boolean;
}

/** 卡片只呈现「当前模式」，不再自带开关 */
export function modeChip(mode: CleanupMode): ModeChip {
  if (mode === 'preview') return { label: '当前：仅预览', danger: false };
  return { label: '当前：真实删除', danger: true };
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

/**
 * T02808 建立时的「高级」面板是一张静态示意表（techPath 写死 `.harness/…`），
 * T02887 起四类目标都随状态返回真实目录清单，示意路径降级为「口径说明」：
 * 它描述的是后端按什么口径扫描（文件名模式），不再冒充「实际位置」——
 * 实际位置一律以 status 各卡的 dirs 为准，见 storageDirRows。
 */
/**
 * 运行状态目录角色的唯一措辞（T02808 建立，T02887 起四类目标共用）。
 * 后端给的是事实（role），这里给的是说法——「旧存放位置」与清理预览里的条目标注同一措辞，
 * 用户在两处看到的是同一个词，不会以为「遗留」和「旧存放位置」是两个概念。
 */
export const RUN_STATE_ROLE_TEXT: Record<CleanupRunStateRole, string> = {
  canonical: '当前存放位置',
  legacy: '旧存放位置',
};

export interface StorageDirRow {
  /** 后端返回的绝对路径原文，不重排、不相对化、不美化 */
  path: string;
  roleText: string;
  /** 计数行：位置不存在时说「还没有这个位置」，与「位置在但 0 个对象」分开 */
  countText: string;
  legacy: boolean;
}

/**
 * T02808：「高级」面板里各卡的真实目录清单。
 * 顺序沿用后端清单（首项即写入侧规范位置），前端不做任何重排——
 * 「页面显示的目录 = 后端真正扫的目录」这条一致性只能靠不改走来维持。
 */
export function storageDirRows(dirs: CleanupRunStateDir[]): StorageDirRow[] {
  return dirs.map((d) => ({
    path: d.path,
    roleText: RUN_STATE_ROLE_TEXT[d.role],
    countText: d.exists ? `${d.fileCount} 个文件 · ${d.sizeMb.toFixed(2)} MB` : '还没有这个位置',
    legacy: d.role === 'legacy',
  }));
}

/**
 * T02887：遗留位置里确实还有产物时的一句话说明；没有则返回空串（模板据此不渲染）。
 * 说明文案按卡取——运行状态提的是「进度文件」，编译缓存/运行日志各有各的历史落点缘由，
 * 一句话通吃会让用户对不上号。
 */
const LEGACY_HINT_SUBJECT: Partial<Record<CleanupCardKey, string>> = {
  compileCache: '那是编译缓存改存到统一目录之前留下的，',
  runState: '那是进度文件改存到统一目录之前留下的，',
  runLogs: '那是运行日志改存到统一目录之前留下的，',
};

export function legacyDirHint(key: CleanupCardKey, dirs: CleanupRunStateDir[]): string {
  const n = dirs.filter((d) => d.role === 'legacy').reduce((sum, d) => sum + d.fileCount, 0);
  if (n === 0) return '';
  const subject = LEGACY_HINT_SUBJECT[key] ?? '';
  return `其中 ${n} 个在旧存放位置：${subject}清完不会再增加。`;
}
