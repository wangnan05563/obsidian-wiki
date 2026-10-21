// 清理拦截策略（T02655：真实删除前的活跃任务硬拦截）。
//
// 背景：POST /api/cleanup 在真实删除（dry_run=false）模式下会删 `.harness/state/*.json`
// 与 `vault/raw/` 下的原始资料存档，而这两类正是**正在跑的编译/问答任务**当下依赖的东西。
// 此前只有二次确认框里一句「建议先确认无活跃编译/问答任务」的软提示——用户把「仅预览」
// 开关一关、看都不看就点确认，正在跑的编译会被当场打断。本模块把提示升级成硬拦截口径。
//
// 判定依据来自 activity.ts 的进程内计数（由任务自己在确定的起止点登记），
// 不读 .harness/state 文件里的 status 字段：那个字段全仓从未写入过 'running'，
// 按文件判活跃既会误判历史残留、也会漏掉刚起跑的任务（详见 activity.ts 头注释）。
//
// 为什么拦 run_state、raw_archive 与 compile_cache 三类：
//  - run_state：清理**不带 days 过滤**，会把目录里所有 json 无差别删掉，
//    其中就包括进行中任务的续传基准 → 必须拦。
//  - raw_archive：进行中/排队中的编译要读原件，删了这次编译拿不到输入 → 必须拦。
//  - compile_cache（T02818 起纳入）：编译把缓存读进内存，删除不会让它失败，
//    但它**结束时会把整份内存映射写回** compile-cache.json。于是「清理成功」的响应
//    （"已删除编译缓存…下次编译将重新生成"）与磁盘事实相反——旧条目一条没少。
//    原先这里判的是「代价可自愈，不拦」，漏掉的是"假回执"这一半：用户看到已删除，
//    实际什么都没清掉，而且没有任何地方告诉他缓存回来了。写入方在运行中期落盘，
//    T02774 的「起跑前先等清理」救不了它（等待发生在写入之前，写入却发生在删除之后），
//    能闭合这个窗口的只有「有编译在跑就别删缓存」。
//  - run_logs：按 days 过滤，正在写的日志 mtime 必然新于 cutoff，天然删不到；
//    真删到了被占用的旧日志也只会落进 errors[]，不影响任务本身。
import { activeActivities, foreignActiveActivities } from './activity.js';
import type { ActivityRecord } from './cleanup-cross-process.js';
import type { CleanupActiveState } from './types.js';

// 'all' 展开后的具体目标（与路由分发保持一致）
export const ALL_CLEANUP_TARGETS = ['compile_cache', 'run_state', 'run_logs', 'raw_archive'] as const;

interface BlockRule {
  target: string;
  kind: 'compile' | 'query';
  reason: string;
}

const BLOCK_RULES: BlockRule[] = [
  {
    target: 'run_state',
    kind: 'compile',
    reason: '有编译任务正在进行：清理会删掉它的断点续传基准，这次编译会直接失败或从头重跑。',
  },
  {
    // T02818：编译结束时会把整份内存缓存写回，删除窗口内的缓存清理必然被它盖回来
    target: 'compile_cache',
    kind: 'compile',
    reason: '有编译任务正在进行：它在完成时会把编译缓存整体写回，这次清理会当场失效（报「已删除」而文件仍在）。',
  },
  {
    target: 'raw_archive',
    kind: 'compile',
    reason: '有编译任务正在进行：它要读的原始资料存档可能在这次清理里被删掉。',
  },
  {
    target: 'run_state',
    kind: 'query',
    reason: '有问答任务正在进行：它的运行状态文件会被无差别删除，这次问答会中断。',
  },
];

/** 按「活跃数 → 被拦目标/原因」算快照；进程内与跨进程合并后共用这一份口径。 */
function buildActiveState(
  counts: { compile: number; query: number },
  reasonSuffix = '',
): CleanupActiveState {
  const blockedReasons = BLOCK_RULES.filter((rule) =>
    rule.kind === 'compile' ? counts.compile > 0 : counts.query > 0,
  ).map((rule) => ({ target: rule.target, reason: rule.reason + reasonSuffix }));
  return {
    compile: counts.compile,
    query: counts.query,
    // 去重后的目标清单（同一目标可能同时被 compile/query 规则命中）
    blockedTargets: ALL_CLEANUP_TARGETS.filter((t) => blockedReasons.some((r) => r.target === t)),
    // 原文原因：前端置灰提示直接引用，不再各写一份措辞（避免两套口径漂移）
    blockedReasons,
  };
}

/** 读取当前活跃任务快照，并算出被拦目标（前端置灰与后端守卫共用同一口径）。 */
export function currentActiveState(): CleanupActiveState {
  return buildActiveState(activeActivities());
}

/**
 * T02817：并入**其它进程**声明的活跃数后的快照。
 * 为什么要单独一份：activity.ts 的计数在进程内存里，桌面端实例与手工 dev 实例并存时
 * 各自的清理守卫都读不到对方——「B 正在编译，A 的真实删除照样放行」这条破口就是这么来的。
 * 措辞后缀让排查时一眼分清「被本进程拦」与「被另一进程拦」（T02817 验收口径）。
 */
export async function activeStateAcrossProcesses(): Promise<CleanupActiveState> {
  const local = activeActivities();
  const foreign = await foreignActiveActivities();
  const counts = { compile: local.compile + foreign.compile, query: local.query + foreign.query };
  if (foreign.compile + foreign.query === 0) return buildActiveState(counts);
  return buildActiveState(counts, foreignSuffix(foreign.instances));
}

/** 「另一实例」的点名后缀：pid + 实例标识，让人不用猜是谁拦的。 */
function foreignSuffix(instances: ActivityRecord[]): string {
  if (instances.length === 0) return '';
  const who = instances.map((i) => `pid ${i.pid} @ ${i.instance}`).join('、');
  return `（来自另一服务实例：${who}）`;
}

export interface CleanupGuardVerdict {
  /** 命中的被拦目标（请求 target 为 'all' 时列出其中被拦的子目标） */
  blocked: string[];
  /** 人话原因，与 blocked 一一对应（可能同一目标多条原因） */
  reasons: string[];
}

/** 纯函数判定：便于单测穷举，也便于路由与状态接口共用。 */
export function evaluateCleanupGuard(
  target: string,
  active: CleanupActiveState = currentActiveState(),
): CleanupGuardVerdict {
  const targets = target === 'all' ? [...ALL_CLEANUP_TARGETS] : [target];
  const blocked = new Set<string>();
  const reasons: string[] = [];
  for (const rule of BLOCK_RULES) {
    const busy = rule.kind === 'compile' ? active.compile > 0 : active.query > 0;
    if (!busy || !targets.includes(rule.target)) continue;
    blocked.add(rule.target);
    // T02817：文案取 active.blockedReasons 里的这一条，而不是 rule.reason。
    // 跨进程合并时后缀「（来自另一服务实例：pid …）」只写在快照里，
    // 直接用 rule.reason 会把「到底是谁拦的」这个信息在响应体里丢掉——用户只看到
    // 「有编译任务正在进行」，而本进程一个编译也没有，无从排查。
    const reason =
      active.blockedReasons.find((r) => r.target === rule.target && r.reason.startsWith(rule.reason))
        ?.reason ?? rule.reason;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return {
    blocked: ALL_CLEANUP_TARGETS.filter((t) => blocked.has(t)),
    reasons,
  };
}

/** 供 409 响应体使用的一句话摘要（error 字段）：前端直接展示，不再拼字符串。 */
export function guardErrorMessage(
  target: string,
  verdict: CleanupGuardVerdict,
  active: CleanupActiveState = currentActiveState(),
): string {
  // T02817：计数同样取自传入的快照。原先这里另读一次 currentActiveState()（进程内口径），
  // 另一实例在跑、本进程空闲时会退化成含糊的「存在进行中任务（活跃任务）」，
  // 与 reasons 里精确到 pid 的点名自相矛盾。
  const busy: string[] = [];
  if (active.compile > 0) busy.push(`${active.compile} 个编译`);
  if (active.query > 0) busy.push(`${active.query} 个问答`);
  return `存在进行中任务（${busy.join('、') || '活跃任务'}），已拦截真实删除：${verdict.blocked
    .map((t) => targetLabel(t))
    .join('、')}。请先停止或等待任务结束，或改用「仅预览」。`;
}

function targetLabel(target: string): string {
  switch (target) {
    case 'run_state':
      return '运行状态';
    case 'raw_archive':
      return '原始资料';
    case 'compile_cache':
      return '编译缓存';
    case 'run_logs':
      return '运行日志';
    default:
      return target;
  }
}
