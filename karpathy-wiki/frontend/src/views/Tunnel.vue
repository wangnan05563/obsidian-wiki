<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CopyDocument, TopRight, VideoPlay, VideoPause, Link, RefreshRight, Close, Setting, MagicStick, Check, Key, CirclePlus, Connection,
  View, Delete,
} from '@element-plus/icons-vue';
// T01629：统一弹窗（居中对话框 / 遮罩 / 动效规格全站一致）
import AppModal from '../components/AppModal.vue';
import IconActionButton from '../components/IconActionButton.vue';
// T02918：逐字段 dirty 口径抽到 composable，配置中心的 8 个页签共用同一份实现
import { useDirtyFields } from '../composables/useDirtyFields';
// T02476（PRD X8）：自检未跑 / 尚未配置这类空态用统一模板（现状 + 原因 + 一个主按钮）
import StateBlock from '../components/StateBlock.vue';
// T02639：前置条件自检是管理员能力（后端 /tunnel/prerequisites 走 requireAdmin），
// 普通用户既拿不到数据，留一张只会显示 403 的卡片纯属占位，因此整块对其隐藏。
import { usePermission } from '../composables/usePermission';
// T02469：失败原因 → 人话建议、自检三态灯等纯判定逻辑（有单测，见 utils/tunnelDiagnostics.ts）
import {
  buildStartErrorView,
  focusTarget,
  formatCheckedAt,
  prereqTone,
  summarizePrereq,
} from '../utils/tunnelDiagnostics';
import type {
  TunnelStatus,
  TunnelProvider,
  TunnelConfigData,
  TunnelConfigBody,
  TunnelDownloadError,
  TunnelAuthError,
  TunnelPrereqItem,
  TunnelPrereqResult,
  CloudflareLoginStartResult,
  CloudflareLoginStatusResult,
} from '../types';

const { isAdmin } = usePermission();

// ===== 运行状态与配置 =====
const status = ref<TunnelStatus | null>(null);
const config = ref<TunnelConfigData | null>(null);
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const saving = ref(false);

// ===== 表单状态（独立于 config，保存后才同步）=====
const formProvider = ref<'cloudflare' | 'cpolar' | 'tailscale'>('cloudflare');
const formAuthtoken = ref('');
const formPort = ref(0);

// T02912（PRD R-F4 第 3 条）：「自动」复选框只改表达方式——勾选即输入框禁用并显示继承的服务端口，
// 存储侧仍是 localPort=0 这个哨兵（api/src/routes/tunnel.ts 兜底 config.server.port），语义不动。
const portAuto = computed({
  get: () => formPort.value === 0,
  set: (v: boolean) => {
    formPort.value = v ? 0 : config.value?.serverPort ?? 3000;
  },
});
const portHint = computed(() => {
  const port = config.value?.serverPort;
  return portAuto.value
    ? `已勾选自动：继承服务端口 ${port ?? '（读取中…）'}，隧道把公网流量转到本机这个端口`
    : `隧道把公网流量转到本机的这个端口；不确定就勾选「自动」，继承服务端口 ${port ?? ''}`;
});
const formBinaryPath = ref('');
const formAutoStart = ref(false);
const formTunnelMode = ref<'quick' | 'named'>('quick');
// 用户已在下拉框上确认过的服务商：取消切换确认时用它把表单退回原样（T02637）
const formProviderConfirmed = ref<TunnelProvider>('cloudflare');

// ===== 错误状态 =====
// 二进制下载失败时展示手动放置指引
const downloadError = ref<TunnelDownloadError | null>(null);
// Tailscale Funnel 首次授权时展示授权向导
const authError = ref<TunnelAuthError | null>(null);

// ===== 前置条件自检（T02469 / PRD §11 T4）=====
// null = 从未检测过；checkedAt 由后端返回，界面必须显示「几点检测的」
const prereq = ref<TunnelPrereqResult | null>(null);
const prereqLoading = ref(false);
const prereqError = ref('');

// ===== Named Tunnel 向导状态 =====
const wizardVisible = ref(false);
// el-steps 的 active 属性：0=login, 1=create, 2=route-dns
const wizardStep = ref(0);
const loginResult = ref<CloudflareLoginStartResult | null>(null);
const loginStatus = ref<CloudflareLoginStatusResult | null>(null);
const loginPolling = ref(false);
const wizardTunnelName = ref('');
const wizardHostname = ref('');
const creatingTunnel = ref(false);
const routingDns = ref(false);
let loginPollTimer: ReturnType<typeof setInterval> | null = null;

// ===== 运行状态轮询定时器 =====
// 运行中时每 3 秒查询状态（检测子进程崩溃）
let pollTimer: ReturnType<typeof setInterval> | null = null;

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: 'Cloudflare Tunnel',
  cpolar: 'cpolar（国内推荐）',
  tailscale: 'Tailscale Funnel（免费固定地址）',
};

const PROVIDER_DESC: Record<string, string> = {
  cloudflare: '免注册，自动分配 trycloudflare 域名。大陆访问可能不稳定。支持 Named Tunnel 固定域名。',
  cpolar: '国内服务器稳定，需注册账号获取 authtoken。',
  tailscale: '免费固定 ts.net 地址，需预装 Tailscale 并登录。首次启用需浏览器授权。',
};

// ===== 未保存改动（T02637，T02918 统一口径）=====
// 表单是草稿，config 是已落盘的那一份。POST /tunnel/start 只读后端 config.json、不收请求体，
// 所以「表单 ≠ 已保存」这个差值只能由界面说出来——以前靠切换下拉框时顺手写盘抹平，
// 代价是用户没点保存也改了配置。现在「保存配置」是本页唯一的写盘入口。
// authtoken 不回显明文，空串表示不修改：saved 侧固定为空串，因此用户填了才算一项改动。
const tunnelSavedSnapshot = computed(() => {
  const saved = config.value;
  if (!saved) return null;
  return {
    provider: saved.provider,
    tunnelMode: saved.tunnelMode,
    authtoken: '',
    localPort: saved.localPort,
    binaryPath: saved.binaryPath,
    autoStart: saved.autoStart,
  };
});
const tunnelFormSnapshot = computed(() => ({
  provider: formProvider.value,
  tunnelMode: formTunnelMode.value,
  authtoken: formAuthtoken.value,
  localPort: formPort.value,
  binaryPath: formBinaryPath.value,
  autoStart: formAutoStart.value,
}));
const { dirtyFields, isDirty } = useDirtyFields(tunnelSavedSnapshot, tunnelFormSnapshot, {
  provider: 'Provider',
  tunnelMode: '隧道模式',
  authtoken: 'Authtoken',
  localPort: '本地端口',
  binaryPath: '程序路径',
  autoStart: '开机自启',
});
const runningProviderNote = computed(() => {
  if (status.value?.status !== 'running' || !config.value || !isDirty.value) return '';
  const p = status.value.provider;
  return `当前运行的隧道还在跑已保存的 ${PROVIDER_LABELS[p] || p || '未知服务商'}，改动保存后还要停止并重新启动才会生效。`;
});

async function loadStatus() {
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
  } catch (err) {
    // 静默失败：轮询时弹错误会刷屏，仅控制台记录
    console.error('加载隧道状态失败:', err);
  }
}

// ===== 启动失败告警条（T02469 / PRD §11 T1）=====
// 数据源是 status.lastStartError 而不是「本次点击的返回值」：
// 开机自启失败时用户根本没点过按钮，只有常驻状态接口能告诉他「隧道其实没起来」。
const startErrorView = computed(() => {
  const err = status.value?.lastStartError;
  return err ? buildStartErrorView(err) : null;
});

async function runPrereqCheck(opts: { silent?: boolean } = {}) {
  // 非管理员没有这个能力：不发请求，避免每次进页面/保存/启动失败都撞一次 403
  if (!isAdmin.value) {
    prereq.value = null;
    prereqError.value = '';
    prereqLoading.value = false;
    return;
  }
  prereqLoading.value = true;
  if (!opts.silent) prereqError.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/prerequisites`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      // 403 是权限而不是故障：说清「需要管理员」，不要把后端串丢给用户
      if (res.status === 403) {
        prereqError.value = '需要管理员权限才能检测前置条件';
      } else {
        prereqError.value = String(data.detail || `检测失败（HTTP ${res.status}）`);
      }
      return;
    }
    prereq.value = await res.json();
    prereqError.value = '';
  } catch (err) {
    prereqError.value = '检测请求发不出去：' + (err as Error).message;
  } finally {
    prereqLoading.value = false;
  }
}

const prereqSummary = computed(() => summarizePrereq(prereq.value?.items ?? []));
const prereqCheckedAtText = computed(() => formatCheckedAt(prereq.value?.checkedAt ?? 0));
// 自检针对「已保存配置」，用户切换下拉框后旧灯就是上一个服务商的，必须标出来
const prereqProviderStale = computed(
  () => Boolean(prereq.value) && prereq.value!.provider !== formProvider.value,
);

async function dismissStartError() {
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/start-error/clear`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
  } catch (err) {
    ElMessage.error('清除失败提示失败：' + (err as Error).message);
  }
}

// 「去处理」按钮文案（模板里不用 `!` 断言：焦点落点可能为空，取一次更稳）
function gotoLabel(item: TunnelPrereqItem): string {
  return focusTarget(item.focus)?.label ?? '';
}

// 「去处理」：把用户送到能解决这一项的控件上，并高亮一下（找不到控件就只滚动到配置卡片）
async function gotoPrereqFocus(item: TunnelPrereqItem) {
  const target = focusTarget(item.focus);
  const card = document.getElementById('tunnel-config-card');
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!target) return;
  await nextTick();
  const el = document.querySelector(target.selector) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 用内联样式而不是 class：目标是 el-input 的内部 input，父组件 scoped CSS 选择器命不中它，
  // class 写法只会「点了没反应」。内联 boxShadow 一定能生效，也不需要额外样式权限。
  el.style.boxShadow = '0 0 0 2px var(--neon-cyan, #00f5ff)';
  window.setTimeout(() => {
    el.style.boxShadow = '';
  }, 1600);
}

// 告警条上的「查看前置条件」：滚到自检卡片，没检测过就顺手检测一次
async function gotoPrereqPanel() {
  if (!isAdmin.value) return;
  document.getElementById('tunnel-prereq-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!prereq.value && !prereqLoading.value) await runPrereqCheck();
}

async function loadConfig() {
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: TunnelConfigData = await res.json();
    config.value = data;
    formProvider.value = data.provider;
    formPort.value = data.localPort;
    formBinaryPath.value = data.binaryPath;
    formAutoStart.value = data.autoStart;
    formTunnelMode.value = data.tunnelMode;
    // authtoken 不回显明文，表单留空（空串=不修改）
    formAuthtoken.value = '';
    // 表单已与已保存配置对齐，取消切换确认时该回到这里而不是回到更早的值
    formProviderConfirmed.value = data.provider;
  } catch (err) {
    ElMessage.error('加载配置失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

// T02637：脏表单上点启动，既不能默默按旧配置启动（会出现「下拉框选 Tailscale、
// 报错却是 cloudflared 下载失败」这种把用户指向错服务商的失败），也不能替他写盘。
type UnsavedChoice = 'save-and-start' | 'start-as-saved' | 'abort';

async function askUnsavedBeforeStart(): Promise<UnsavedChoice> {
  const saved = config.value;
  const savedLabel = PROVIDER_LABELS[saved?.provider ?? ''] ?? saved?.provider ?? '已保存的服务商';
  try {
    await ElMessageBox.confirm(
      `有 ${dirtyFields.value.length} 项改动还没保存（${dirtyFields.value.join('、')}）。`
      + `启动隧道读的是已保存配置，现在启动会按 ${savedLabel} 建立，用不上这些改动。`,
      '配置未保存',
      {
        confirmButtonText: '保存并启动',
        cancelButtonText: '按已保存配置启动',
        type: 'warning',
        distinguishCancelAndClose: true,
      },
    );
    return 'save-and-start';
  } catch (error_) {
    // cancel = 用户明确按已保存配置启动；close（右上角/ESC）= 不启动
    return error_ === 'cancel' ? 'start-as-saved' : 'abort';
  }
}

/** 启动失败的响应体：下载失败/授权错误走专用 UI，其余作为告警条留存 */
function applyStartFailure(data: Record<string, unknown>): void {
  if (data.errorType === 'binary_download_failed') {
    downloadError.value = data as unknown as TunnelDownloadError;
  }
  if (data.errorType === 'tailscale_funnel_auth') {
    authError.value = data as unknown as TunnelAuthError;
  }
  // T02469：失败原因同时落到 status.lastStartError，页面刷新后告警条依然在
  if (data.lastStartError) {
    const base: TunnelStatus = status.value ?? { status: 'stopped', publicUrl: null, provider: '' };
    status.value = { ...base, lastStartError: data.lastStartError as TunnelStatus['lastStartError'] };
  }
}

async function startTunnel() {
  if (isDirty.value) {
    const choice = await askUnsavedBeforeStart();
    if (choice === 'abort') return;
    // 保存没成功就不要接着启动：那样等于又按旧配置启一次，弹窗里给的承诺落空
    if (choice === 'save-and-start' && !(await saveConfig())) return;
  }
  starting.value = true;
  downloadError.value = null;
  authError.value = null;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      applyStartFailure(data);
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    status.value = data as TunnelStatus;
    ElMessage.success('隧道已启动');
  } catch (err) {
    // 下载失败和授权错误已通过 UI 渲染，这里仅在非这两种情况时弹错误
    if (!downloadError.value && !authError.value) {
      ElMessage.error('启动失败：' + (err as Error).message);
    }
    // 失败后自动跑一次自检：用户此刻最想知道「到底缺哪一步」
    void runPrereqCheck({ silent: true });
  } finally {
    starting.value = false;
  }
}

async function stopTunnel() {
  stopping.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
    ElMessage.success('隧道已停止');
  } catch (err) {
    ElMessage.error('停止失败：' + (err as Error).message);
  } finally {
    stopping.value = false;
  }
}

/** 本页唯一的写盘入口；返回值给「保存并启动」用，失败时不能继续启动 */
async function saveConfig(): Promise<boolean> {
  saving.value = true;
  try {
    const body: TunnelConfigBody = {
      provider: formProvider.value,
      localPort: formPort.value,
      cpolarAuthtoken: formAuthtoken.value,
      binaryPath: formBinaryPath.value,
      autoStart: formAutoStart.value,
      tunnelMode: formTunnelMode.value,
    };
    const res = await apiFetch(`${API_BASE}/tunnel/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success('配置已保存');
    await loadConfig();
    // 自检针对已保存配置：provider / 端口 / 路径任一变化都会让答案过期，重跑一次
    void runPrereqCheck({ silent: true });
    return true;
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message);
    return false;
  } finally {
    saving.value = false;
  }
}

// 丢弃草稿，把表单拉回已保存的那一份
async function revertForm() {
  await loadConfig();
  ElMessage.info('已放弃未保存的改动');
}

// T02637：切换服务商只改表单，不再顺手 saveConfig()——
// 「换一下 Provider 看看说明」不等于「我要把配置改掉」，隐式写盘与「保存配置」按钮语义直接冲突。
// 确认弹窗本身是 PRD R-F4 要求的（换服务商等于换域名，已分享出去的链接会失效），此前一直漏实现。
async function onProviderChange(raw: unknown) {
  const next = String(raw) as TunnelProvider;
  const prev = formProviderConfirmed.value;
  if (next === prev) return;
  const stillRunning = status.value?.status === 'running' ? `当前运行的隧道仍在用 ${PROVIDER_LABELS[prev] || prev}，不会因此中断；要换成新服务商，需保存配置后停止并重新启动。` : '';
  try {
    await ElMessageBox.confirm(
      `切换到 ${PROVIDER_LABELS[next] || next} 会换掉公网地址，已分享出去的链接会失效。`
      + `这一步只是改表单，要点「保存配置」才会写入。${stillRunning}`,
      '切换服务商',
      { confirmButtonText: '继续切换', cancelButtonText: '不切换', type: 'warning' },
    );
  } catch {
    // 用户没同意，下拉框退回原值：不能留下一个「看起来切了但没确认」的表单
    formProvider.value = prev;
    return;
  }
  formProviderConfirmed.value = next;
}

function openUrl() {
  if (status.value?.publicUrl) {
    window.open(status.value.publicUrl, '_blank');
  }
}

async function copyUrl() {
  if (status.value?.publicUrl) {
    try {
      await navigator.clipboard.writeText(status.value.publicUrl);
      ElMessage.success('已复制到剪贴板');
    } catch {
      ElMessage.error('复制失败');
    }
  }
}

// ===== Named Tunnel 向导方法 =====

function openWizard() {
  wizardVisible.value = true;
  wizardStep.value = 0;
  loginResult.value = null;
  loginStatus.value = null;
  wizardTunnelName.value = config.value?.tunnelName || '';
  wizardHostname.value = config.value?.hostname || '';
}

function closeWizard() {
  wizardVisible.value = false;
  stopLoginPolling();
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
  loginPolling.value = false;
}

async function startLogin() {
  loginPolling.value = true;
  loginResult.value = null;
  loginStatus.value = null;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/login`, { method: 'POST' });
    const data: CloudflareLoginStartResult = await res.json();
    loginResult.value = data;
    if (data.status === 'failed') {
      loginPolling.value = false;
      ElMessage.error(data.message);
      return;
    }
    // waiting 状态：启动轮询
    startLoginPolling();
  } catch (err) {
    loginPolling.value = false;
    ElMessage.error('启动授权失败：' + (err as Error).message);
  }
}

function startLoginPolling() {
  stopLoginPolling();
  loginPolling.value = true;
  // 每 2.5s 轮询 login 状态，直到 success 或 failed
  loginPollTimer = setInterval(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/login/status`);
      const data: CloudflareLoginStatusResult = await res.json();
      loginStatus.value = data;
      if (data.status === 'success') {
        stopLoginPolling();
        ElMessage.success('授权成功，cert.pem 已生成');
        wizardStep.value = 1;
      } else if (data.status === 'failed') {
        stopLoginPolling();
        ElMessage.error(data.message);
      }
    } catch (err) {
      console.error('轮询 login 状态失败:', err);
    }
  }, 2500);
}

async function createTunnel() {
  if (!wizardTunnelName.value.trim()) {
    ElMessage.warning('请输入隧道名称');
    return;
  }
  creatingTunnel.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tunnelName: wizardTunnelName.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success(data.message || '隧道创建成功');
    wizardStep.value = 2;
  } catch (err) {
    ElMessage.error('创建隧道失败：' + (err as Error).message);
  } finally {
    creatingTunnel.value = false;
  }
}

async function routeDns() {
  if (!wizardHostname.value.trim()) {
    ElMessage.warning('请输入固定域名');
    return;
  }
  routingDns.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/route-dns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: wizardHostname.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success(data.message || 'DNS 路由配置成功');
    wizardVisible.value = false;
    // 刷新配置：后端已自动切换到 named 模式并持久化 hostname
    await loadConfig();
  } catch (err) {
    ElMessage.error('DNS 路由配置失败：' + (err as Error).message);
  } finally {
    routingDns.value = false;
  }
}

// ===== Named Tunnel 删除（T02913，PRD R-F4 第 4 条另一半）=====
// named 字段此前「只进不出」：绑定后没有任何界面手段解除。删除属于写盘操作，
// 只能由这个按钮显式触发（与 T02637 显式保存语义同源），确认文案必须说明
// 「域名变化会让已分享链接失效」与 CNAME 记录需到 Cloudflare 控制台手工删除。
const deletingTunnel = ref(false);
const namedDeleteError = ref('');

async function deleteNamedTunnel() {
  namedDeleteError.value = '';
  try {
    await ElMessageBox.confirm(
      '将删除 Cloudflare 侧的命名隧道资源，并清空本页保存的固定域名配置（切回快速模式）。\n\n'
      + '域名变化会让已分享出去的固定域名链接永久失效；DNS 的 CNAME 记录需要你之后到 Cloudflare 控制台手工删除（本页代办不了）。\n\n确定删除？',
      '删除固定域名隧道',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 取消/关闭：什么都不做
  }
  deletingTunnel.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/named/delete`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success(data.message || '隧道已删除');
    await Promise.all([loadStatus(), loadConfig()]);
  } catch (err) {
    // 内联告警条而不是静默：失败原因（cloudflared 报错 / DNS 侧无权限）常驻在删除按钮上方
    namedDeleteError.value = (err as Error).message || '删除失败，请重试';
  } finally {
    deletingTunnel.value = false;
  }
}

// ===== Tailscale 授权处理 =====

function openAuthUrl() {
  if (authError.value?.authUrl) {
    window.open(authError.value.authUrl, '_blank');
  }
}

function dismissAuthError() {
  authError.value = null;
}

// 运行中时轮询状态，停止时清除（避免无意义请求）
watch(() => status.value?.status, (newStatus) => {
  if (newStatus === 'running') {
    if (!pollTimer) {
      pollTimer = setInterval(loadStatus, 3000);
    }
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

onMounted(async () => {
  await Promise.all([loadStatus(), loadConfig()]);
  // T02469：进页面即静默自检一次。PRD §11 T4 的痛点是「灯不存在，只能靠启动后的报错猜」，
  // 所以不能等用户去点；silent 保证失败时不弹 toast 打扰，只在自检卡片里给一行原因。
  void runPrereqCheck({ silent: true });
});

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  stopLoginPolling();
});
</script>

<template>
  <div class="tunnel-page">
    <!-- 页面级标题（T01728：与其他视图 head-text 结构对齐，此前直接以「隧道状态」卡片开头缺页头） -->
    <div class="tunnel-head fade-up">
      <div class="head-text">
        <h2 class="head-title grad-text">内网穿透</h2>
        <p class="head-tip">将本地知识库服务通过隧道暴露到公网，支持 Cloudflare / Tailscale</p>
      </div>
    </div>
    <!-- T02721：首载尚无内容时走 StateBlock（与全站首屏一致），不用 v-loading 把整页蒙住 -->
    <StateBlock v-if="loading" state="loading" loading-text="正在读取穿透配置…" />
    <template v-else>
    <!-- 状态卡片 -->
    <div class="glass-card">
      <h2 class="card-title">隧道状态</h2>
      <div class="status-row">
        <div class="status-item">
          <span class="row-label">运行状态</span>
          <el-tag :type="status?.status === 'running' ? 'success' : 'info'" effect="dark">
            {{ status?.status === 'running' ? '运行中' : '已停止' }}
          </el-tag>
        </div>
        <div class="status-item" v-if="status?.provider">
          <span class="row-label">Provider</span>
          <el-tag effect="plain">{{ PROVIDER_LABELS[status.provider] || status.provider }}</el-tag>
        </div>
      </div>
      <div class="url-item" v-if="status?.publicUrl">
        <span class="row-label">公网地址</span>
        <div class="url-box">
          <code class="url-text">{{ status.publicUrl }}</code>
          <div class="url-actions">
            <IconActionButton name="复制" desc="复制公网地址到剪贴板" :icon="CopyDocument" size="small" @click="copyUrl" />
            <IconActionButton name="打开" desc="在新标签页打开公网地址" :icon="TopRight" size="small" variant="primary" @click="openUrl" />
          </div>
        </div>
      </div>
      <div class="actions">
        <!-- 启动/停止按钮带 :disabled；disabled 的原生按钮不触发 mouseover，故外包 span 承载 data-tip 保证悬浮提示仍显示 -->
        <span class="tunnel-action-wrap" data-tip="启动隧道 - 启动内网穿透，将本地知识库服务暴露到公网">
          <el-button
            type="primary"
            :icon="VideoPlay"
            :loading="starting"
            :disabled="status?.status === 'running'"
            @click="startTunnel"
          />
        </span>
        <span class="tunnel-action-wrap" data-tip="停止隧道 - 停止当前穿透隧道，断开公网访问">
          <el-button
            type="danger"
            :icon="VideoPause"
            :loading="stopping"
            :disabled="status?.status !== 'running'"
            @click="stopTunnel"
          />
        </span>
      </div>
    </div>

    <!-- 启动失败内联告警条（T02469 / PRD §11 T1）
         原来只有转瞬即逝的 ElMessage，且开机自启失败时后端只写日志、前端完全静默 →
         用户以为「公网地址一直有效」。这里把原因、建议、时间、入口四件事摆在一起，常驻到用户确认。 -->
    <div class="glass-card start-error-card" v-if="startErrorView && status?.lastStartError" id="tunnel-start-error">
      <el-alert type="error" :closable="false" show-icon>
        <template #title>{{ startErrorView.title }}</template>
        <div class="start-error-detail">{{ status.lastStartError.message }}</div>
        <div class="start-error-advice">{{ startErrorView.advice }}</div>
        <div class="start-error-meta">
          {{ startErrorView.when }}
          <template v-if="status.lastStartError.provider"> · 服务商 {{ PROVIDER_LABELS[status.lastStartError.provider] || status.lastStartError.provider }}</template>
          <template v-if="status.lastStartError.source === 'boot'"> · 来自服务启动时的自动尝试</template>
        </div>
        <div class="start-error-actions">
          <IconActionButton v-if="isAdmin" name="查看前置条件" desc="跳到前置条件自检，逐项看哪一步没满足" :icon="View" size="small" variant="primary" @click="gotoPrereqPanel" />
          <IconActionButton name="重新启动" desc="再试一次启动隧道" :icon="RefreshRight" size="small" @click="startTunnel" />
          <IconActionButton name="知道了" desc="这条提示我已经看过，先不再显示" :icon="Close" size="small" @click="dismissStartError" />
        </div>
      </el-alert>
    </div>

    <!-- 前置条件自检（T02469 / PRD §11 T4）
         替掉原来 Tailscale 那 4 行「需预装 / 请登录 / 启用 MagicDNS / 完成授权」纯文字：
         文字清单不告诉用户「现在到底满没满足」，只能启动后靠报错猜。现在每一项是实测灯 + 事实 + 处理入口。
         T02639：只对管理员展示——后端 /tunnel/prerequisites 是 requireAdmin，普通用户看到这张卡只会是 403 占位。 -->
    <div class="glass-card prereq-card" id="tunnel-prereq-card" v-if="isAdmin">
      <div class="prereq-head">
        <h2 class="card-title">前置条件自检</h2>
        <span class="prereq-meta" v-if="prereqLoading">检测中…</span>
        <span class="prereq-meta" v-else-if="prereqError">检测没跑成</span>
        <span class="prereq-meta" v-else-if="prereq">
          {{ prereqSummary.headline }} · {{ prereqCheckedAtText }}
          <em v-if="prereqProviderStale" class="prereq-stale">（这是 {{ PROVIDER_LABELS[prereq.provider] || prereq.provider }} 的结果）</em>
        </span>
        <span class="prereq-meta" v-else>还没有检测</span>
        <span class="prereq-recheck">
          <IconActionButton name="重新检测" desc="按当前已保存配置重新跑一次前置条件检测" :icon="RefreshRight" size="small" :loading="prereqLoading" @click="runPrereqCheck()" />
        </span>
      </div>
      <div class="prereq-error" v-if="prereqError">{{ prereqError }}</div>
      <ul class="prereq-list" v-if="prereq">
        <li v-for="item in prereq.items" :key="item.id" class="prereq-item" :class="`is-${item.state}`">
          <el-tag :type="prereqTone(item.state).type" size="small" effect="light" :aria-label="prereqTone(item.state).ariaLabel">
            {{ prereqTone(item.state).label }}
          </el-tag>
          <div class="prereq-body">
            <div class="prereq-label">{{ item.label }}</div>
            <div class="prereq-detail">{{ item.detail }}</div>
            <div class="prereq-fix" v-if="item.fix">
              {{ item.fix }}
              <a v-if="item.fixUrl" :href="item.fixUrl" target="_blank" rel="noopener" class="prereq-link">打开页面</a>
            </div>
          </div>
          <button
            v-if="gotoLabel(item)"
            type="button"
            class="prereq-goto"
            :data-tip="'去处理 - ' + gotoLabel(item)"
            @click="gotoPrereqFocus(item)"
          >{{ gotoLabel(item) }}</button>
        </li>
      </ul>
      <StateBlock
        v-else-if="!prereqLoading && !prereqError"
        state="empty"
        empty-title="还没有检测过"
        empty-desc="先跑一次自检，就能逐项看清这台机器缺哪一步，不用启动后靠报错猜"
      >
        <template #action>
          <el-button class="neon-btn" size="small" @click="runPrereqCheck()">现在检测</el-button>
        </template>
      </StateBlock>
    </div>

    <!-- 下载失败指引 -->
    <div class="glass-card" v-if="downloadError">
      <el-alert type="error" :closable="false" show-icon>
        <template #title>二进制下载失败</template>
        <div class="download-error-detail">{{ downloadError.detail }}</div>
        <div class="manual-path">
          请手动下载并放置到：<code>{{ downloadError.manualPath }}</code>
        </div>
        <div class="download-links">
          <a
            v-for="url in downloadError.downloadUrls"
            :key="url"
            :href="url"
            target="_blank"
            class="download-link"
          >{{ url }}</a>
        </div>
      </el-alert>
    </div>

    <!-- Tailscale 授权向导 -->
    <div class="glass-card" v-if="authError">
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>Tailscale Funnel 需要授权</template>
        <div class="auth-detail">{{ authError.detail }}</div>
        <div class="auth-actions">
          <IconActionButton name="打开授权" desc="在浏览器中打开 Tailscale Funnel 授权页面" :icon="Link" size="small" variant="primary" @click="openAuthUrl" />
          <IconActionButton name="重新启动" desc="完成授权后重新启动隧道" :icon="RefreshRight" size="small" @click="startTunnel" />
          <IconActionButton name="取消" desc="关闭此授权错误提示" :icon="Close" size="small" @click="dismissAuthError" />
        </div>
      </el-alert>
    </div>

    <!-- 配置卡片 -->
    <div class="glass-card" id="tunnel-config-card">
      <h2 class="card-title">穿透配置</h2>
      <!-- T02637：改动停在表单里时界面必须说清楚——否则用户会以为下拉框一换配置就改了（旧行为正是这样） -->
      <el-alert
        v-if="isDirty"
        id="tunnel-unsaved"
        type="warning"
        :closable="false"
        show-icon
        class="unsaved-alert"
      >
        <template #title>{{ dirtyFields.length }} 项改动尚未保存（{{ dirtyFields.join('、') }}）</template>
        <div class="unsaved-desc">
          改动还在这个页面里，点「保存配置」才会写入配置并影响下次启动。{{ runningProviderNote }}
        </div>
        <div class="unsaved-actions">
          <IconActionButton name="保存配置" desc="把这些改动写入穿透配置（Provider / 隧道模式 / Authtoken / 开机自启）" :icon="Check" size="small" variant="primary" :loading="saving" @click="saveConfig" />
          <IconActionButton name="放弃修改" desc="丢弃未保存的改动，读回当前已保存的配置" :icon="RefreshRight" size="small" @click="revertForm" />
        </div>
      </el-alert>
      <div class="config-block">
        <!-- Provider 选择 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-provider">Provider</label>
          <div class="row-value">
            <el-select id="tunnel-provider" v-model="formProvider" placeholder="选择穿透服务" @change="onProviderChange">
              <el-option label="Cloudflare Tunnel（免注册）" value="cloudflare" />
              <el-option label="cpolar（国内推荐）" value="cpolar" />
              <el-option label="Tailscale Funnel（免费固定地址）" value="tailscale" />
            </el-select>
            <div class="hint">{{ PROVIDER_DESC[formProvider] }}</div>
            <div class="hint">切换服务商只改这个表单，要点下方「保存配置」才会写入配置。</div>
          </div>
        </div>

        <!-- Cloudflare 模式切换 -->
        <div class="config-row" v-if="formProvider === 'cloudflare'">
          <label class="row-label" for="tunnel-mode">隧道模式</label>
          <div class="row-value">
            <el-radio-group id="tunnel-mode" v-model="formTunnelMode">
              <el-radio value="quick">Quick（临时域名，免注册）</el-radio>
              <el-radio value="named">Named（固定域名，需配置）</el-radio>
            </el-radio-group>
            <div class="hint" v-if="formTunnelMode === 'quick'">
              每次启动分配不同的 trycloudflare 域名，开箱即用
            </div>
            <div class="hint" v-else>
              使用固定域名，需通过向导配置 Cloudflare 账号 + 隧道 + DNS
            </div>
          </div>
        </div>

        <!-- Named Tunnel 配置状态 -->
        <div class="config-row" v-if="formProvider === 'cloudflare' && formTunnelMode === 'named'">
          <span class="row-label">固定域名</span>
          <div class="row-value">
            <div v-if="config?.tunnelId" class="named-config-info">
              <div class="info-line">
                <span class="info-label">隧道 ID：</span>
                <code>{{ config.tunnelId }}</code>
              </div>
              <div class="info-line" v-if="config?.hostname">
                <span class="info-label">固定域名：</span>
                <code>{{ config.hostname }}</code>
              </div>
              <!-- T02913：删除出口。此前 named 字段只进不出，绑定后只能去 CLI 手工删 -->
              <el-alert v-if="namedDeleteError" class="named-config-error" type="error" :closable="true" show-icon @close="namedDeleteError = ''">
                <span>{{ namedDeleteError }}</span>
              </el-alert>
              <div class="named-action-row">
                <IconActionButton name="重新配置" desc="重新运行 Cloudflare Named 隧道配置向导" :icon="Setting" size="small" variant="primary" @click="openWizard" />
                <IconActionButton name="删除隧道" desc="删除 Cloudflare 侧隧道资源并清空固定域名配置（域名会失效，需确认）" :icon="Delete" size="small" variant="danger" :loading="deletingTunnel" @click="deleteNamedTunnel" />
              </div>
            </div>
            <StateBlock
              v-else
              state="empty"
              empty-title="尚未配置固定域名隧道"
              empty-desc="三步即可完成：授权登录 → 创建隧道 → 绑定域名，之后地址不会每次重启都变"
            >
              <template #action>
                <IconActionButton name="配置向导" desc="打开 Cloudflare Named 隧道三步配置向导（授权→创建→绑定域名）" :icon="MagicStick" size="small" variant="primary" @click="openWizard" />
              </template>
            </StateBlock>
          </div>
        </div>

        <!-- cpolar Authtoken -->
        <div class="config-row" v-if="formProvider === 'cpolar'">
          <label class="row-label" for="tunnel-authtoken">Authtoken</label>
          <div class="row-value">
            <el-input
              id="tunnel-authtoken"
              v-model="formAuthtoken"
              type="password"
              show-password
              :placeholder="config?.cpolarAuthtokenConfigured ? '已配置，留空表示不修改' : '请输入 cpolar authtoken'"
            />
          </div>
        </div>

        <!-- Tailscale 前置条件：原来的 4 行纯文字清单已被上方「前置条件自检」取代（T02469），
             这里只留一句指路，避免同一份要求在两处各说一遍、说法还不一致 -->
        <div class="config-row" v-if="formProvider === 'tailscale'">
          <span class="row-label">前置条件</span>
          <div class="row-value">
            <div class="hint">
              Tailscale 需要本机安装并登录客户端，公网地址还依赖管理后台的 MagicDNS 与 Funnel 开关。
              <template v-if="isAdmin">这几项是否已经满足，看上方「前置条件自检」的实测结果，不必先启动再靠报错猜。</template>
              <template v-else>逐项实测需要管理员账户；直接启动即可，缺哪一步时失败提示会说明原因。</template>
            </div>
          </div>
        </div>

        <!-- 本地端口（T02912）：「自动」复选框替代「0 = 自动」的哨兵写法 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-port">本地端口</label>
          <div class="row-value">
            <div class="port-auto-row">
              <el-checkbox v-model="portAuto" data-tip="勾选后自动使用服务端口，不用记端口号">自动</el-checkbox>
              <el-input-number id="tunnel-port" v-model="formPort" :min="0" :max="65535" controls-position="right" :disabled="portAuto" />
            </div>
            <div class="hint">{{ portHint }}</div>
          </div>
        </div>

        <!-- 二进制路径：三个服务商都要能填。
             T02469 起 Tailscale 也显示——此前它被 v-if 排除，导致自检报「配置路径已不存在」时
             用户在页面上根本没有地方改，只能去翻 config.json（等于给了灯没给开关）。 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-binary-path">程序路径</label>
          <div class="row-value">
            <el-input
              id="tunnel-binary-path"
              v-model="formBinaryPath"
              :placeholder="formProvider === 'tailscale' ? '留空自动探测（PATH → C:\\Program Files\\Tailscale）' : '留空则自动下载到 data/ 目录'"
            />
            <div class="hint" v-if="formProvider === 'tailscale'">
              Tailscale 由你自己安装，本程序不会替你装；探测不到时填 tailscale.exe 的完整路径
            </div>
          </div>
        </div>

        <!-- 开机自启 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-auto-start">开机自启</label>
          <div class="row-value">
            <el-switch id="tunnel-auto-start" v-model="formAutoStart" />
            <span class="hint">服务启动时自动建立隧道</span>
          </div>
        </div>
      </div>
      <div class="actions">
        <IconActionButton name="保存配置" desc="持久化穿透配置（Provider / 隧道模式 / Authtoken / 开机自启）" :icon="Check" variant="primary" :loading="saving" @click="saveConfig" />
      </div>
    </div>

    <!-- Named Tunnel 配置向导 -->
    <AppModal
      v-model="wizardVisible"
      title="Cloudflare Named Tunnel 配置向导"
      width="600px"
      @close="closeWizard"
    >
      <el-steps :active="wizardStep" finish-status="success" align-center>
        <el-step title="授权登录" />
        <el-step title="创建隧道" />
        <el-step title="配置 DNS" />
      </el-steps>

      <!-- Step 0: 授权登录 -->
      <div class="wizard-step-content" v-if="wizardStep === 0">
        <div class="wizard-desc">
          点击"开始授权"后，cloudflared 会启动 OAuth 流程。在浏览器中完成 Cloudflare 账号授权后，系统会自动检测 cert.pem 生成并进入下一步。
        </div>
        <div class="wizard-actions">
          <IconActionButton name="授权登录" desc="打开 Cloudflare OAuth 授权登录流程" :icon="Key" variant="primary" :loading="loginPolling" @click="startLogin" />
        </div>
        <div class="wizard-login-status" v-if="loginResult">
          <el-alert
            :type="loginResult.status === 'failed' ? 'error' : 'info'"
            :closable="false"
            show-icon
          >
            <template #title>{{ loginResult.message }}</template>
            <div v-if="loginResult.authUrl" class="auth-url-box">
              <a :href="loginResult.authUrl" target="_blank" class="auth-url-link">{{ loginResult.authUrl }}</a>
            </div>
            <div v-if="loginResult.output" class="login-output">
              <pre>{{ loginResult.output }}</pre>
            </div>
          </el-alert>
        </div>
        <div class="wizard-login-status" v-if="loginStatus && loginPolling">
          <el-alert type="info" :closable="false" show-icon>
            <template #title>{{ loginStatus.message }}</template>
            <StateBlock state="loading" compact loading-text="正在等待授权完成…" />
          </el-alert>
        </div>
      </div>

      <!-- Step 1: 创建隧道 -->
      <div class="wizard-step-content" v-if="wizardStep === 1">
        <div class="wizard-desc">
          输入一个隧道名称（如 my-wiki-tunnel），系统会创建命名隧道并生成 credentials 文件。
        </div>
        <el-input
          v-model="wizardTunnelName"
          placeholder="隧道名称（字母、数字、连字符）"
          :disabled="creatingTunnel"
        />
        <div class="wizard-actions">
          <IconActionButton name="创建隧道" desc="创建命名隧道并生成 credentials 文件" :icon="CirclePlus" variant="primary" :loading="creatingTunnel" @click="createTunnel" />
        </div>
      </div>

      <!-- Step 2: 配置 DNS -->
      <div class="wizard-step-content" v-if="wizardStep === 2">
        <div class="wizard-desc">
          输入你要绑定的固定域名（如 wiki.example.com）。该域名的 DNS 必须由 Cloudflare 管理。配置成功后会自动切换到 Named 模式。
        </div>
        <el-input
          v-model="wizardHostname"
          placeholder="固定域名（如 wiki.example.com）"
          :disabled="routingDns"
        />
        <div class="wizard-actions">
          <IconActionButton name="配置DNS" desc="为固定域名配置 Cloudflare DNS 解析并切换到 Named 模式" :icon="Connection" variant="primary" :loading="routingDns" @click="routeDns" />
        </div>
      </div>
    </AppModal>

    <!-- 使用说明 -->
    <div class="glass-card">
      <h2 class="card-title">使用说明</h2>
      <ol class="usage-list">
        <li>选择 Provider：
          <ul>
            <li><b>Cloudflare</b>：免注册即用，Quick 模式开箱即用，Named 模式支持固定域名</li>
            <li><b>cpolar</b>：国内推荐，需注册获取 authtoken</li>
            <li><b>Tailscale</b>：免费固定 ts.net 地址，需预装 Tailscale</li>
          </ul>
        </li>
        <li>如选 cpolar，需到官网注册获取 authtoken 并填入</li>
        <li>如选 Cloudflare Named 模式，点击"开始配置向导"完成三步配置；不再使用时点「删除隧道」回收（已分享的固定域名链接会失效，DNS 的 CNAME 记录需到 Cloudflare 控制台手工删除）</li>
        <li>如选 Tailscale：装好并登录客户端后<template v-if="isAdmin">，用上方面板「前置条件自检」确认四项（安装/登录/MagicDNS/Funnel）是否满足</template>，首次启动还需浏览器授权一次</li>
        <li>本地端口勾选「自动」即使用服务端口，也可取消勾选手动指定</li>
        <li>点击"保存配置"持久化到 config.json</li>
        <li>点击"启动隧道"建立穿透，获得公网 URL</li>
        <li>开机自启开启后，服务启动时自动建立隧道</li>
      </ol>
    </div>
    </template>
  </div>
</template>

<style scoped>
.tunnel-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 页面级标题（T01728）：与 Health/Cleanup 等 head-text 结构同款 */
.tunnel-head {
  padding: 0 4px;
}

.tunnel-head .head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.tunnel-head .head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
}

/* 玻璃态卡片：与项目赛博朋克主题一致 */
.glass-card {
  background: var(--bg-card, rgba(20, 20, 35, 0.6));
  backdrop-filter: blur(12px);
  border: 1px solid var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 8px 32px var(--accent-purple-a20, rgba(0, 0, 0, 0.3));
}

.card-title {
  font-family: var(--font-display, sans-serif);
  font-size: 18px;
  font-weight: 700;
  color: var(--neon-cyan, #00f5ff);
  margin: 0 0 16px 0;
  letter-spacing: 1px;
}

.status-row {
  display: flex;
  gap: 32px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.status-item,
.url-item {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.row-label {
  font-size: 13px;
  color: var(--text-soft, #aaa);
  min-width: 80px;
  font-weight: 600;
}

.url-box {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}

.url-text {
  font-family: var(--font-mono, monospace);
  font-size: 14px;
  color: var(--neon-cyan, #00f5ff);
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  padding: 6px 12px;
  border-radius: 8px;
  word-break: break-all;
}

.url-actions {
  display: flex;
  gap: 8px;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

/* 包裹 disabled 按钮的容器：让图标按钮仍能水平对齐（disabled 原生按钮不触发 mouseover，data-tip 挂在此容器上） */
.tunnel-action-wrap {
  display: inline-flex;
}

/* T02637：未保存提示条紧贴被改动的表单，又不至于把它推走 */
.unsaved-alert {
  margin: 12px 0 20px;
}

.unsaved-desc {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-soft, #ccc);
}

.unsaved-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.config-block {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.config-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.config-row .row-label {
  padding-top: 8px;
  min-width: 100px;
}

.row-value {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hint {
  font-size: 12px;
  color: var(--text-dim, #888);
  line-height: 1.5;
}

/* T02912 「自动」复选框与端口输入同行 */
.port-auto-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.usage-list {
  margin: 0;
  padding-left: 20px;
  color: var(--text-soft, #ccc);
  font-size: 13px;
  line-height: 2;
}

.usage-list ul {
  margin: 4px 0;
  padding-left: 20px;
}

.download-error-detail {
  margin: 8px 0;
}

.manual-path {
  margin: 8px 0;
}

.manual-path code {
  font-family: var(--font-mono, monospace);
  background: var(--accent-pink-a10, rgba(255, 0, 110, 0.1));
  padding: 2px 8px;
  border-radius: 4px;
  color: var(--neon-pink, #ff006e);
  word-break: break-all;
}

.download-links {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.download-link {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--neon-cyan, #00f5ff);
  text-decoration: none;
  word-break: break-all;
}

.download-link:hover {
  text-decoration: underline;
}

/* Tailscale 授权向导 */
.auth-detail {
  margin: 8px 0;
}

.auth-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

/* Named Tunnel 配置信息 */
.named-config-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* T02913 重新配置 + 删除隧道两个操作并排 */
.named-action-row {
  display: flex;
  gap: 12px;
}

.info-line {
  font-size: 13px;
  color: var(--text-soft, #ccc);
}

.info-line code {
  font-family: var(--font-mono, monospace);
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  padding: 2px 8px;
  border-radius: 4px;
  color: var(--neon-cyan, #00f5ff);
  word-break: break-all;
}

/* 向导对话框内容 */
.wizard-step-content {
  padding: 20px 0;
}

.wizard-desc {
  font-size: 13px;
  color: var(--text-soft, #ccc);
  line-height: 1.6;
  margin-bottom: 16px;
}

.wizard-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.wizard-login-status {
  margin-top: 16px;
}

.auth-url-box {
  margin-top: 8px;
}

.auth-url-link {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--neon-cyan, #00f5ff);
  word-break: break-all;
}

.login-output pre {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim, #888);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
}

/* ===== 启动失败内联告警条（T02469 / PRD §11 T1）===== */
.start-error-card {
  border-color: var(--accent-pink-a35, rgba(255, 0, 110, 0.35));
}

.start-error-detail {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-soft, #ccc);
  word-break: break-word;
}

.start-error-advice {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  font-weight: 600;
}

.start-error-meta {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-dim, #888);
}

.start-error-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

/* ===== 前置条件自检（T02469 / PRD §11 T4）===== */
.prereq-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.prereq-head .card-title {
  margin-bottom: 0;
}

.prereq-meta {
  flex: 1;
  min-width: 160px;
  font-size: 12px;
  color: var(--text-dim, #888);
}

.prereq-stale {
  color: var(--neon-pink, #ff006e);
  font-style: normal;
}

.prereq-recheck {
  display: inline-flex;
}

.prereq-error {
  margin-top: 10px;
  font-size: 12px;
  color: var(--neon-pink, #ff006e);
}

.prereq-list {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prereq-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.03);
}

/* 三态不只靠颜色：标签文字（已满足/未满足/待确认）+ 左侧描边双重表达 */
.prereq-item.is-fail {
  border-color: var(--accent-pink-a25, rgba(255, 0, 110, 0.25));
}

.prereq-item.is-unknown {
  border-color: rgba(217, 154, 24, 0.28);
}

.prereq-item.is-ok {
  border-color: rgba(0, 245, 168, 0.2);
}

.prereq-item .el-tag {
  flex: 0 0 auto;
  margin-top: 1px;
}

.prereq-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.prereq-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color, #eee);
}

.prereq-detail {
  font-size: 12px;
  color: var(--text-soft, #bbb);
  word-break: break-all;
}

.prereq-fix {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim, #999);
}

.prereq-link {
  margin-left: 6px;
  color: var(--neon-cyan, #00f5ff);
  text-decoration: none;
  white-space: nowrap;
}

.prereq-link:hover {
  text-decoration: underline;
}

.prereq-goto {
  flex: 0 0 auto;
  align-self: center;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--accent-blue-a35, rgba(21, 84, 209, 0.35));
  background: transparent;
  color: var(--text-soft, #ccc);
  cursor: pointer;
  white-space: nowrap;
}

.prereq-goto:hover {
  background: rgba(21, 84, 209, 0.12);
  color: var(--neon-cyan, #00f5ff);
}

/* 响应式：窄屏配置行堆叠 */
@media (max-width: 768px) {
  .config-row {
    flex-direction: column;
    gap: 8px;
  }
  .config-row .row-label {
    padding-top: 0;
  }
  .prereq-item {
    flex-wrap: wrap;
  }
}
</style>
