/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';
// 用户管理页面：仅管理员可访问
// 功能：用户列表 / 创建用户 / 编辑用户 / 启用禁用 / 删除用户
// UI 风格：与主应用一致（毛玻璃卡片 + 霓虹色系 + status-block 统计区）
const authStore = useAuthStore();
const users = ref([]);
const loading = ref(false);
const errorMsg = ref('');
// 统计指标：与系统清理页 status-grid 一致的 4 列卡片数据源
const adminCount = computed(() => users.value.filter(u => u.role === 'admin').length);
const normalCount = computed(() => users.value.filter(u => u.role === 'user').length);
const enabledCount = computed(() => users.value.filter(u => u.enabled).length);
// 创建用户表单
const showCreateForm = ref(false);
const createForm = ref({
    username: '',
    password: '',
    role: 'user',
});
// 编辑用户表单
const editingUser = ref(null);
const editForm = ref({
    password: '',
    role: 'user',
    enabled: true,
});
async function loadUsers() {
    loading.value = true;
    errorMsg.value = '';
    try {
        const list = await authStore.listUsers();
        if (list) {
            users.value = list;
        }
        else {
            errorMsg.value = '加载用户列表失败';
        }
    }
    catch (err) {
        errorMsg.value = err instanceof Error ? err.message : String(err);
    }
    finally {
        loading.value = false;
    }
}
async function handleCreate() {
    if (!createForm.value.username || !createForm.value.password) {
        errorMsg.value = '用户名和密码不能为空';
        return;
    }
    errorMsg.value = '';
    const created = await authStore.createUser({
        username: createForm.value.username,
        password: createForm.value.password,
        role: createForm.value.role,
    });
    if (created) {
        showCreateForm.value = false;
        createForm.value = { username: '', password: '', role: 'user' };
        await loadUsers();
    }
    else {
        errorMsg.value = '创建用户失败（用户名可能已存在）';
    }
}
function startEdit(user) {
    editingUser.value = user;
    editForm.value = {
        password: '',
        role: user.role,
        enabled: user.enabled,
    };
}
function cancelEdit() {
    editingUser.value = null;
}
async function handleSaveEdit() {
    if (!editingUser.value)
        return;
    errorMsg.value = '';
    const updates = {
        role: editForm.value.role,
        enabled: editForm.value.enabled,
    };
    if (editForm.value.password) {
        updates.password = editForm.value.password;
    }
    const updated = await authStore.updateUser(editingUser.value.id, updates);
    if (updated) {
        editingUser.value = null;
        await loadUsers();
    }
    else {
        errorMsg.value = '更新用户失败';
    }
}
async function handleDelete(user) {
    if (user.id === authStore.user?.id) {
        errorMsg.value = '不能删除当前登录用户';
        return;
    }
    if (!confirm(`确认删除用户 ${user.username}？此操作不可撤销。`))
        return;
    errorMsg.value = '';
    const ok = await authStore.deleteUser(user.id);
    if (ok) {
        await loadUsers();
    }
    else {
        errorMsg.value = '删除用户失败';
    }
}
function roleLabel(role) {
    // S3358: 嵌套三元改为独立 if 返回，便于后续扩展新角色
    if (role === 'admin')
        return '管理员';
    if (role === 'user')
        return '普通用户';
    return '游客';
}
function formatDate(s) {
    if (!s)
        return '-';
    return new Date(s).toLocaleString('zh-CN', { hour12: false });
}
onMounted(loadUsers);
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['inline-input']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['danger']} */ ;
/** @type {__VLS_StyleScopedClasses['users-table']} */ ;
/** @type {__VLS_StyleScopedClasses['users-table']} */ ;
/** @type {__VLS_StyleScopedClasses['users-table']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-grid']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "users-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card users-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "users-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showCreateForm = !__VLS_ctx.showCreateForm;
        } },
    ...{ class: "neon-btn" },
});
(__VLS_ctx.showCreateForm ? '取消' : '＋ 新建用户');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stats-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.users.length);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.adminCount);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.normalCount);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.enabledCount);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
if (__VLS_ctx.errorMsg) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "error-banner" },
    });
    (__VLS_ctx.errorMsg);
}
if (__VLS_ctx.showCreateForm) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        for: "create-username",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        id: "create-username",
        value: (__VLS_ctx.createForm.username),
        type: "text",
        ...{ class: "form-input" },
        placeholder: "用户名",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        for: "create-password",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        id: "create-password",
        type: "password",
        ...{ class: "form-input" },
        placeholder: "密码",
    });
    (__VLS_ctx.createForm.password);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        for: "create-role",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
        id: "create-role",
        value: (__VLS_ctx.createForm.role),
        ...{ class: "form-input" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "admin",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "user",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "guest",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-actions" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleCreate) },
        ...{ class: "neon-btn" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showCreateForm))
                    return;
                __VLS_ctx.showCreateForm = false;
            } },
        ...{ class: "neon-btn secondary" },
    });
}
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "loading-text" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "table-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.table, __VLS_intrinsicElements.table)({
        ...{ class: "users-table" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
    for (const [u] of __VLS_getVForSourceType((__VLS_ctx.users))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
            key: (u.id),
        });
        if (__VLS_ctx.editingUser?.id === u.id) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            (u.username);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
                value: (__VLS_ctx.editForm.role),
                ...{ class: "inline-input" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
                value: "admin",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
                value: "user",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
                value: "guest",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
                ...{ class: "checkbox-label" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
                type: "checkbox",
            });
            (__VLS_ctx.editForm.enabled);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.editForm.enabled ? '启用' : '禁用');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                colspan: "2",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
                type: "password",
                ...{ class: "inline-input" },
                placeholder: "新密码（留空不修改）",
            });
            (__VLS_ctx.editForm.password);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (__VLS_ctx.handleSaveEdit) },
                ...{ class: "neon-btn btn-sm" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (__VLS_ctx.cancelEdit) },
                ...{ class: "neon-btn secondary btn-sm" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            (u.username);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "role-badge" },
                ...{ class: (`role-${u.role}`) },
            });
            (__VLS_ctx.roleLabel(u.role));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "status-dot" },
                ...{ class: (u.enabled ? 'status-active' : 'status-disabled') },
            });
            (u.enabled ? '启用' : '禁用');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                ...{ class: "td-date" },
            });
            (__VLS_ctx.formatDate(u.createdAt));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                ...{ class: "td-date" },
            });
            (__VLS_ctx.formatDate(u.lastLoginAt));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!!(__VLS_ctx.editingUser?.id === u.id))
                            return;
                        __VLS_ctx.startEdit(u);
                    } },
                ...{ class: "neon-btn secondary btn-sm" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!!(__VLS_ctx.editingUser?.id === u.id))
                            return;
                        __VLS_ctx.handleDelete(u);
                    } },
                ...{ class: "neon-btn danger btn-sm" },
            });
        }
    }
}
/** @type {__VLS_StyleScopedClasses['users-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['users-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['users-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['error-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['form-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-field']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['table-section']} */ ;
/** @type {__VLS_StyleScopedClasses['users-table']} */ ;
/** @type {__VLS_StyleScopedClasses['inline-input']} */ ;
/** @type {__VLS_StyleScopedClasses['checkbox-label']} */ ;
/** @type {__VLS_StyleScopedClasses['inline-input']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['role-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['td-date']} */ ;
/** @type {__VLS_StyleScopedClasses['td-date']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['danger']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            users: users,
            loading: loading,
            errorMsg: errorMsg,
            adminCount: adminCount,
            normalCount: normalCount,
            enabledCount: enabledCount,
            showCreateForm: showCreateForm,
            createForm: createForm,
            editingUser: editingUser,
            editForm: editForm,
            handleCreate: handleCreate,
            startEdit: startEdit,
            cancelEdit: cancelEdit,
            handleSaveEdit: handleSaveEdit,
            handleDelete: handleDelete,
            roleLabel: roleLabel,
            formatDate: formatDate,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
