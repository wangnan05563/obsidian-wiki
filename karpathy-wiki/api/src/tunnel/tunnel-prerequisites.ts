// 内网穿透前置条件自检（T02469 / PRD §11 T1+T4）
// ------------------------------------------------------------------
// 需求原话：T1「启动失败把后端原因映射成内联告警条 + 前置条件自检直达」、
//           T4「『前置条件』4 条纯文字清单，无『检测是否满足』动作 → 用户只能启动后靠报错猜」。
// 这两条其实是同一个缺口的两面：失败原因只在后端日志里（index.ts 的 boot self-start catch），
// 而清单只是文案 —— 用户既不知道坏了什么，也无从知道自己到底缺哪一步。
//
// 为什么单独成模块而不是加到 TunnelService/TailscaleProvider 上：
//   provider 实例只有在 start() 之后才存在（TunnelService.provider 初始为 null），
//   而自检必须在「从未启动过」时就能跑；且 provider 的检查全写在 start() 的抛错路径里，
//   复用会让一次点灯变成一次真启动尝试。这里做的是同一套判据的「只读版」：探到事实、给出结论，
//   不 spawn 隧道、不改配置、绝不抛错（探测失败如实降级为 unknown）。
//
// 三态而不是两态：unknown 用来诚实表达「没检测到不等于不满足」（未安装时无从判断登录状态、
// CLI 超时、非本机环境）。把它显示成红色「未满足」是指责用户，显示成绿色是骗人。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { TunnelConfig } from '../types.js';
import { TunnelService } from './tunnel-service.js';

const execAsync = promisify(exec);

export type TunnelPrereqState = 'ok' | 'fail' | 'unknown';

/** 前端「去处理」的落点：聚焦到页面上能解决它的那一处控件 */
export type TunnelPrereqFocus =
  | 'binary'        // 安装/填写 Tailscale 路径
  | 'login'         // 打开客户端并登录（外部动作）
  | 'magicDns'      // 管理后台开 MagicDNS
  | 'funnelAuth'    // 首次启动时的 Funnel 授权
  | 'wizard'        // Cloudflare 命名隧道三步向导
  | 'authtoken'     // cpolar authtoken
  | 'port';         // 本地端口

export interface TunnelPrereqItem {
  id: string;
  /** 面向用户的中文标签（不再是「1. 需预装 Tailscale」这类清单文案） */
  label: string;
  state: TunnelPrereqState;
  /** 实测到的事实，一句话（成功时也写，让用户知道「凭什么说满足」） */
  detail: string;
  /** 未满足/待确认时的处理指引 */
  fix: string;
  focus: TunnelPrereqFocus;
  fixUrl?: string;
}

export interface TunnelPrereqResult {
  provider: string;
  /** 检测时间戳（ms）：界面上要说「刚刚检测过 / 3 分钟前」，避免用户拿旧灯当现状 */
  checkedAt: number;
  items: TunnelPrereqItem[];
  /** 全部满足才 true；unknown 不算满足（否则「重新检测」按钮永远没有意义） */
  allSatisfied: boolean;
}

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/windows';
const TAILSCALE_ADMIN_CONSOLE_URL = 'https://login.tailscale.com/admin/machines';

// ===== Tailscale：事实采集（IO）与结论生成（纯函数）分离 =====

/** CLI 探到的原始事实；缺项一律 null/空串，由 buildTailscaleItems 负责解释 */
export interface TailscaleFacts {
  /** 配置里填写的二进制路径（原样，用于区分「填了但不存在」与「没填」） */
  configuredPath: string;
  /** 实际探测到的可执行文件；探不到为 null */
  detectedBinary: string | null;
  /** 配置路径存在但不可用（被删/权限）——与「根本没装」是两回事，指引也不同 */
  configuredPathMissing: boolean;
  /** tailscale status --json 的 BackendState；取不到为 null */
  backendState: string | null;
  /** Self.DNSName（已去尾点）；取不到为空串 */
  dnsName: string;
  /** funnel status --json 的 AllowFunnel 是否覆盖本机主机；取不到为 null */
  funnelAllowed: boolean | null;
  /** 采集过程中的失败原因（CLI 超时/未登录导致 JSON 不可用等），用于如实降级 */
  probeError: string;
}

function dnsNameIsTsNet(dnsName: string): boolean {
  return dnsName.trim().replace(/\.$/, '').toLowerCase().endsWith('.ts.net');
}

/**
 * 纯函数：把事实翻译成四项灯（与页面旧清单 1:1 对应，用户不会看到「多了一堆看不懂的检查」）。
 * 顺序即依赖顺序：没装客户端时后面几项一律 unknown —— 这是诚实而不是偷懒。
 */
function buildBinaryItem(f: TailscaleFacts): TunnelPrereqItem {
  if (f.configuredPathMissing) {
    return {
      id: 'binary',
      label: 'Tailscale 客户端',
      state: 'fail',
      detail: `配置里填的路径已经不存在：${f.configuredPath}`,
      fix: '清空该路径让它自动探测，或重新填写已安装的 tailscale.exe 位置',
      focus: 'binary',
    };
  }
  if (f.detectedBinary) {
    return {
      id: 'binary',
      label: 'Tailscale 客户端',
      state: 'ok',
      detail: `已找到：${f.detectedBinary}`,
      fix: '',
      focus: 'binary',
    };
  }
  return {
    id: 'binary',
    label: 'Tailscale 客户端',
    state: 'fail',
    detail: '本机没有探测到 tailscale.exe（PATH 与 Program Files 都没找到）',
    fix: 'Tailscale 是系统级服务，需要你先安装并登录，本程序不会替你装',
    focus: 'binary',
    fixUrl: TAILSCALE_DOWNLOAD_URL,
  };
}

function loginDetail(f: TailscaleFacts): string {
  if (f.backendState) return `后台服务状态：${f.backendState}`;
  if (f.probeError) return `查不到登录状态（${f.probeError}）`;
  return '查不到登录状态';
}

function buildLoginItem(f: TailscaleFacts, binaryOk: boolean): TunnelPrereqItem {
  if (!binaryOk) {
    return {
      id: 'login',
      label: '已登录 Tailscale 账号',
      state: 'unknown',
      detail: '需要先装好客户端才能判断',
      fix: '完成上一步后点「重新检测」',
      focus: 'login',
    };
  }
  if (f.backendState === 'Running') {
    return {
      id: 'login',
      label: '已登录 Tailscale 账号',
      state: 'ok',
      detail: '后台服务状态：Running',
      fix: '',
      focus: 'login',
    };
  }
  return {
    id: 'login',
    label: '已登录 Tailscale 账号',
    state: f.backendState ? 'fail' : 'unknown',
    detail: loginDetail(f),
    fix: '在任务栏打开 Tailscale 图标并登录账号，然后回来点「重新检测」',
    focus: 'login',
  };
}

function buildMagicDnsItem(f: TailscaleFacts, binaryOk: boolean): TunnelPrereqItem {
  if (!binaryOk || (!f.dnsName && f.backendState !== 'Running')) {
    return {
      id: 'magicDns',
      label: '启用 MagicDNS（拿到固定的 ts.net 地址）',
      state: 'unknown',
      detail: '还查不到这台机器的域名',
      fix: '登录 Tailscale 后点「重新检测」',
      focus: 'magicDns',
    };
  }
  if (dnsNameIsTsNet(f.dnsName)) {
    return {
      id: 'magicDns',
      label: '启用 MagicDNS（拿到固定的 ts.net 地址）',
      state: 'ok',
      detail: `本机域名：${f.dnsName}`,
      fix: '',
      focus: 'magicDns',
    };
  }
  return {
    id: 'magicDns',
    label: '启用 MagicDNS（拿到固定的 ts.net 地址）',
    state: 'fail',
    detail: f.dnsName ? `本机域名不是 ts.net 结尾：${f.dnsName}` : '本机还没有 ts.net 域名',
    fix: '到 Tailscale 管理后台把 DNS 配置里的 MagicDNS 打开（团队管理员权限）',
    focus: 'magicDns',
    fixUrl: TAILSCALE_ADMIN_CONSOLE_URL,
  };
}

function funnelDetail(f: TailscaleFacts): string {
  if (f.funnelAllowed === false) return '当前账号还没有把 Funnel 开关打开';
  if (f.probeError) return `暂时查不到 Funnel 开关（${f.probeError}）`;
  return '尚未检测（首次启动隧道时会在浏览器里请你确认一次）';
}

function buildFunnelAuthItem(f: TailscaleFacts): TunnelPrereqItem {
  // Funnel 授权是「启动时才发生」的动作，未开启时是 unknown 而不是 fail
  if (f.funnelAllowed === true) {
    return {
      id: 'funnelAuth',
      label: '允许公网 Funnel 访问',
      state: 'ok',
      detail: '这台机器已允许 Funnel',
      fix: '',
      focus: 'funnelAuth',
    };
  }
  const notAllowed = f.funnelAllowed === false;
  return {
    id: 'funnelAuth',
    label: '允许公网 Funnel 访问',
    state: notAllowed ? 'fail' : 'unknown',
    detail: funnelDetail(f),
    fix: notAllowed
      ? '直接点「启动隧道」，浏览器会弹出授权页；确认后回来重新检测'
      : '直接点「启动隧道」即可，首次会引导你完成授权',
    focus: 'funnelAuth',
  };
}

/**
 * 纯函数：把事实翻译成四项灯（与页面旧清单 1:1 对应，用户不会看到「多了一堆看不懂的检查」）。
 * 顺序即依赖顺序：没装客户端时后面几项一律 unknown —— 这是诚实而不是偷懒。
 */
export function buildTailscaleItems(f: TailscaleFacts): TunnelPrereqItem[] {
  const binaryOk = Boolean(f.detectedBinary);
  return [
    buildBinaryItem(f),
    buildLoginItem(f, binaryOk),
    buildMagicDnsItem(f, binaryOk),
    buildFunnelAuthItem(f),
  ];
}

/** 采集 Tailscale 事实：全程只读，任何一步失败都只是让对应灯变 unknown */
export async function probeTailscaleFacts(config: TunnelConfig): Promise<TailscaleFacts> {
  const facts: TailscaleFacts = {
    configuredPath: config.binaryPath ?? '',
    detectedBinary: null,
    configuredPathMissing: false,
    backendState: null,
    dnsName: '',
    funnelAllowed: null,
    probeError: '',
  };
  try {
    facts.detectedBinary = await detectTailscaleBinary(config.binaryPath, facts);
  } catch (err) {
    facts.probeError = err instanceof Error ? err.message : String(err);
    return facts;
  }
  if (!facts.detectedBinary) return facts;

  let status: Record<string, unknown>;
  try {
    status = JSON.parse(await runTailscaleCli(facts.detectedBinary, ['status', '--json'])) as Record<string, unknown>;
  } catch (err) {
    // 客户端没开时这条命令会失败 —— 正是「未登录」而不是「检测坏了」，交给结论层区分
    facts.probeError = err instanceof Error ? err.message : String(err);
    return facts;
  }
  facts.backendState = typeof status.BackendState === 'string' ? status.BackendState : null;
  const self = status.Self as Record<string, unknown> | undefined;
  facts.dnsName = typeof self?.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '') : '';

  try {
    const funnel = JSON.parse(await runTailscaleCli(facts.detectedBinary, ['funnel', 'status', '--json'])) as Record<
      string,
      unknown
    >;
    const allow = funnel.AllowFunnel as Record<string, boolean> | undefined;
    if (allow && facts.dnsName) facts.funnelAllowed = readFunnelAllowed(allow, facts.dnsName);
  } catch {
    facts.funnelAllowed = null;
  }
  return facts;
}

/**
 * `tailscale funnel status --json` 的 AllowFunnel 键带端口后缀
 * （实测：`"desktop-xxxx.tailxxxx.ts.net:443": true`），拿裸域名直接查必然 miss。
 * Phase B 真机实测就是靠这个抓到「隧道明明在跑、灯却报未满足」的假红灯。
 * 口径：命中键 → 按键值；没命中但列出了别的主机 → 这台确实没开（false）；
 * 整个表是空的 → 判断不了（null，交给上层亮「待确认」而不是「未满足」）。
 */
export function readFunnelAllowed(allow: Record<string, boolean>, dnsName: string): boolean | null {
  const host = normalizeHost(dnsName);
  const entries = Object.entries(allow);
  const hit = entries.find(([k]) => normalizeHost(k) === host);
  if (hit) return hit[1] === true;
  return entries.length === 0 ? null : false;
}

/** 主机名归一：去尾点、去 `:端口`，只比大小写 */
function normalizeHost(raw: string): string {
  return raw.trim().replace(/\.$/, '').replace(/:\d+$/, '').toLowerCase();
}

/** 与 TailscaleProvider.ensureBinary 同序的探测：配置路径 → where → Program Files（不下载） */
export async function detectTailscaleBinary(
  configuredPath: string,
  out: Pick<TailscaleFacts, 'configuredPathMissing'>,
): Promise<string | null> {
  if (configuredPath) {
    if (fs.existsSync(configuredPath)) return configuredPath;
    out.configuredPathMissing = true;
    return null;
  }
  try {
    const { stdout } = await execAsync('where tailscale', { windowsHide: true, timeout: 5000 });
    const first = stdout.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch {
    // where 找不到：继续走标准安装路径
  }
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const standard = path.join(programFiles, 'Tailscale', 'tailscale.exe');
  return fs.existsSync(standard) ? standard : null;
}

async function runTailscaleCli(binary: string, args: string[]): Promise<string> {
  const { stdout } = await execAsync(`"${binary}" ${args.join(' ')}`, {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

// ===== Cloudflare / cpolar：配置态检查（无需外部 CLI 往返） =====

/**
 * Cloudflare：quick 模式什么都不用装（二进制会自动下载），named 模式才有证书与 DNS。
 * exists 注入便于单测（不碰真实文件系统）。
 */
function tunnelItemDetail(config: TunnelConfig, tunnelReady: boolean): string {
  if (!tunnelReady) return '缺少 tunnel id / 凭证文件（向导第二步创建）';
  return config.hostname ? `隧道已创建，域名 ${config.hostname}` : '隧道已创建';
}

export function buildCloudflareItems(
  config: TunnelConfig,
  exists: (p: string) => boolean,
): TunnelPrereqItem[] {
  const binaryCandidates = [config.binaryPath, path.resolve(process.cwd(), 'data', 'cloudflared.exe')].filter(Boolean);
  const hasBinary = binaryCandidates.some((p) => exists(p));
  const items: TunnelPrereqItem[] = [
    {
      id: 'binary',
      label: 'cloudflared 程序',
      state: hasBinary ? 'ok' : 'unknown',
      detail: hasBinary ? '本机已有 cloudflared.exe' : '本机还没有，首次启动会自动下载（约 40MB，需能访问 GitHub）',
      fix: hasBinary ? '' : '若下载失败，页面会给出「手动下载后放到这里」的路径与镜像链接',
      focus: 'binary',
    },
  ];
  if (config.tunnelMode !== 'named') {
    items.push({
      id: 'wizard',
      label: '临时域名（每次重启会变）',
      state: 'ok',
      detail: 'quick 模式无需任何账号，启动后直接给一个 trycloudflare 临时地址',
      fix: '',
      focus: 'wizard',
    });
    return items;
  }
  const certOk = Boolean(config.certFile) && exists(config.certFile);
  const tunnelReady = Boolean(config.tunnelId) && Boolean(config.credentialsFile) && exists(config.credentialsFile);
  items.push(
    {
      id: 'cert',
      label: 'Cloudflare 账号授权证书',
      state: certOk ? 'ok' : 'fail',
      detail: certOk ? '已存在授权证书' : '还没有登录授权证书（命名隧道必需）',
      fix: '点下面的「三步向导」，第一步就是浏览器登录授权',
      focus: 'wizard',
    },
    {
      id: 'tunnel',
      label: '命名隧道与配置文件',
      state: tunnelReady ? 'ok' : 'fail',
      detail: tunnelItemDetail(config, tunnelReady),
      fix: '用「三步向导」第二步创建隧道并下载凭证文件',
      focus: 'wizard',
    },
    {
      id: 'dns',
      label: '域名已指向隧道',
      state: config.hostname ? 'unknown' : 'fail',
      detail: config.hostname ? `已配置域名 ${config.hostname}，但是否解析生效要到 Cloudflare 看` : '还没有填自己的域名',
      fix: '向导第三步会写 DNS；已经在 Cloudflare 手工配过的话直接启动即可',
      focus: 'wizard',
    },
  );
  return items;
}

/** cpolar：免费版也要 authtoken，二进制同样自动下载 */
export function buildCpolarItems(config: TunnelConfig, exists: (p: string) => boolean): TunnelPrereqItem[] {
  const binaryCandidates = [config.binaryPath, path.resolve(process.cwd(), 'data', 'cpolar.exe')].filter(Boolean);
  const hasBinary = binaryCandidates.some((p) => exists(p));
  return [
    {
      id: 'authtoken',
      label: 'cpolar 账号 authtoken',
      state: config.cpolarAuthtoken ? 'ok' : 'fail',
      detail: config.cpolarAuthtoken ? '已填写 authtoken' : '还没有填 authtoken',
      fix: '到 cpolar 官网个人中心复制 authtoken 填到下面的输入框',
      focus: 'authtoken',
    },
    {
      id: 'binary',
      label: 'cpolar 程序',
      state: hasBinary ? 'ok' : 'unknown',
      detail: hasBinary ? '本机已有 cpolar.exe' : '本机还没有，首次启动会自动下载并解压',
      fix: hasBinary ? '' : '下载失败时页面会给出手动下载入口',
      focus: 'binary',
    },
  ];
}

// ===== 对外入口 =====

/**
 * 本地端口连通性探测（只读 connect，不发业务请求）。
 * 为什么值得检查：隧道做的事是「把公网流量转到本机某个端口」，填错端口时隧道会显示「运行中」、
 * 公网地址也正常给出，但访问永远是 502 —— 这是最容易误判成「隧道坏了」的失败模式。
 * 返回 true=有人监听 / false=连不上 / null=端口号本身不合法（交由上层如实降级）。
 */
export function probeLocalPort(port: number, timeoutMs = 800): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function buildLocalPortItem(port: number, listening: boolean | null): TunnelPrereqItem {
  if (listening === null) {
    return {
      id: 'port',
      label: '本地服务端口',
      state: 'unknown',
      detail: `端口设置无效：${port}`,
      fix: '把「本地端口」留空（跟随服务端口）或填 1-65535 之间的数字',
      focus: 'port',
    };
  }
  if (listening) {
    return {
      id: 'port',
      label: '本地服务端口',
      state: 'ok',
      detail: `${port} 端口上有服务在监听`,
      fix: '',
      focus: 'port',
    };
  }
  return {
    id: 'port',
    label: '本地服务端口',
    state: 'fail',
    detail: `${port} 端口上连不上，隧道会把公网请求转给一个不存在的地址`,
    fix: '确认本程序正在运行；若服务端口不是这个值，把「本地端口」改成实际端口或留空跟随服务端口',
    focus: 'port',
  };
}

export interface PrereqIo {
  /** 注入文件系统探测（单测用），默认 fs.existsSync */
  exists?: (p: string) => boolean;
  /** 注入 Tailscale 事实采集（单测用），默认 probeTailscaleFacts */
  probeTailscale?: (config: TunnelConfig) => Promise<TailscaleFacts>;
  /** 注入端口探测（单测用），默认 probeLocalPort */
  probePort?: (port: number) => Promise<boolean>;
  /** 服务实际监听端口；不传时按本项目默认 8787 之外的真实配置由调用方给出 */
  serverPort?: number;
  now?: () => number;
}

/**
 * 按当前 provider 做前置条件自检。
 * 注意用的是**已保存配置**而不是表单瞬时值：自检要回答「照现在这样点启动能不能成」。
 * 路由层传 loadConfig() 的结果 + config.server.port。
 */
export async function checkTunnelPrerequisites(
  config: TunnelConfig,
  io: PrereqIo = {},
): Promise<TunnelPrereqResult> {
  const exists = io.exists ?? ((p: string) => Boolean(p) && fs.existsSync(p));
  const now = io.now ?? Date.now;
  let items: TunnelPrereqItem[];
  if (config.provider === 'tailscale') {
    const probe = io.probeTailscale ?? probeTailscaleFacts;
    items = buildTailscaleItems(await probe(config));
  } else if (config.provider === 'cloudflare') {
    items = buildCloudflareItems(config, exists);
  } else {
    items = buildCpolarItems(config, exists);
  }
  // 端口检查对所有服务商都适用，放在最后：前面几条是「能不能起」，这条是「起了有没有用」
  // port<=0 表示调用方没给出可判定的端口（localPort 留空且未传 serverPort）——
  // 此时不添加这条，免得凭空造出一个「端口 0 无效」的假问题。
  const port = TunnelService.resolvePort(config, io.serverPort ?? 0);
  if (port > 0) {
    const probePort = io.probePort ?? probeLocalPort;
    const valid = port <= 65535;
    const listening = valid ? await probePort(port) : null;
    items = [...items, buildLocalPortItem(port, listening)];
  }
  return {
    provider: config.provider,
    checkedAt: now(),
    items,
    allSatisfied: items.every((i) => i.state === 'ok'),
  };
}
