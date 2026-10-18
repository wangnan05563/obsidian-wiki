// 内网穿透诊断文案（T02469 / PRD §11 T1+T4）
// ------------------------------------------------------------------
// 为什么把文案判定抽成纯函数：告警条「说什么」和页面「怎么渲染」是两件事。
// 后端只给一条 message（甚至只是 Java/Node 风格的异常串），要把它翻译成人能看懂的一句
// 「八成是哪儿没弄好」，靠的是关键字匹配 + 来源区分；这类映射最需要单测锁住，
// 放进 .vue 里就只能靠手点，改一个字就没人兜得住。
import type { TunnelPrereqItem, TunnelPrereqState, TunnelPrereqFocus, TunnelStartError } from '../types';

/** 状态灯三态 → Element Plus tag 类型 + 中文标签 */
export interface PrereqTone {
  /** el-tag type */
  type: 'success' | 'danger' | 'warning';
  /** 灯上的中文结论 */
  label: string;
  /** 无障碍/悬浮说明（三态语义不同，不能只靠颜色区分） */
  ariaLabel: string;
}

export function prereqTone(state: TunnelPrereqState): PrereqTone {
  switch (state) {
    case 'ok':
      return { type: 'success', label: '已满足', ariaLabel: '这一项已经满足' };
    case 'fail':
      return { type: 'danger', label: '未满足', ariaLabel: '这一项没满足，启动大概率会失败' };
    default:
      // unknown 显示成绿色是骗人、显示成红色是指责用户，所以是「待确认」的黄色
      return { type: 'warning', label: '待确认', ariaLabel: '现在判断不了，先按提示处理再重新检测' };
  }
}

/** 自检清单摘要：用于卡片标题右侧的「3 项已满足 / 1 项待处理」 */
export interface PrereqSummary {
  ok: number;
  fail: number;
  unknown: number;
  total: number;
  allSatisfied: boolean;
  /** 一句话结论 */
  headline: string;
}

export function summarizePrereq(items: TunnelPrereqItem[]): PrereqSummary {
  const ok = items.filter((i) => i.state === 'ok').length;
  const fail = items.filter((i) => i.state === 'fail').length;
  const unknown = items.filter((i) => i.state === 'unknown').length;
  const allSatisfied = items.length > 0 && fail === 0 && unknown === 0;
  let headline = '';
  if (items.length === 0) headline = '还没有检测过';
  else if (fail > 0) headline = `有 ${fail} 项没满足`;
  else if (unknown > 0) headline = `有 ${unknown} 项暂时判断不了`;
  else headline = '全部满足，可以直接启动';
  return { ok, fail, unknown, total: items.length, allSatisfied, headline };
}

/** 相对时间：刚刚 / N 分钟 / N 小时 / 绝对时间（超过一天不再说「N 天前」，避免模糊） */
function relativeAgo(ts: number, now: number): { unit: string; absolute: string } {
  const diffMs = Math.max(0, now - ts);
  const min = Math.floor(diffMs / 60000);
  if (diffMs < 60000) return { unit: '刚刚', absolute: '' };
  if (min < 60) return { unit: `${min} 分钟前`, absolute: '' };
  const hour = Math.floor(min / 60);
  if (hour < 24) return { unit: `${hour} 小时前`, absolute: '' };
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { unit: '', absolute: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** 检测时间：界面必须说清这盏灯是几点的，旧灯当现状是自检类页面最常见的误导 */
export function formatCheckedAt(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '尚未检测';
  const { unit, absolute } = relativeAgo(ts, now);
  return absolute ? `${absolute} 检测` : `${unit}检测`;
}

/**
 * 失败发生时间：告警条说的是「什么时候失败的」，不能沿用「检测」措辞——
 * UI 实测（T02469 Phase A）就抓到过 「18 分钟前检测」 贴在启动失败旁边，读起来像那次自检是 18 分钟前跑的。
 */
export function formatErrorAgo(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '时间未知';
  const { unit, absolute } = relativeAgo(ts, now);
  if (absolute) return `发生于 ${absolute}`;
  return unit === '刚刚' ? '刚刚发生' : `发生于 ${unit}`;
}

/** 后端错误串 → 人话分类（决定告警条给哪条建议、跳哪一个自检项） */
export type StartErrorKind =
  | 'binary_download'
  | 'funnel_auth'
  | 'tailscale_install'
  | 'tailscale_login'
  | 'magicdns'
  | 'bad_binary_path'
  | 'authtoken_missing'
  | 'provider_start'
  | 'generic';

// 关键字表按「后端真实抛出的文案」维护（tunnel-service.ts 的 throw 点）：
// 改 provider 抛错措辞时这里要同步，否则用户看到的建议会与原因错位——那比没有建议更糟。
// 顺序 = 优先级：先判服务商专属（Tailscale / MagicDNS / Funnel），再判通用（路径 / token / 下载），
// 因为「未检测到 Tailscale。请先安装…」这类串里同时带下载链接，先判「下载」会把建议指错地方。
const START_ERROR_KINDS: Array<{ kind: StartErrorKind; keys: string[] }> = [
  { kind: 'magicdns', keys: ['magicdns'] },
  { kind: 'funnel_auth', keys: ['funnel'] },
  { kind: 'tailscale_install', keys: ['未检测到 tailscale', '请先安装', 'tailscale 二进制未检测到'] },
  { kind: 'tailscale_login', keys: ['请先打开并登录 tailscale', '需要登录', '未登录'] },
  { kind: 'bad_binary_path', keys: ['路径不存在'] },
  { kind: 'authtoken_missing', keys: ['authtoken'] },
  { kind: 'binary_download', keys: ['下载', '二进制', '解压', 'cloudflared.exe', 'cpolar.exe'] },
  { kind: 'provider_start', keys: ['启动超时', '进程已退出', '子进程'] },
];

export function classifyStartError(message: string, provider?: string): StartErrorKind {
  const m = (message ?? '').toLowerCase();
  for (const rule of START_ERROR_KINDS) {
    if (rule.keys.some((k) => m.includes(k.toLowerCase()))) return rule.kind;
  }
  // 没命中关键字但服务商是 tailscale：绝大多数剩余项都出在客户端没开
  return provider === 'tailscale' ? 'tailscale_login' : 'generic';
}

/** 每种失败给一句「先动哪里」的建议 */
const ADVICE: Record<StartErrorKind, string> = {
  binary_download: '本机拿不到穿透程序，可以先按下面的手动链接下载放好，再重新检测',
  funnel_auth: 'Tailscale 需要你在浏览器确认一次公网授权，点「去授权」完成后重试',
  tailscale_install: '这台电脑似乎没装 Tailscale，装好并登录后再启动',
  tailscale_login: 'Tailscale 客户端没在运行或没登录——它的登录状态本程序改不了，请先在任务栏打开 Tailscale 登录',
  magicdns: '这台机器还没有 ts.net 域名，需要到 Tailscale 管理后台把 MagicDNS 打开',
  bad_binary_path: '「程序路径」里填的位置已经不存在了，清空让它自动探测，或改成实际安装路径',
  authtoken_missing: 'cpolar 必须带账号 authtoken 才能起隧道，到 cpolar 个人中心复制后填进来',
  provider_start: '隧道程序启动后没有正常给出公网地址，先重新检测前置条件再试一次',
  generic: '原因不好直接判断，先跑一次前置条件自检，看哪一项没满足',
};

export function adviceFor(kind: StartErrorKind): string {
  return ADVICE[kind];
}

/** 告警条标题：开机自启失败与手动启动失败的紧迫感不同，措辞必须分开 */
export function startErrorTitle(err: TunnelStartError): string {
  if (err.source === 'boot') return '开机自动建立隧道失败（当前未对外开放）';
  return '隧道启动失败';
}

export interface StartErrorView {
  title: string;
  advice: string;
  kind: StartErrorKind;
  /** 这条失败是几点发生的（旧失败要说时间，否则用户会以为是自己刚才点坏的） */
  when: string;
  /** 建议直达的自检项 id（有则给「查看前置条件」按钮加锚点） */
  focus: TunnelPrereqFocus | null;
}

const KIND_FOCUS: Record<StartErrorKind, TunnelPrereqFocus | null> = {
  binary_download: 'binary',
  funnel_auth: 'funnelAuth',
  tailscale_install: 'binary',
  tailscale_login: 'login',
  magicdns: 'magicDns',
  bad_binary_path: 'binary',
  authtoken_missing: 'authtoken',
  provider_start: null,
  generic: null,
};

export function buildStartErrorView(err: TunnelStartError, now: number = Date.now()): StartErrorView {
  const kind = classifyStartError(err.message, err.provider);
  return {
    title: startErrorTitle(err),
    advice: adviceFor(kind),
    kind,
    when: formatErrorAgo(err.at, now),
    focus: KIND_FOCUS[kind],
  };
}

/** 「去处理」的落点：把 focus 映射到页面上能解决它的那块控件 */
const FOCUS_TARGETS: Record<TunnelPrereqFocus, { selector: string; label: string } | null> = {
  binary: { selector: '#tunnel-binary-path', label: '改二进制路径' },
  login: null, // 登录是外部动作（任务栏里的 Tailscale），页面上没有对应控件
  magicDns: null, // 同上：在 Tailscale 管理后台，只能给外链
  funnelAuth: null, // 首次启动时浏览器完成，页面上唯一的动作就是「启动隧道」
  wizard: { selector: '#tunnel-mode', label: '打开配置向导' },
  authtoken: { selector: '#tunnel-authtoken', label: '填 authtoken' },
  port: { selector: '#tunnel-port', label: '改本地端口' },
};

export function focusTarget(focus: TunnelPrereqFocus): { selector: string; label: string } | null {
  return FOCUS_TARGETS[focus] ?? null;
}
