/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
// ===== 运行状态与配置 =====
const status = ref(null);
const config = ref(null);
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const saving = ref(false);
// ===== 表单状态（独立于 config，保存后才同步）=====
const formProvider = ref('cloudflare');
const formAuthtoken = ref('');
const formPort = ref(0);
const formBinaryPath = ref('');
const formAutoStart = ref(false);
const formTunnelMode = ref('quick');
// ===== 错误状态 =====
// 二进制下载失败时展示手动放置指引
const downloadError = ref(null);
// Tailscale Funnel 首次授权时展示授权向导
const authError = ref(null);
// ===== Named Tunnel 向导状态 =====
const wizardVisible = ref(false);
// el-steps 的 active 属性：0=login, 1=create, 2=route-dns
const wizardStep = ref(0);
const loginResult = ref(null);
const loginStatus = ref(null);
const loginPolling = ref(false);
const wizardTunnelName = ref('');
const wizardHostname = ref('');
const creatingTunnel = ref(false);
const routingDns = ref(false);
let loginPollTimer = null;
// ===== 运行状态轮询定时器 =====
// 运行中时每 3 秒查询状态（检测子进程崩溃）
let pollTimer = null;
const PROVIDER_LABELS = {
    cloudflare: 'Cloudflare Tunnel',
    cpolar: 'cpolar（国内推荐）',
    tailscale: 'Tailscale Funnel（免费固定地址）',
};
const PROVIDER_DESC = {
    cloudflare: '免注册，自动分配 trycloudflare 域名。大陆访问可能不稳定。支持 Named Tunnel 固定域名。',
    cpolar: '国内服务器稳定，需注册账号获取 authtoken。',
    tailscale: '免费固定 ts.net 地址，需预装 Tailscale 并登录。首次启用需浏览器授权。',
};
async function loadStatus() {
    try {
        const res = await fetch(`${API_BASE}/tunnel/status`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        status.value = await res.json();
    }
    catch (err) {
        // 静默失败：轮询时弹错误会刷屏，仅控制台记录
        console.error('加载隧道状态失败:', err);
    }
}
async function loadConfig() {
    try {
        const res = await fetch(`${API_BASE}/tunnel/config`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        config.value = data;
        formProvider.value = data.provider;
        formPort.value = data.localPort;
        formBinaryPath.value = data.binaryPath;
        formAutoStart.value = data.autoStart;
        formTunnelMode.value = data.tunnelMode;
        // authtoken 不回显明文，表单留空（空串=不修改）
        formAuthtoken.value = '';
    }
    catch (err) {
        ElMessage.error('加载配置失败：' + err.message);
    }
    finally {
        loading.value = false;
    }
}
async function startTunnel() {
    starting.value = true;
    downloadError.value = null;
    authError.value = null;
    try {
        const res = await fetch(`${API_BASE}/tunnel/start`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            // 下载失败：渲染手动放置指引而非普通错误提示
            if (data.errorType === 'binary_download_failed') {
                downloadError.value = data;
            }
            // Tailscale 首次授权：渲染授权向导
            if (data.errorType === 'tailscale_funnel_auth') {
                authError.value = data;
            }
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        status.value = data;
        ElMessage.success('隧道已启动');
    }
    catch (err) {
        // 下载失败和授权错误已通过 UI 渲染，这里仅在非这两种情况时弹错误
        if (!downloadError.value && !authError.value) {
            ElMessage.error('启动失败：' + err.message);
        }
    }
    finally {
        starting.value = false;
    }
}
async function stopTunnel() {
    stopping.value = true;
    try {
        const res = await fetch(`${API_BASE}/tunnel/stop`, { method: 'POST' });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        status.value = await res.json();
        ElMessage.success('隧道已停止');
    }
    catch (err) {
        ElMessage.error('停止失败：' + err.message);
    }
    finally {
        stopping.value = false;
    }
}
async function saveConfig() {
    saving.value = true;
    try {
        const body = {
            provider: formProvider.value,
            localPort: formPort.value,
            cpolarAuthtoken: formAuthtoken.value,
            binaryPath: formBinaryPath.value,
            autoStart: formAutoStart.value,
            tunnelMode: formTunnelMode.value,
        };
        const res = await fetch(`${API_BASE}/tunnel/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(data.detail || `HTTP ${res.status}`);
        ElMessage.success('配置已保存');
        await loadConfig();
    }
    catch (err) {
        ElMessage.error('保存失败：' + err.message);
    }
    finally {
        saving.value = false;
    }
}
// 切换 Provider 时自动保存，避免用户以为切换了但后端仍用旧 provider 启动
// 为什么自动保存：provider 是关键配置，切换后必须同步到 config.json，
// 否则点击"启动隧道"时后端读 config.json 会用旧 provider，导致"选 Tailscale 却报 cloudflared 下载失败"
async function onProviderChange() {
    // 隧道运行中切换 provider：先停止当前隧道，避免旧 provider 继续占用
    if (status.value?.status === 'running') {
        try {
            await fetch(`${API_BASE}/tunnel/stop`, { method: 'POST' });
            await loadStatus();
            ElMessage.info('已停止当前隧道，请手动启动新 Provider');
        }
        catch {
            // stop 失败不阻塞保存
        }
    }
    await saveConfig();
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
        }
        catch {
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
        const res = await fetch(`${API_BASE}/tunnel/cloudflare/login`, { method: 'POST' });
        const data = await res.json();
        loginResult.value = data;
        if (data.status === 'failed') {
            loginPolling.value = false;
            ElMessage.error(data.message);
            return;
        }
        // waiting 状态：启动轮询
        startLoginPolling();
    }
    catch (err) {
        loginPolling.value = false;
        ElMessage.error('启动授权失败：' + err.message);
    }
}
function startLoginPolling() {
    stopLoginPolling();
    loginPolling.value = true;
    // 每 2.5s 轮询 login 状态，直到 success 或 failed
    loginPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/tunnel/cloudflare/login/status`);
            const data = await res.json();
            loginStatus.value = data;
            if (data.status === 'success') {
                stopLoginPolling();
                ElMessage.success('授权成功，cert.pem 已生成');
                wizardStep.value = 1;
            }
            else if (data.status === 'failed') {
                stopLoginPolling();
                ElMessage.error(data.message);
            }
        }
        catch (err) {
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
        const res = await fetch(`${API_BASE}/tunnel/cloudflare/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tunnelName: wizardTunnelName.value.trim() }),
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(data.detail || `HTTP ${res.status}`);
        ElMessage.success(data.message || '隧道创建成功');
        wizardStep.value = 2;
    }
    catch (err) {
        ElMessage.error('创建隧道失败：' + err.message);
    }
    finally {
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
        const res = await fetch(`${API_BASE}/tunnel/cloudflare/route-dns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostname: wizardHostname.value.trim() }),
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(data.detail || `HTTP ${res.status}`);
        ElMessage.success(data.message || 'DNS 路由配置成功');
        wizardVisible.value = false;
        // 刷新配置：后端已自动切换到 named 模式并持久化 hostname
        await loadConfig();
    }
    catch (err) {
        ElMessage.error('DNS 路由配置失败：' + err.message);
    }
    finally {
        routingDns.value = false;
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
    }
    else if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
});
onMounted(() => {
    loadStatus();
    loadConfig();
});
onBeforeUnmount(() => {
    if (pollTimer) {
        clearInterval(pollTimer);
    }
    stopLoginPolling();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['usage-list']} */ ;
/** @type {__VLS_StyleScopedClasses['manual-path']} */ ;
/** @type {__VLS_StyleScopedClasses['download-link']} */ ;
/** @type {__VLS_StyleScopedClasses['info-line']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "tunnel-page" },
});
__VLS_asFunctionalDirective(__VLS_directives.vLoading)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.loading) }, null, null);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "card-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-item" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "row-label" },
});
const __VLS_0 = {}.ElTag;
/** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    type: (__VLS_ctx.status?.status === 'running' ? 'success' : 'info'),
    effect: "dark",
}));
const __VLS_2 = __VLS_1({
    type: (__VLS_ctx.status?.status === 'running' ? 'success' : 'info'),
    effect: "dark",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
(__VLS_ctx.status?.status === 'running' ? '运行中' : '已停止');
var __VLS_3;
if (__VLS_ctx.status?.provider) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "status-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "row-label" },
    });
    const __VLS_4 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
        effect: "plain",
    }));
    const __VLS_6 = __VLS_5({
        effect: "plain",
    }, ...__VLS_functionalComponentArgsRest(__VLS_5));
    __VLS_7.slots.default;
    (__VLS_ctx.PROVIDER_LABELS[__VLS_ctx.status.provider] || __VLS_ctx.status.provider);
    var __VLS_7;
}
if (__VLS_ctx.status?.publicUrl) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "row-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-box" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
        ...{ class: "url-text" },
    });
    (__VLS_ctx.status.publicUrl);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-actions" },
    });
    const __VLS_8 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_10 = __VLS_9({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    let __VLS_12;
    let __VLS_13;
    let __VLS_14;
    const __VLS_15 = {
        onClick: (__VLS_ctx.copyUrl)
    };
    __VLS_11.slots.default;
    var __VLS_11;
    const __VLS_16 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        ...{ 'onClick': {} },
        size: "small",
        type: "primary",
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onClick': {} },
        size: "small",
        type: "primary",
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_20;
    let __VLS_21;
    let __VLS_22;
    const __VLS_23 = {
        onClick: (__VLS_ctx.openUrl)
    };
    __VLS_19.slots.default;
    var __VLS_19;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "actions" },
});
const __VLS_24 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
    ...{ 'onClick': {} },
    type: "primary",
    loading: (__VLS_ctx.starting),
    disabled: (__VLS_ctx.status?.status === 'running'),
}));
const __VLS_26 = __VLS_25({
    ...{ 'onClick': {} },
    type: "primary",
    loading: (__VLS_ctx.starting),
    disabled: (__VLS_ctx.status?.status === 'running'),
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
let __VLS_28;
let __VLS_29;
let __VLS_30;
const __VLS_31 = {
    onClick: (__VLS_ctx.startTunnel)
};
__VLS_27.slots.default;
var __VLS_27;
const __VLS_32 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
    ...{ 'onClick': {} },
    type: "danger",
    loading: (__VLS_ctx.stopping),
    disabled: (__VLS_ctx.status?.status !== 'running'),
}));
const __VLS_34 = __VLS_33({
    ...{ 'onClick': {} },
    type: "danger",
    loading: (__VLS_ctx.stopping),
    disabled: (__VLS_ctx.status?.status !== 'running'),
}, ...__VLS_functionalComponentArgsRest(__VLS_33));
let __VLS_36;
let __VLS_37;
let __VLS_38;
const __VLS_39 = {
    onClick: (__VLS_ctx.stopTunnel)
};
__VLS_35.slots.default;
var __VLS_35;
if (__VLS_ctx.downloadError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card" },
    });
    const __VLS_40 = {}.ElAlert;
    /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        type: "error",
        closable: (false),
        showIcon: true,
    }));
    const __VLS_42 = __VLS_41({
        type: "error",
        closable: (false),
        showIcon: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    __VLS_43.slots.default;
    {
        const { title: __VLS_thisSlot } = __VLS_43.slots;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "download-error-detail" },
    });
    (__VLS_ctx.downloadError.detail);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "manual-path" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
    (__VLS_ctx.downloadError.manualPath);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "download-links" },
    });
    for (const [url] of __VLS_getVForSourceType((__VLS_ctx.downloadError.downloadUrls))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
            key: (url),
            href: (url),
            target: "_blank",
            ...{ class: "download-link" },
        });
        (url);
    }
    var __VLS_43;
}
if (__VLS_ctx.authError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card" },
    });
    const __VLS_44 = {}.ElAlert;
    /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        type: "warning",
        closable: (false),
        showIcon: true,
    }));
    const __VLS_46 = __VLS_45({
        type: "warning",
        closable: (false),
        showIcon: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    __VLS_47.slots.default;
    {
        const { title: __VLS_thisSlot } = __VLS_47.slots;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "auth-detail" },
    });
    (__VLS_ctx.authError.detail);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "auth-actions" },
    });
    const __VLS_48 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
        ...{ 'onClick': {} },
        type: "primary",
        size: "small",
    }));
    const __VLS_50 = __VLS_49({
        ...{ 'onClick': {} },
        type: "primary",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    let __VLS_52;
    let __VLS_53;
    let __VLS_54;
    const __VLS_55 = {
        onClick: (__VLS_ctx.openAuthUrl)
    };
    __VLS_51.slots.default;
    var __VLS_51;
    const __VLS_56 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_58 = __VLS_57({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_57));
    let __VLS_60;
    let __VLS_61;
    let __VLS_62;
    const __VLS_63 = {
        onClick: (__VLS_ctx.startTunnel)
    };
    __VLS_59.slots.default;
    var __VLS_59;
    const __VLS_64 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_66 = __VLS_65({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_65));
    let __VLS_68;
    let __VLS_69;
    let __VLS_70;
    const __VLS_71 = {
        onClick: (__VLS_ctx.dismissAuthError)
    };
    __VLS_67.slots.default;
    var __VLS_67;
    var __VLS_47;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "card-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "row-label" },
    for: "tunnel-provider",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "row-value" },
});
const __VLS_72 = {}.ElSelect;
/** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
// @ts-ignore
const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
    ...{ 'onChange': {} },
    id: "tunnel-provider",
    modelValue: (__VLS_ctx.formProvider),
    placeholder: "选择穿透服务",
}));
const __VLS_74 = __VLS_73({
    ...{ 'onChange': {} },
    id: "tunnel-provider",
    modelValue: (__VLS_ctx.formProvider),
    placeholder: "选择穿透服务",
}, ...__VLS_functionalComponentArgsRest(__VLS_73));
let __VLS_76;
let __VLS_77;
let __VLS_78;
const __VLS_79 = {
    onChange: (__VLS_ctx.onProviderChange)
};
__VLS_75.slots.default;
const __VLS_80 = {}.ElOption;
/** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
// @ts-ignore
const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
    label: "Cloudflare Tunnel（免注册）",
    value: "cloudflare",
}));
const __VLS_82 = __VLS_81({
    label: "Cloudflare Tunnel（免注册）",
    value: "cloudflare",
}, ...__VLS_functionalComponentArgsRest(__VLS_81));
const __VLS_84 = {}.ElOption;
/** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
// @ts-ignore
const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
    label: "cpolar（国内推荐）",
    value: "cpolar",
}));
const __VLS_86 = __VLS_85({
    label: "cpolar（国内推荐）",
    value: "cpolar",
}, ...__VLS_functionalComponentArgsRest(__VLS_85));
const __VLS_88 = {}.ElOption;
/** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
// @ts-ignore
const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
    label: "Tailscale Funnel（免费固定地址）",
    value: "tailscale",
}));
const __VLS_90 = __VLS_89({
    label: "Tailscale Funnel（免费固定地址）",
    value: "tailscale",
}, ...__VLS_functionalComponentArgsRest(__VLS_89));
var __VLS_75;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hint" },
});
(__VLS_ctx.PROVIDER_DESC[__VLS_ctx.formProvider]);
if (__VLS_ctx.formProvider === 'cloudflare') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "row-label" },
        for: "tunnel-mode",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "row-value" },
    });
    const __VLS_92 = {}.ElRadioGroup;
    /** @type {[typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, ]} */ ;
    // @ts-ignore
    const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
        id: "tunnel-mode",
        modelValue: (__VLS_ctx.formTunnelMode),
    }));
    const __VLS_94 = __VLS_93({
        id: "tunnel-mode",
        modelValue: (__VLS_ctx.formTunnelMode),
    }, ...__VLS_functionalComponentArgsRest(__VLS_93));
    __VLS_95.slots.default;
    const __VLS_96 = {}.ElRadio;
    /** @type {[typeof __VLS_components.ElRadio, typeof __VLS_components.elRadio, typeof __VLS_components.ElRadio, typeof __VLS_components.elRadio, ]} */ ;
    // @ts-ignore
    const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
        value: "quick",
    }));
    const __VLS_98 = __VLS_97({
        value: "quick",
    }, ...__VLS_functionalComponentArgsRest(__VLS_97));
    __VLS_99.slots.default;
    var __VLS_99;
    const __VLS_100 = {}.ElRadio;
    /** @type {[typeof __VLS_components.ElRadio, typeof __VLS_components.elRadio, typeof __VLS_components.ElRadio, typeof __VLS_components.elRadio, ]} */ ;
    // @ts-ignore
    const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
        value: "named",
    }));
    const __VLS_102 = __VLS_101({
        value: "named",
    }, ...__VLS_functionalComponentArgsRest(__VLS_101));
    __VLS_103.slots.default;
    var __VLS_103;
    var __VLS_95;
    if (__VLS_ctx.formTunnelMode === 'quick') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "hint" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "hint" },
        });
    }
}
if (__VLS_ctx.formProvider === 'cloudflare' && __VLS_ctx.formTunnelMode === 'named') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "row-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "row-value" },
    });
    if (__VLS_ctx.config?.tunnelId) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "named-config-info" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "info-line" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "info-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
        (__VLS_ctx.config.tunnelId);
        if (__VLS_ctx.config?.hostname) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "info-line" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "info-label" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (__VLS_ctx.config.hostname);
        }
        const __VLS_104 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_105 = __VLS_asFunctionalComponent(__VLS_104, new __VLS_104({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
        }));
        const __VLS_106 = __VLS_105({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
        }, ...__VLS_functionalComponentArgsRest(__VLS_105));
        let __VLS_108;
        let __VLS_109;
        let __VLS_110;
        const __VLS_111 = {
            onClick: (__VLS_ctx.openWizard)
        };
        __VLS_107.slots.default;
        var __VLS_107;
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "named-config-empty" },
        });
        const __VLS_112 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_113 = __VLS_asFunctionalComponent(__VLS_112, new __VLS_112({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
        }));
        const __VLS_114 = __VLS_113({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
        }, ...__VLS_functionalComponentArgsRest(__VLS_113));
        let __VLS_116;
        let __VLS_117;
        let __VLS_118;
        const __VLS_119 = {
            onClick: (__VLS_ctx.openWizard)
        };
        __VLS_115.slots.default;
        var __VLS_115;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "hint" },
        });
    }
}
if (__VLS_ctx.formProvider === 'cpolar') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "row-label" },
        for: "tunnel-authtoken",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "row-value" },
    });
    const __VLS_120 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_121 = __VLS_asFunctionalComponent(__VLS_120, new __VLS_120({
        id: "tunnel-authtoken",
        modelValue: (__VLS_ctx.formAuthtoken),
        type: "password",
        showPassword: true,
        placeholder: (__VLS_ctx.config?.cpolarAuthtokenConfigured ? '已配置，留空表示不修改' : '请输入 cpolar authtoken'),
    }));
    const __VLS_122 = __VLS_121({
        id: "tunnel-authtoken",
        modelValue: (__VLS_ctx.formAuthtoken),
        type: "password",
        showPassword: true,
        placeholder: (__VLS_ctx.config?.cpolarAuthtokenConfigured ? '已配置，留空表示不修改' : '请输入 cpolar authtoken'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_121));
}
if (__VLS_ctx.formProvider === 'tailscale') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "row-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "row-value" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "hint" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
        href: "https://tailscale.com/download/windows",
        target: "_blank",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.br, __VLS_intrinsicElements.br)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.br, __VLS_intrinsicElements.br)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.br, __VLS_intrinsicElements.br)({});
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "row-label" },
    for: "tunnel-port",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "row-value" },
});
const __VLS_124 = {}.ElInputNumber;
/** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
// @ts-ignore
const __VLS_125 = __VLS_asFunctionalComponent(__VLS_124, new __VLS_124({
    id: "tunnel-port",
    modelValue: (__VLS_ctx.formPort),
    min: (0),
    max: (65535),
    controlsPosition: "right",
}));
const __VLS_126 = __VLS_125({
    id: "tunnel-port",
    modelValue: (__VLS_ctx.formPort),
    min: (0),
    max: (65535),
    controlsPosition: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_125));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hint" },
});
if (__VLS_ctx.formProvider !== 'tailscale') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "row-label" },
        for: "tunnel-binary-path",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "row-value" },
    });
    const __VLS_128 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_129 = __VLS_asFunctionalComponent(__VLS_128, new __VLS_128({
        id: "tunnel-binary-path",
        modelValue: (__VLS_ctx.formBinaryPath),
        placeholder: "留空则自动下载到 data/ 目录",
    }));
    const __VLS_130 = __VLS_129({
        id: "tunnel-binary-path",
        modelValue: (__VLS_ctx.formBinaryPath),
        placeholder: "留空则自动下载到 data/ 目录",
    }, ...__VLS_functionalComponentArgsRest(__VLS_129));
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "row-label" },
    for: "tunnel-auto-start",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "row-value" },
});
const __VLS_132 = {}.ElSwitch;
/** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
// @ts-ignore
const __VLS_133 = __VLS_asFunctionalComponent(__VLS_132, new __VLS_132({
    id: "tunnel-auto-start",
    modelValue: (__VLS_ctx.formAutoStart),
}));
const __VLS_134 = __VLS_133({
    id: "tunnel-auto-start",
    modelValue: (__VLS_ctx.formAutoStart),
}, ...__VLS_functionalComponentArgsRest(__VLS_133));
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "actions" },
});
const __VLS_136 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_137 = __VLS_asFunctionalComponent(__VLS_136, new __VLS_136({
    ...{ 'onClick': {} },
    type: "primary",
    loading: (__VLS_ctx.saving),
}));
const __VLS_138 = __VLS_137({
    ...{ 'onClick': {} },
    type: "primary",
    loading: (__VLS_ctx.saving),
}, ...__VLS_functionalComponentArgsRest(__VLS_137));
let __VLS_140;
let __VLS_141;
let __VLS_142;
const __VLS_143 = {
    onClick: (__VLS_ctx.saveConfig)
};
__VLS_139.slots.default;
var __VLS_139;
const __VLS_144 = {}.ElDialog;
/** @type {[typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, ]} */ ;
// @ts-ignore
const __VLS_145 = __VLS_asFunctionalComponent(__VLS_144, new __VLS_144({
    ...{ 'onClose': {} },
    modelValue: (__VLS_ctx.wizardVisible),
    title: "Cloudflare Named Tunnel 配置向导",
    width: "600px",
    closeOnClickModal: (false),
}));
const __VLS_146 = __VLS_145({
    ...{ 'onClose': {} },
    modelValue: (__VLS_ctx.wizardVisible),
    title: "Cloudflare Named Tunnel 配置向导",
    width: "600px",
    closeOnClickModal: (false),
}, ...__VLS_functionalComponentArgsRest(__VLS_145));
let __VLS_148;
let __VLS_149;
let __VLS_150;
const __VLS_151 = {
    onClose: (__VLS_ctx.closeWizard)
};
__VLS_147.slots.default;
const __VLS_152 = {}.ElSteps;
/** @type {[typeof __VLS_components.ElSteps, typeof __VLS_components.elSteps, typeof __VLS_components.ElSteps, typeof __VLS_components.elSteps, ]} */ ;
// @ts-ignore
const __VLS_153 = __VLS_asFunctionalComponent(__VLS_152, new __VLS_152({
    active: (__VLS_ctx.wizardStep),
    finishStatus: "success",
    alignCenter: true,
}));
const __VLS_154 = __VLS_153({
    active: (__VLS_ctx.wizardStep),
    finishStatus: "success",
    alignCenter: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_153));
__VLS_155.slots.default;
const __VLS_156 = {}.ElStep;
/** @type {[typeof __VLS_components.ElStep, typeof __VLS_components.elStep, ]} */ ;
// @ts-ignore
const __VLS_157 = __VLS_asFunctionalComponent(__VLS_156, new __VLS_156({
    title: "授权登录",
}));
const __VLS_158 = __VLS_157({
    title: "授权登录",
}, ...__VLS_functionalComponentArgsRest(__VLS_157));
const __VLS_160 = {}.ElStep;
/** @type {[typeof __VLS_components.ElStep, typeof __VLS_components.elStep, ]} */ ;
// @ts-ignore
const __VLS_161 = __VLS_asFunctionalComponent(__VLS_160, new __VLS_160({
    title: "创建隧道",
}));
const __VLS_162 = __VLS_161({
    title: "创建隧道",
}, ...__VLS_functionalComponentArgsRest(__VLS_161));
const __VLS_164 = {}.ElStep;
/** @type {[typeof __VLS_components.ElStep, typeof __VLS_components.elStep, ]} */ ;
// @ts-ignore
const __VLS_165 = __VLS_asFunctionalComponent(__VLS_164, new __VLS_164({
    title: "配置 DNS",
}));
const __VLS_166 = __VLS_165({
    title: "配置 DNS",
}, ...__VLS_functionalComponentArgsRest(__VLS_165));
var __VLS_155;
if (__VLS_ctx.wizardStep === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-step-content" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-desc" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-actions" },
    });
    const __VLS_168 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_169 = __VLS_asFunctionalComponent(__VLS_168, new __VLS_168({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loginPolling),
    }));
    const __VLS_170 = __VLS_169({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loginPolling),
    }, ...__VLS_functionalComponentArgsRest(__VLS_169));
    let __VLS_172;
    let __VLS_173;
    let __VLS_174;
    const __VLS_175 = {
        onClick: (__VLS_ctx.startLogin)
    };
    __VLS_171.slots.default;
    (__VLS_ctx.loginResult ? '重新授权' : '开始授权');
    var __VLS_171;
    if (__VLS_ctx.loginResult) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "wizard-login-status" },
        });
        const __VLS_176 = {}.ElAlert;
        /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
        // @ts-ignore
        const __VLS_177 = __VLS_asFunctionalComponent(__VLS_176, new __VLS_176({
            type: (__VLS_ctx.loginResult.status === 'failed' ? 'error' : 'info'),
            closable: (false),
            showIcon: true,
        }));
        const __VLS_178 = __VLS_177({
            type: (__VLS_ctx.loginResult.status === 'failed' ? 'error' : 'info'),
            closable: (false),
            showIcon: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_177));
        __VLS_179.slots.default;
        {
            const { title: __VLS_thisSlot } = __VLS_179.slots;
            (__VLS_ctx.loginResult.message);
        }
        if (__VLS_ctx.loginResult.authUrl) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "auth-url-box" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
                href: (__VLS_ctx.loginResult.authUrl),
                target: "_blank",
                ...{ class: "auth-url-link" },
            });
            (__VLS_ctx.loginResult.authUrl);
        }
        if (__VLS_ctx.loginResult.output) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "login-output" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({});
            (__VLS_ctx.loginResult.output);
        }
        var __VLS_179;
    }
    if (__VLS_ctx.loginStatus && __VLS_ctx.loginPolling) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "wizard-login-status" },
        });
        const __VLS_180 = {}.ElAlert;
        /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
        // @ts-ignore
        const __VLS_181 = __VLS_asFunctionalComponent(__VLS_180, new __VLS_180({
            type: "info",
            closable: (false),
            showIcon: true,
        }));
        const __VLS_182 = __VLS_181({
            type: "info",
            closable: (false),
            showIcon: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_181));
        __VLS_183.slots.default;
        {
            const { title: __VLS_thisSlot } = __VLS_183.slots;
            (__VLS_ctx.loginStatus.message);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "polling-hint" },
        });
        var __VLS_183;
    }
}
if (__VLS_ctx.wizardStep === 1) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-step-content" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-desc" },
    });
    const __VLS_184 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_185 = __VLS_asFunctionalComponent(__VLS_184, new __VLS_184({
        modelValue: (__VLS_ctx.wizardTunnelName),
        placeholder: "隧道名称（字母、数字、连字符）",
        disabled: (__VLS_ctx.creatingTunnel),
    }));
    const __VLS_186 = __VLS_185({
        modelValue: (__VLS_ctx.wizardTunnelName),
        placeholder: "隧道名称（字母、数字、连字符）",
        disabled: (__VLS_ctx.creatingTunnel),
    }, ...__VLS_functionalComponentArgsRest(__VLS_185));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-actions" },
    });
    const __VLS_188 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_189 = __VLS_asFunctionalComponent(__VLS_188, new __VLS_188({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.creatingTunnel),
    }));
    const __VLS_190 = __VLS_189({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.creatingTunnel),
    }, ...__VLS_functionalComponentArgsRest(__VLS_189));
    let __VLS_192;
    let __VLS_193;
    let __VLS_194;
    const __VLS_195 = {
        onClick: (__VLS_ctx.createTunnel)
    };
    __VLS_191.slots.default;
    var __VLS_191;
}
if (__VLS_ctx.wizardStep === 2) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-step-content" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-desc" },
    });
    const __VLS_196 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_197 = __VLS_asFunctionalComponent(__VLS_196, new __VLS_196({
        modelValue: (__VLS_ctx.wizardHostname),
        placeholder: "固定域名（如 wiki.example.com）",
        disabled: (__VLS_ctx.routingDns),
    }));
    const __VLS_198 = __VLS_197({
        modelValue: (__VLS_ctx.wizardHostname),
        placeholder: "固定域名（如 wiki.example.com）",
        disabled: (__VLS_ctx.routingDns),
    }, ...__VLS_functionalComponentArgsRest(__VLS_197));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "wizard-actions" },
    });
    const __VLS_200 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_201 = __VLS_asFunctionalComponent(__VLS_200, new __VLS_200({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.routingDns),
    }));
    const __VLS_202 = __VLS_201({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.routingDns),
    }, ...__VLS_functionalComponentArgsRest(__VLS_201));
    let __VLS_204;
    let __VLS_205;
    let __VLS_206;
    const __VLS_207 = {
        onClick: (__VLS_ctx.routeDns)
    };
    __VLS_203.slots.default;
    var __VLS_203;
}
var __VLS_147;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "card-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.ol, __VLS_intrinsicElements.ol)({
    ...{ class: "usage-list" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({});
/** @type {__VLS_StyleScopedClasses['tunnel-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-row']} */ ;
/** @type {__VLS_StyleScopedClasses['status-item']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['status-item']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['url-item']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['url-box']} */ ;
/** @type {__VLS_StyleScopedClasses['url-text']} */ ;
/** @type {__VLS_StyleScopedClasses['url-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['download-error-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['manual-path']} */ ;
/** @type {__VLS_StyleScopedClasses['download-links']} */ ;
/** @type {__VLS_StyleScopedClasses['download-link']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['auth-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['auth-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-title']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['named-config-info']} */ ;
/** @type {__VLS_StyleScopedClasses['info-line']} */ ;
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
/** @type {__VLS_StyleScopedClasses['info-line']} */ ;
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
/** @type {__VLS_StyleScopedClasses['named-config-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['row-label']} */ ;
/** @type {__VLS_StyleScopedClasses['row-value']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-step-content']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-login-status']} */ ;
/** @type {__VLS_StyleScopedClasses['auth-url-box']} */ ;
/** @type {__VLS_StyleScopedClasses['auth-url-link']} */ ;
/** @type {__VLS_StyleScopedClasses['login-output']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-login-status']} */ ;
/** @type {__VLS_StyleScopedClasses['polling-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-step-content']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-step-content']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-title']} */ ;
/** @type {__VLS_StyleScopedClasses['usage-list']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            status: status,
            config: config,
            loading: loading,
            starting: starting,
            stopping: stopping,
            saving: saving,
            formProvider: formProvider,
            formAuthtoken: formAuthtoken,
            formPort: formPort,
            formBinaryPath: formBinaryPath,
            formAutoStart: formAutoStart,
            formTunnelMode: formTunnelMode,
            downloadError: downloadError,
            authError: authError,
            wizardVisible: wizardVisible,
            wizardStep: wizardStep,
            loginResult: loginResult,
            loginStatus: loginStatus,
            loginPolling: loginPolling,
            wizardTunnelName: wizardTunnelName,
            wizardHostname: wizardHostname,
            creatingTunnel: creatingTunnel,
            routingDns: routingDns,
            PROVIDER_LABELS: PROVIDER_LABELS,
            PROVIDER_DESC: PROVIDER_DESC,
            startTunnel: startTunnel,
            stopTunnel: stopTunnel,
            saveConfig: saveConfig,
            onProviderChange: onProviderChange,
            openUrl: openUrl,
            copyUrl: copyUrl,
            openWizard: openWizard,
            closeWizard: closeWizard,
            startLogin: startLogin,
            createTunnel: createTunnel,
            routeDns: routeDns,
            openAuthUrl: openAuthUrl,
            dismissAuthError: dismissAuthError,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
