<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';
import type { UserInfo, AuthRole, CreateUserRequest } from '../types';

// 用户管理页面：仅管理员可访问
// 功能：用户列表 / 创建用户 / 编辑用户 / 启用禁用 / 删除用户
// UI 风格：与主应用一致（毛玻璃卡片 + 霓虹色系 + status-block 统计区）
const authStore = useAuthStore();

const users = ref<UserInfo[]>([]);
const loading = ref(false);
const errorMsg = ref('');

// 统计指标：与系统清理页 status-grid 一致的 4 列卡片数据源
const adminCount = computed(() => users.value.filter(u => u.role === 'admin').length);
const normalCount = computed(() => users.value.filter(u => u.role === 'user').length);
const enabledCount = computed(() => users.value.filter(u => u.enabled).length);

// 创建用户表单
const showCreateForm = ref(false);
const createForm = ref<CreateUserRequest>({
  username: '',
  password: '',
  role: 'user',
});

// 编辑用户表单
const editingUser = ref<UserInfo | null>(null);
const editForm = ref<{ password?: string; role: AuthRole; enabled: boolean }>({
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
    } else {
      errorMsg.value = '加载用户列表失败';
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
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
  } else {
    errorMsg.value = '创建用户失败（用户名可能已存在）';
  }
}

function startEdit(user: UserInfo) {
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
  if (!editingUser.value) return;
  errorMsg.value = '';
  const updates: { password?: string; role?: AuthRole; enabled?: boolean } = {
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
  } else {
    errorMsg.value = '更新用户失败';
  }
}

async function handleDelete(user: UserInfo) {
  if (user.id === authStore.user?.id) {
    errorMsg.value = '不能删除当前登录用户';
    return;
  }
  if (!confirm(`确认删除用户 ${user.username}？此操作不可撤销。`)) return;
  errorMsg.value = '';
  const ok = await authStore.deleteUser(user.id);
  if (ok) {
    await loadUsers();
  } else {
    errorMsg.value = '删除用户失败';
  }
}

function roleLabel(role: AuthRole): string {
  // S3358: 嵌套三元改为独立 if 返回，便于后续扩展新角色
  if (role === 'admin') return '管理员';
  if (role === 'user') return '普通用户';
  return '游客';
}

function formatDate(s?: string): string {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
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
        <button class="neon-btn" @click="showCreateForm = !showCreateForm">
          {{ showCreateForm ? '取消' : '＋ 新建用户' }}
        </button>
      </div>

      <!-- 统计区：与系统清理页 status-grid 一致的 4 列卡片 -->
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

      <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>

      <!-- 创建用户表单 -->
      <div v-if="showCreateForm" class="form-section">
        <h3 class="section-title">新建用户</h3>
        <div class="form-grid">
          <div class="form-field">
            <label for="create-username">用户名</label>
            <input id="create-username" v-model="createForm.username" type="text" class="form-input" placeholder="用户名" />
          </div>
          <div class="form-field">
            <label for="create-password">密码</label>
            <input id="create-password" v-model="createForm.password" type="password" class="form-input" placeholder="密码" />
          </div>
          <div class="form-field">
            <label for="create-role">角色</label>
            <select id="create-role" v-model="createForm.role" class="form-input">
              <option value="admin">管理员</option>
              <option value="user">普通用户</option>
              <option value="guest">游客</option>
            </select>
          </div>
        </div>
        <div class="form-actions">
          <button class="neon-btn" @click="handleCreate">创建</button>
          <button class="neon-btn secondary" @click="showCreateForm = false">取消</button>
        </div>
      </div>

      <!-- 用户列表 -->
      <div v-if="loading" class="loading-text">加载中...</div>
      <div v-else class="table-section">
        <table class="users-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>最后登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <!-- 编辑模式 -->
              <template v-if="editingUser?.id === u.id">
                <td>{{ u.username }}</td>
                <td>
                  <select v-model="editForm.role" class="inline-input">
                    <option value="admin">管理员</option>
                    <option value="user">普通用户</option>
                    <option value="guest">游客</option>
                  </select>
                </td>
                <td>
                  <label class="checkbox-label">
                    <input v-model="editForm.enabled" type="checkbox" />
                    <span>{{ editForm.enabled ? '启用' : '禁用' }}</span>
                  </label>
                </td>
                <td colspan="2">
                  <input v-model="editForm.password" type="password" class="inline-input" placeholder="新密码（留空不修改）" />
                </td>
                <td>
                  <button class="neon-btn btn-sm" @click="handleSaveEdit">保存</button>
                  <button class="neon-btn secondary btn-sm" @click="cancelEdit">取消</button>
                </td>
              </template>
              <!-- 查看模式 -->
              <template v-else>
                <td>{{ u.username }}</td>
                <td><span class="role-badge" :class="`role-${u.role}`">{{ roleLabel(u.role) }}</span></td>
                <td>
                  <span class="status-dot" :class="u.enabled ? 'status-active' : 'status-disabled'"></span>
                  {{ u.enabled ? '启用' : '禁用' }}
                </td>
                <td class="td-date">{{ formatDate(u.createdAt) }}</td>
                <td class="td-date">{{ formatDate(u.lastLoginAt) }}</td>
                <td>
                  <button class="neon-btn secondary btn-sm" @click="startEdit(u)">编辑</button>
                  <button class="neon-btn danger btn-sm" @click="handleDelete(u)">删除</button>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
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

/* 卡片右下角装饰光晕：与系统清理/数据清洗页一致 */
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

/* 头部标题：与系统清理/数据清洗页统一字号/字重/字距 */
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

/* 统计区 4 列：与系统清理页 status-grid 共用同一套样式 token */
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

/* 表单卡片：与 status-block 同款边框/背景 */
.form-section {
  position: relative;
  z-index: 1;
  padding: 18px 20px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 14px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-field label {
  font-size: 12px;
  color: var(--text-soft);
}

.form-input, .inline-input {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-bright);
  background: var(--bg-glass);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.2s;
}

.form-input:focus, .inline-input:focus {
  border-color: var(--neon-cyan);
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

/* 霓虹按钮：与系统清理/数据清洗页统一风格 */
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

.neon-btn.danger {
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  border: 1px solid var(--accent-pink-a30);
  box-shadow: none;
}

.neon-btn.danger:hover { background: var(--accent-pink-a20); }

.btn-sm { padding: 4px 10px; font-size: 12px; }

.loading-text {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 40px;
  color: var(--text-soft);
  font-size: 13px;
}

/* 表格区：与 status-block 同款边框 */
.table-section {
  position: relative;
  z-index: 1;
  border-radius: var(--radius-card);
  overflow: hidden;
  border: 1px solid var(--accent-purple-a20);
  background: var(--bg-scene);
}

.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-family: var(--font-body);
}

.users-table th {
  padding: 12px 16px;
  text-align: left;
  font-weight: 700;
  color: var(--text-bright);
  background: var(--accent-cyan-a03);
  border-bottom: 1px solid var(--accent-purple-a20);
}

.users-table td {
  padding: 10px 16px;
  color: var(--text-soft);
  border-bottom: 1px solid var(--accent-cyan-a03);
}

.users-table tr:hover td {
  background: var(--accent-cyan-a03);
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

.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 6px;
}

/* 启用/禁用状态点：用主题霓虹色而非硬编码绿/红，跟随主题切换 */
.status-active { background: var(--neon-cyan); box-shadow: 0 0 4px var(--neon-cyan); }
.status-disabled { background: var(--neon-magenta); }

.td-date {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

@media (max-width: 768px) {
  .form-grid { grid-template-columns: 1fr; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
