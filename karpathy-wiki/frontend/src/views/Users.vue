<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Check, Close, Edit, Delete, Search, Refresh } from '@element-plus/icons-vue';
import AppModal from '../components/AppModal.vue';
import { useAuthStore } from '../stores/auth';
import type { UserInfo, AuthRole, CreateUserRequest } from '../types';
import {
  PASSWORD_RULE,
  SEED_ACCOUNT_HINT,
  SEED_ACCOUNT_NAMES,
  USER_PAGE_SIZE_OPTIONS,
  defaultUserTableQuery,
  deleteConfirmMessage,
  deleteGuard,
  disableGuard,
  filterUsers,
  hasErrors,
  relativeTime,
  absoluteTime,
  roleLabel,
  seedRiskUsers,
  sliceUsers,
  sortUsers,
  validateUserForm,
  type SortOrder,
  type UserSortProp,
} from '../utils/userManagePresentation';

// 用户管理页面：仅管理员可访问
// 功能：用户列表 / 创建用户 / 编辑用户 / 启用禁用 / 删除用户
// UI 风格：与主应用一致（毛玻璃卡片 + 霓虹色系 + status-block 统计区）
// T02473（PRD §13）：确认改 ElMessageBox、删除/停用加守卫、表格换 el-table、
//   表单进 AppModal、按钮带文字、错误用 toast 透传后端原文、列表支持搜索排序分页与相对时间。
//   展示逻辑（守卫/筛选/排序/时间）在 utils/userManagePresentation.ts，由单测覆盖。
const authStore = useAuthStore();

const users = ref<UserInfo[]>([]);
const loading = ref(false);
// 后端不可达 / 权限失败时的常驻说明（与 toast 并存：toast 会消失，页面得留下「为什么是空的」）
const loadError = ref('');

const adminCount = computed(() => users.value.filter(u => u.role === 'admin').length);
const normalCount = computed(() => users.value.filter(u => u.role === 'user' || u.role === 'guest').length);
const enabledCount = computed(() => users.value.filter(u => u.enabled).length);

// 守卫上下文：当前登录账户 + 管理员总数（删除口径）+ 启用管理员数（停用口径）
const protectCtx = computed(() => ({
  currentUserId: authStore.user?.id,
  adminCount: users.value.filter(u => u.role === 'admin').length,
  activeAdminCount: users.value.filter(u => u.role === 'admin' && u.enabled).length,
}));

// ===== 搜索 / 排序 / 分页（U8）=====
const query = ref(defaultUserTableQuery());
const pageNum = ref(1);
const pageSize = ref(20);

const searchedUsers = computed(() => filterUsers(users.value, query.value.keyword));
const sortedUsers = computed(() => sortUsers(searchedUsers.value, query.value.sortProp, query.value.sortOrder));
const pagedRows = computed(() => sliceUsers(sortedUsers.value, pageNum.value, pageSize.value));
const hasFilter = computed(() => query.value.keyword.trim().length > 0);

watch([() => query.value.keyword, pageSize], () => { pageNum.value = 1; });
// 删除/停用后行数变少可能让当前页越界，回退到最后一页而不是显示空表
watch(() => sortedUsers.value.length, (len) => {
  const maxPage = Math.max(1, Math.ceil(len / pageSize.value));
  if (pageNum.value > maxPage) pageNum.value = maxPage;
});

function onSortChange({ prop, order }: { prop: string; order: string | null }) {
  if (!prop || !order) {
    Object.assign(query.value, defaultUserTableQuery());
    return;
  }
  query.value.sortProp = prop as UserSortProp;
  query.value.sortOrder = order as SortOrder;
}

function resetFilters() {
  Object.assign(query.value, defaultUserTableQuery());
}

// ===== U3：出厂种子账号告警 =====
const seedRisks = computed(() => seedRiskUsers(users.value, protectCtx.value));

async function disableSeed(user: UserInfo) {
  const guard = disableGuard(user, protectCtx.value);
  if (guard.blocked) {
    ElMessage.warning(guard.reason);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将停用出厂账号 ${user.username}（${roleLabel(user.role)}）。停用后该账户立即被登出、无法再登录，随时可重新启用。`,
      '确认停用种子账号',
      { confirmButtonText: '停用', cancelButtonText: '保留', type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }
  await authStore.updateUser(user.id, { enabled: false });
  if (authStore.adminError) ElMessage.error(authStore.adminError);
  else ElMessage.success(`已停用 ${user.username}`);
  await loadUsers();
}

async function disableAllSeeds() {
  const targets = seedRisks.value.filter(r => !r.guard.blocked);
  if (targets.length === 0) {
    ElMessage.warning('可停用的种子账号为 0：当前登录账户与唯一启用管理员已被保护，请先在其他账户成为管理员后再处理');
    return;
  }
  const names = targets.map(t => t.user.username).join('、');
  try {
    await ElMessageBox.confirm(
      `将一次性停用 ${targets.length} 个仍启用的出厂账号：${names}。当前登录账户与唯一启用管理员不会被波及。`,
      '批量停用确认',
      { confirmButtonText: '全部停用', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  for (const t of targets) {
    await authStore.updateUser(t.user.id, { enabled: false });
  }
  if (authStore.adminError) ElMessage.error(authStore.adminError);
  else ElMessage.success(`已停用 ${targets.length} 个出厂账号`);
  await loadUsers();
}

async function loadUsers() {
  loading.value = true;
  loadError.value = '';
  authStore.clearAdminError();
  try {
    const list = await authStore.listUsers();
    if (list) {
      users.value = list;
    } else {
      loadError.value = authStore.adminError || '加载用户列表失败';
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

// ===== U5：新建/编辑都用弹窗表单（AppModal），不再在列表里就地展开一行输入 =====
const createVisible = ref(false);
const createForm = ref<CreateUserRequest>({ username: '', password: '', role: 'user' });
const createErrors = ref<{ username?: string; password?: string }>({});
const submitting = ref(false);

function openCreate() {
  createForm.value = { username: '', password: '', role: 'user' };
  createErrors.value = {};
  createVisible.value = true;
}

async function submitCreate() {
  createErrors.value = validateUserForm({
    username: createForm.value.username,
    password: createForm.value.password,
    requirePassword: true,
  });
  if (hasErrors(createErrors.value)) return;
  submitting.value = true;
  const created = await authStore.createUser({
    username: createForm.value.username.trim(),
    password: createForm.value.password,
    role: createForm.value.role,
  });
  submitting.value = false;
  if (created) {
    createVisible.value = false;
    ElMessage.success(`已创建用户 ${created.username}`);
    await loadUsers();
    return;
  }
  // U7：后端 {error} 原文（用户名已存在 / 密码长度不合规则…）直接显示，不再糊成一句「可能已存在」
  const reason = authStore.adminError || '创建用户失败';
  createErrors.value = { username: reason };
  ElMessage.error(reason);
}

const editVisible = ref(false);
const editingUser = ref<UserInfo | null>(null);
const editForm = ref<{ password: string; role: AuthRole; enabled: boolean }>({ password: '', role: 'user', enabled: true });
const editErrors = ref<{ password?: string }>({});

function startEdit(user: UserInfo) {
  editingUser.value = user;
  editForm.value = { password: '', role: user.role, enabled: user.enabled };
  editErrors.value = {};
  editVisible.value = true;
}

// 弹窗里「状态」开关的可改性：按拟提交的角色/状态算守卫，而不是按数据库里的旧值
const editEnableGuard = computed(() => {
  const target = editingUser.value;
  if (!target) return { blocked: false, reason: '' };
  return disableGuard(
    { id: target.id, role: editForm.value.role, enabled: editForm.value.enabled },
    protectCtx.value,
  );
});

async function submitEdit() {
  if (!editingUser.value) return;
  editErrors.value = validateUserForm({ password: editForm.value.password, requirePassword: false });
  if (hasErrors(editErrors.value)) return;
  const updates: { password?: string; role?: AuthRole; enabled?: boolean } = {
    role: editForm.value.role,
    enabled: editForm.value.enabled,
  };
  if (editForm.value.password) updates.password = editForm.value.password;
  // 客户端守卫先行（U2）：把「唯一管理员不能降级/停用」「不能自停用」挡在发请求之前
  if (updates.enabled === false || (updates.role && updates.role !== editingUser.value.role)) {
    const guard = disableGuard(
      { id: editingUser.value.id, role: updates.role ?? editingUser.value.role, enabled: updates.enabled ?? editingUser.value.enabled },
      protectCtx.value,
    );
    if (guard.blocked) {
      ElMessage.warning(guard.reason);
      return;
    }
  }
  submitting.value = true;
  const updated = await authStore.updateUser(editingUser.value.id, updates);
  submitting.value = false;
  if (updated) {
    editVisible.value = false;
    ElMessage.success(`已更新用户 ${updated.username}`);
    await loadUsers();
    return;
  }
  const reason = authStore.adminError || '更新用户失败';
  editErrors.value = { password: reason };
  ElMessage.error(reason);
}

// ===== U1 + U2：删除 =====
function deleteTip(user: UserInfo): string {
  return deleteGuard(user, protectCtx.value).reason;
}

async function handleDelete(user: UserInfo) {
  const guard = deleteGuard(user, protectCtx.value);
  if (guard.blocked) {
    // 按钮已置灰，这里兜底：置灰态被键盘绕过或数据刚变化时仍给出原因
    ElMessage.warning(guard.reason);
    return;
  }
  try {
    await ElMessageBox.confirm(deleteConfirmMessage(user, protectCtx.value), '确认删除用户', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  const ok = await authStore.deleteUser(user.id);
  if (ok) {
    ElMessage.success(`已删除用户 ${user.username}`);
    await loadUsers();
  } else {
    ElMessage.error(authStore.adminError || '删除用户失败');
  }
}

// U2：当前行不可删时按钮置灰并常驻说明（与页面质量清洗页的破坏性按钮口径一致）
function isDeleteBlocked(user: UserInfo): boolean {
  return deleteGuard(user, protectCtx.value).blocked;
}

// 停用被守卫拦下的行，开关直接置灰（只靠 before-change 弹警告的话，用户要点下去才知道不能停，
// 与删除按钮的处理一致：把「不可操作」摆在点之前）；已停用的行仍可启用，不置灰。
function enableSwitchBlocked(user: UserInfo): boolean {
  return user.enabled && disableGuard(user, protectCtx.value).blocked;
}

function enableSwitchTip(user: UserInfo): string {
  if (user.enabled) return disableGuard(user, protectCtx.value).reason;
  return '启用该账户，恢复其登录能力';
}

// 表格里的启用开关：停用是「会把人踢下线」的动作，先过守卫再二次确认（X3 确认策略矩阵）；
// 启用无副作用，直接提交。返回值只决定开关是否本地翻转，最终状态一律以 loadUsers 拉回的数据为准。
async function beforeToggle(user: UserInfo): Promise<boolean> {
  if (!user.enabled) {
    const updated = await authStore.updateUser(user.id, { enabled: true });
    if (!updated) {
      ElMessage.error(authStore.adminError || '启用失败');
      return false;
    }
    ElMessage.success(`已启用 ${user.username}`);
    await loadUsers();
    return true;
  }
  const guard = disableGuard(user, protectCtx.value);
  if (guard.blocked) {
    ElMessage.warning(guard.reason);
    return false;
  }
  try {
    await ElMessageBox.confirm(
      `停用 ${user.username} 后，其登录会话立即失效、无法再登录；随时可重新启用。`,
      '确认停用',
      { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return false;
  }
  const updated = await authStore.updateUser(user.id, { enabled: false });
  if (!updated) {
    ElMessage.error(authStore.adminError || '停用失败');
    return false;
  }
  ElMessage.success(`已停用 ${user.username}`);
  await loadUsers();
  return true;
}

// U8：列表用相对时间，完整时间戳进 tooltip
function timeText(iso?: string): string {
  return relativeTime(iso);
}

function timeTitle(iso?: string): string {
  return absoluteTime(iso);
}

onMounted(loadUsers);
</script>

<template>
  <div class="users-page">
    <div class="glass-card users-card fade-up">
      <div class="card-deco"></div>

      <div class="users-head">
        <div class="head-text">
          <h2 class="head-title grad-text">用户管理</h2>
          <p class="head-tip">用户列表 · 创建 · 编辑 · 启用禁用 · 删除</p>
        </div>
        <div class="head-actions">
          <!-- U6：原来是只有「+」的图标按钮，看不出是干什么的 -->
          <el-button class="neon-btn" :icon="Plus" data-tip="新建用户 - 创建新账户并分配角色" @click="openCreate">新建用户</el-button>
          <el-button class="neon-btn secondary" :icon="Refresh" :loading="loading" data-tip="重新拉取用户列表" @click="loadUsers">刷新</el-button>
        </div>
      </div>

      <!-- 统计区：与缓存与日志清理页 status-grid 一致的 4 列卡片 -->
      <div class="stats-grid">
        <div class="status-block hover-glow">
          <div class="status-title">用户总数</div>
          <div class="status-value">{{ users.length }}</div>
          <div class="status-meta">已注册账户</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">管理员</div>
          <div class="status-value">{{ adminCount }}</div>
          <div class="status-meta">完整权限</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">普通用户</div>
          <div class="status-value">{{ normalCount }}</div>
          <div class="status-meta">常规权限</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">已启用</div>
          <div class="status-value">{{ enabledCount }}</div>
          <div class="status-meta">可登录账户</div>
        </div>
      </div>

      <!-- U3：出厂种子账号仍是启用态 —— 原来只在强制改密里管口令，这里把「账号还开着」摊出来并可一键停用 -->
      <el-alert
        v-if="seedRisks.length > 0"
        class="seed-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`检测到 ${seedRisks.length} 个出厂种子账号仍处于启用状态`"
      >
        <p class="seed-hint">{{ SEED_ACCOUNT_HINT }}</p>
        <ul class="seed-list">
          <li v-for="item in seedRisks" :key="item.user.id">
            <span class="seed-name">{{ item.user.username }}</span>
            <span class="seed-role">{{ roleLabel(item.user.role) }}</span>
            <el-button
              size="small"
              type="warning"
              plain
              :disabled="item.guard.blocked"
              :data-tip="item.guard.reason"
              @click="disableSeed(item.user)"
            >停用</el-button>
            <span v-if="item.guard.blocked" class="seed-blocked">{{ item.guard.reason }}</span>
          </li>
        </ul>
        <el-button
          size="small"
          type="warning"
          :disabled="seedRisks.every((i) => i.guard.blocked)"
          data-tip="一次停用所有未被保护的出厂账号（当前登录账户与唯一启用管理员除外）"
          @click="disableAllSeeds"
        >一键停用可停用的出厂账号</el-button>
      </el-alert>

      <div v-if="loading" class="loading-text">加载中...</div>
      <div v-else-if="loadError" class="error-banner">{{ loadError }}</div>
      <template v-else>
        <!-- U8：搜索 + 命中数（原来 216 行量级同类问题在用户列表上同样存在：无任何筛选手段） -->
        <div v-if="users.length > 0" class="table-tools">
          <el-input
            v-model="query.keyword"
            class="search-input"
            :prefix-icon="Search"
            placeholder="搜索用户名"
            clearable
            aria-label="搜索用户"
            data-tip="按用户名过滤（不区分大小写）"
          />
          <span class="filter-count">筛出 {{ sortedUsers.length }} / {{ users.length }} 个账户</span>
          <el-button v-if="hasFilter" size="small" text data-tip="清空搜索并恢复默认排序" @click="resetFilters">清空筛选</el-button>
        </div>

        <!-- U4：原来是一坨原生 <table>，表头不可排序、无斑马纹，与页面质量清洗页的表格两套样式 -->
        <el-table
          :data="pagedRows"
          row-key="id"
          style="width: 100%"
          stripe
          :default-sort="{ prop: 'username', order: 'ascending' }"
          @sort-change="onSortChange"
        >
          <el-table-column prop="username" label="用户名" min-width="160" sortable="custom" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="user-name">{{ row.username }}</span>
              <el-tag v-if="row.id === authStore.user?.id" size="small" effect="plain" class="row-tag">当前登录</el-tag>
              <el-tag v-else-if="SEED_ACCOUNT_NAMES.includes(row.username)" size="small" type="warning" effect="plain" class="row-tag">出厂账号</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="role" label="角色" width="120" sortable="custom">
            <template #default="{ row }">
              <span class="role-badge" :class="`role-${row.role}`">{{ roleLabel(row.role) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="enabled" label="状态" width="150">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                :title="enableSwitchTip(row)"
                size="small"
                active-text="启用"
                inactive-text="停用"
                :disabled="enableSwitchBlocked(row)"
                :before-change="() => beforeToggle(row)"
              />
            </template>
          </el-table-column>
          <el-table-column prop="createdAt" label="创建时间" min-width="140" sortable="custom">
            <template #default="{ row }">
              <el-tooltip :content="timeTitle(row.createdAt)" placement="top">
                <span class="td-date">{{ timeText(row.createdAt) }}</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column prop="lastLoginAt" label="最后登录" min-width="140" sortable="custom">
            <template #default="{ row }">
              <el-tooltip :content="timeTitle(row.lastLoginAt)" placement="top">
                <span class="td-date">{{ row.lastLoginAt ? timeText(row.lastLoginAt) : '从未登录' }}</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180" align="right">
            <template #default="{ row }">
              <el-button size="small" :icon="Edit" data-tip="编辑 - 修改该用户的角色/状态/密码" @click="startEdit(row)">编辑</el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :icon="Delete"
                :disabled="isDeleteBlocked(row)"
                :data-tip="deleteTip(row)"
                @click="handleDelete(row)"
              >删除</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <span class="table-empty">没有匹配「{{ query.keyword }}」的账户</span>
          </template>
        </el-table>

        <div v-if="users.length > 0" class="table-foot">
          <el-pagination
            v-model:current-page="pageNum"
            v-model:page-size="pageSize"
            :page-sizes="USER_PAGE_SIZE_OPTIONS"
            :total="sortedUsers.length"
            layout="total, sizes, prev, pager, next, jumper"
            background
          />
        </div>
      </template>
    </div>

    <!-- U5：新建用户表单收进统一弹窗（全站弹窗规格见 AppModal） -->
    <AppModal v-model="createVisible" title="新建用户" width="460px">
      <div class="modal-form">
        <div class="form-field">
          <label for="create-username">用户名</label>
          <el-input id="create-username" v-model="createForm.username" :class="{ 'field-error': createErrors.username }" placeholder="3-32 位字母、数字或下划线" data-tip="登录名，创建后不可重复" />
          <span v-if="createErrors.username" class="field-error-text">{{ createErrors.username }}</span>
          <span v-else class="field-hint">用户名 3-32 位字母、数字或下划线</span>
        </div>
        <div class="form-field">
          <label for="create-password">密码</label>
          <!-- U7：原来是裸 input，密码输错看不见；show-password 让设置口令可核对 -->
          <el-input
            id="create-password"
            v-model="createForm.password"
            type="password"
            show-password
            :class="{ 'field-error': createErrors.password }"
            placeholder="8-64 位"
            data-tip="新账户的初始密码，长度 8-64 位"
          />
          <span v-if="createErrors.password" class="field-error-text">{{ createErrors.password }}</span>
          <span v-else class="field-hint">{{ PASSWORD_RULE }}</span>
        </div>
        <div class="form-field">
          <label for="create-role">角色</label>
          <el-select id="create-role" v-model="createForm.role" data-tip="管理员可进用户管理与清理，普通用户只读知识库" style="width:100%">
            <el-option label="管理员" value="admin" />
            <el-option label="普通用户" value="user" />
            <el-option label="游客" value="guest" />
          </el-select>
        </div>
      </div>
      <template #footer>
        <div class="modal-actions">
          <el-button class="neon-btn secondary" :icon="Close" data-tip="取消 - 关闭新建用户表单" @click="createVisible = false">取消</el-button>
          <el-button class="neon-btn" :icon="Check" :loading="submitting" data-tip="创建 - 提交创建新用户" @click="submitCreate">创建</el-button>
        </div>
      </template>
    </AppModal>

    <!-- U5：编辑同样走弹窗，行内展开表单会让表格列宽随输入框跳动 -->
    <AppModal v-model="editVisible" :title="editingUser ? `编辑用户：${editingUser.username}` : '编辑用户'" width="460px">
      <div class="modal-form">
        <div class="form-field">
          <label for="edit-role">角色</label>
          <el-select id="edit-role" v-model="editForm.role" data-tip="改角色会让该用户的权限立即生效（旧会话按新角色重算）" style="width:100%">
            <el-option label="管理员" value="admin" />
            <el-option label="普通用户" value="user" />
            <el-option label="游客" value="guest" />
          </el-select>
        </div>
        <div class="form-field">
          <label for="edit-enabled">状态</label>
          <el-switch
            id="edit-enabled"
            v-model="editForm.enabled"
            active-text="启用"
            inactive-text="停用"
            :disabled="editEnableGuard.blocked"
            :title="editEnableGuard.reason"
          />
        </div>
        <div class="form-field">
          <label for="edit-password">新密码（留空表示不修改）</label>
          <el-input
            id="edit-password"
            v-model="editForm.password"
            type="password"
            show-password
            :class="{ 'field-error': editErrors.password }"
            placeholder="留空则不修改密码"
            data-tip="给该账户重置口令；留空代表只改角色或状态"
          />
          <span v-if="editErrors.password" class="field-error-text">{{ editErrors.password }}</span>
          <span v-else class="field-hint">{{ PASSWORD_RULE }}</span>
        </div>
      </div>
      <template #footer>
        <div class="modal-actions">
          <el-button class="neon-btn secondary" :icon="Close" data-tip="取消 - 放弃编辑该用户" @click="editVisible = false">取消</el-button>
          <el-button class="neon-btn" :icon="Check" :loading="submitting" data-tip="保存 - 保存该用户的角色/状态与密码修改" @click="submitEdit">保存</el-button>
        </div>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.users-page {
  padding: 16px 20px;
  /* 高度填满 .content：侧栏布局后顶部导航与页脚已删除，
     让用户管理页视野延展到页面底部 */
  height: 100%;
  display: flex;
  flex-direction: column;
}

.users-card {
  position: relative;
  overflow: hidden;
  padding: 24px;
  /* flex: 1 让卡片填满 .users-page 剩余高度，
     替代原无高度约束导致内容少时底部留白 */
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 卡片右下角装饰光晕：与缓存与日志清理/页面质量清洗页一致 */
.card-deco {
  position: absolute;
  bottom: -50px;
  right: -40px;
  width: 220px;
  height: 220px;
  background: var(--grad-cool);
  filter: blur(60px);
  opacity: 0.25;
  transform: rotate(18deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.users-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.head-text {
  flex: 1;
}

/* 头部标题：与缓存与日志清理/页面质量清洗页统一字号/字重/字距 */
.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
  font-family: var(--font-mono);
}

.head-actions {
  display: flex;
  gap: 8px;
}

/* 统计区 4 列：与缓存与日志清理页 status-grid 共用同一套样式 token */
.stats-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 24px;
}

.status-block {
  padding: 16px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  transition: all 0.3s ease;
}

.status-title {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

.status-value {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  color: var(--neon-cyan);
  text-shadow: 0 0 12px var(--accent-cyan-a30);
  margin-bottom: 6px;
}

.status-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-soft);
}

.error-banner {
  position: relative;
  z-index: 1;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  border-radius: 8px;
  border: 1px solid var(--accent-pink-a30);
  margin-bottom: 16px;
}

/* U3 种子账号告警：告警里逐条列账户，停用按钮与「为什么不能停」同处一行 */
.seed-alert {
  position: relative;
  z-index: 1;
  margin-bottom: 18px;
}

.seed-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-soft);
}

.seed-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.seed-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.seed-name {
  font-family: var(--font-mono);
  color: var(--text-bright);
}

.seed-role {
  color: var(--text-dim);
}

.seed-blocked {
  color: var(--text-dim);
  font-size: 11px;
}

/* 搜索/筛选条：与页面质量清洗页 table-tools 同款排布 */
.table-tools {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.search-input {
  width: 240px;
}

.filter-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-soft);
}

.table-foot {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.loading-text {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 40px;
  color: var(--text-soft);
  font-size: 13px;
}

.user-name {
  font-family: var(--font-mono);
  color: var(--text-bright);
}

.row-tag {
  margin-left: 6px;
}

.table-empty {
  display: inline-block;
  padding: 12px;
  color: var(--text-soft);
  font-size: 12px;
}

.role-badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
}

.role-admin { color: var(--text-bright); background: var(--neon-magenta); }
.role-user { color: var(--neon-cyan); background: var(--accent-cyan-a10); }
.role-guest { color: var(--text-dim); background: var(--accent-purple-a10); }

.td-date {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
}

/* 弹窗表单：字段纵向排列，错误与提示各占一行（原 form-grid 三列在 460px 弹窗里放不下） */
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-field > label {
  font-size: 12px;
  color: var(--text-soft);
}

.field-hint {
  font-size: 11px;
  color: var(--text-dim);
}

.field-error-text {
  font-size: 11px;
  color: var(--neon-magenta);
}

.field-error :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--neon-magenta) inset;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 霓虹按钮：与缓存与日志清理/页面质量清洗页统一风格 */
.neon-btn {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-body);
  color: #fff;
  background: var(--grad-fire);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 2px 8px var(--accent-pink-a30);
}

.neon-btn:hover { transform: translateY(-1px); }

.neon-btn.secondary {
  color: var(--text-soft);
  background: transparent;
  border: 1px solid var(--accent-purple-a30);
  box-shadow: none;
}

.neon-btn.secondary:hover {
  color: var(--neon-cyan);
  border-color: var(--neon-cyan);
}

@media (max-width: 768px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .table-tools { flex-wrap: wrap; }
  .search-input { width: 100%; }
}
</style>
