/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useTheme } from '../composables/useTheme';
import CognitionIcon from '../components/CognitionIcon.vue';
// 注册页面：Luminous Cognition 主题自适应（视觉语言与 Login.vue 一致）
// 简易机制：仅用户名 + 密码（+ 确认密码）；注册成功后由 auth store 自动登录
const authStore = useAuthStore();
const { currentTheme } = useTheme();
const emit = defineEmits();
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const errorMsg = ref('');
const fieldError = ref('');
// 浅色主题清单：与 useTheme.ts 中的视觉分类保持一致
const lightThemes = ['macaron', 'ecommerce'];
const bgImage = computed(() => {
    const isLight = lightThemes.includes(currentTheme.value);
    return isLight
        ? `${import.meta.env.BASE_URL}images/login/bg-light.png`
        : `${import.meta.env.BASE_URL}images/login/bg-dark.png`;
});
// 提交前前端格式校验（与后端规则一致，提前拦截）
function validate() {
    fieldError.value = '';
    if (!username.value || !password.value) {
        fieldError.value = '请输入用户名和密码';
        return false;
    }
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username.value)) {
        fieldError.value = '用户名须为 3-32 位字母、数字或下划线';
        return false;
    }
    if (password.value.length < 8 || password.value.length > 64) {
        fieldError.value = '密码长度须为 8-64 位';
        return false;
    }
    if (confirmPassword.value && password.value !== confirmPassword.value) {
        fieldError.value = '两次输入的密码不一致';
        return false;
    }
    return true;
}
async function handleRegister() {
    if (!validate())
        return;
    loading.value = true;
    errorMsg.value = '';
    const ok = await authStore.register({
        username: username.value,
        password: password.value,
        confirmPassword: confirmPassword.value || undefined,
    });
    loading.value = false;
    // 注册成功：auth store 已写入 token + user，App.vue 的 isLoggedIn 自动切换为主应用
    if (!ok) {
        errorMsg.value = authStore.error || '注册失败';
    }
}
function goLogin() {
    emit('switch-to-login');
}
function handleKeydown(e) {
    if (e.key === 'Enter')
        handleRegister();
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
    for: "reg-username",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    id: "reg-username",
    value: (__VLS_ctx.username),
    type: "text",
    ...{ class: "form-input" },
    placeholder: "3-32 位字母、数字或下划线",
    disabled: (__VLS_ctx.loading),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-field" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "reg-password",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    id: "reg-password",
    type: "password",
    ...{ class: "form-input" },
    placeholder: "8-64 位",
    disabled: (__VLS_ctx.loading),
});
(__VLS_ctx.password);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-field" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "reg-confirm",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    id: "reg-confirm",
    type: "password",
    ...{ class: "form-input" },
    placeholder: "再次输入密码",
    disabled: (__VLS_ctx.loading),
});
(__VLS_ctx.confirmPassword);
if (__VLS_ctx.fieldError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "login-error" },
    });
    (__VLS_ctx.fieldError);
}
else if (__VLS_ctx.errorMsg) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "login-error" },
    });
    (__VLS_ctx.errorMsg);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleRegister) },
    ...{ class: "login-btn" },
    disabled: (__VLS_ctx.loading || !__VLS_ctx.username || !__VLS_ctx.password),
});
(__VLS_ctx.loading ? '注册中...' : '注 册');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "login-switch" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
    ...{ onClick: (__VLS_ctx.goLogin) },
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
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['login-error']} */ ;
/** @type {__VLS_StyleScopedClasses['login-error']} */ ;
/** @type {__VLS_StyleScopedClasses['login-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['login-switch']} */ ;
/** @type {__VLS_StyleScopedClasses['switch-link']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            CognitionIcon: CognitionIcon,
            username: username,
            password: password,
            confirmPassword: confirmPassword,
            loading: loading,
            errorMsg: errorMsg,
            fieldError: fieldError,
            bgImage: bgImage,
            handleRegister: handleRegister,
            goLogin: goLogin,
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
