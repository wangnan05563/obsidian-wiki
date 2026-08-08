/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useTheme } from '../composables/useTheme';
import CognitionIcon from '../components/CognitionIcon.vue';
// 登录页面：Luminous Cognition 主题自适应
// 背景图随主题相位切换：浅色主题（macaron/ecommerce）→ bg-light，深色主题 → bg-dark
// 为什么不用 CSS filter 反色：会破坏 PNG 原画质感，两套图分别由同一渲染脚本生成，色彩精准
const authStore = useAuthStore();
const { currentTheme } = useTheme();
const emit = defineEmits();
function goRegister() {
    emit('switch-to-register');
}
const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');
// 浅色主题清单：与 useTheme.ts 中的视觉分类保持一致
const lightThemes = ['macaron', 'ecommerce'];
// 为什么用 import.meta.env.BASE_URL：vite.config.ts 配置了 base: '/wiki/'，
// 硬编码 '/images/...' 会被浏览器解析为 host 根路径导致 404，必须拼接 base 前缀
const bgImage = computed(() => {
    const isLight = lightThemes.includes(currentTheme.value);
    return isLight
        ? `${import.meta.env.BASE_URL}images/login/bg-light.png`
        : `${import.meta.env.BASE_URL}images/login/bg-dark.png`;
});
async function handleLogin() {
    if (!username.value || !password.value) {
        errorMsg.value = '请输入用户名和密码';
        return;
    }
    loading.value = true;
    errorMsg.value = '';
    const ok = await authStore.login({
        username: username.value,
        password: password.value,
    });
    loading.value = false;
    if (!ok) {
        errorMsg.value = authStore.error || '登录失败';
    }
    // 登录成功由父组件监听 isLoggedIn 切换视图，此处无需处理
}
function handleKeydown(e) {
    if (e.key === 'Enter')
        handleLogin();
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['login-header']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['login-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['login-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['login-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['switch-link']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-page" },
});
const __VLS_0 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    name: "bg-fade",
    mode: "out-in",
}));
const __VLS_2 = __VLS_1({
    name: "bg-fade",
    mode: "out-in",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
    key: (__VLS_ctx.bgImage),
    ...{ class: "login-bg" },
    ...{ style: ({ backgroundImage: `url(${__VLS_ctx.bgImage})` }) },
});
var __VLS_3;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
    ...{ class: "login-scrim" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-card glass-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-header" },
});
/** @type {[typeof CognitionIcon, ]} */ ;
// @ts-ignore
const __VLS_4 = __VLS_asFunctionalComponent(CognitionIcon, new CognitionIcon({
    size: (72),
    floating: true,
}));
const __VLS_5 = __VLS_4({
    size: (72),
    floating: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_4));
__VLS_asFunctionalElement(__VLS_intrinsicElements.h1, __VLS_intrinsicElements.h1)({
    ...{ class: "login-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "login-subtitle" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-form" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-field" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "login-username",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    id: "login-username",
    value: (__VLS_ctx.username),
    type: "text",
    ...{ class: "form-input" },
    placeholder: "请输入用户名",
    disabled: (__VLS_ctx.loading),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-field" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "login-password",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    id: "login-password",
    type: "password",
    ...{ class: "form-input" },
    placeholder: "请输入密码",
    disabled: (__VLS_ctx.loading),
});
(__VLS_ctx.password);
if (__VLS_ctx.errorMsg) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "login-error" },
    });
    (__VLS_ctx.errorMsg);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleLogin) },
    ...{ class: "login-btn" },
    disabled: (__VLS_ctx.loading || !__VLS_ctx.username || !__VLS_ctx.password),
});
(__VLS_ctx.loading ? '登录中...' : '登 录');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-switch" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
    ...{ onClick: (__VLS_ctx.goRegister) },
    ...{ class: "switch-link" },
});
/** @type {__VLS_StyleScopedClasses['login-page']} */ ;
/** @type {__VLS_StyleScopedClasses['login-bg']} */ ;
/** @type {__VLS_StyleScopedClasses['login-scrim']} */ ;
/** @type {__VLS_StyleScopedClasses['login-card']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['login-header']} */ ;
/** @type {__VLS_StyleScopedClasses['login-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['login-subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['login-form']} */ ;
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['login-error']} */ ;
/** @type {__VLS_StyleScopedClasses['login-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['login-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['login-switch']} */ ;
/** @type {__VLS_StyleScopedClasses['switch-link']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            CognitionIcon: CognitionIcon,
            goRegister: goRegister,
            username: username,
            password: password,
            loading: loading,
            errorMsg: errorMsg,
            bgImage: bgImage,
            handleLogin: handleLogin,
            handleKeydown: handleKeydown,
        };
    },
    __typeEmits: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
});
; /* PartiallyEnd: #4569/main.vue */
