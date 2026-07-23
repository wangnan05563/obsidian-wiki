<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';
import type { UserInfo, AuthRole, CreateUserRequest } from '../types';

// 用户管理页面：仅管理员可访问
// 功能：用户列表 / 创建用户 / 编辑用户 / 启用禁用 / 删除用户
// UI 风格：与主应用一致（毛玻璃卡片 + 霓虹色系）
const authStore = useAuthStore();

const users = ref<UserInfo[]>([]);
const loading = ref(false);
const errorMsg = ref('');

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
    <header class="page-header">
      <h1 class="page-title">用户管理</h1>
      <button class="btn-primary" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? '取消' : '＋ 新建用户' }}
      </button>
    </header>

    <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>

    <!-- 创建用户表单 -->
    <div v-if="showCreateForm" class="form-card glass-card">
      <h3 class="form-title">新建用户</h3>
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
        <button class="btn-primary" @click="handleCreate">创建</button>
        <button class="btn-ghost" @click="showCreateForm = false">取消</button>
      </div>
    </div>

    <!-- 用户列表 -->
    <div v-if="loading" class="loading-text">加载中...</div>
    <div v-else class="table-card glass-card">
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
                <button class="btn-primary btn-sm" @click="handleSaveEdit">保存</button>
                <button class="btn-ghost btn-sm" @click="cancelEdit">取消</button>
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
                <button class="btn-ghost btn-sm" @click="startEdit(u)">编辑</button>
                <button class="btn-danger btn-sm" @click="handleDelete(u)">删除</button>
              </td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.users-page {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 800;
  color: var(--text-bright);
  margin: 0;
}

.error-banner {
  padding: 10px 14px;
  font-size: 13px;
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  border-radius: 8px;
  border: 1px solid var(--accent-pink-a30);
}

.form-card {
  padding: 20px;
  border-radius: 12px;
  background: var(--bg-glass);
  border: 1px solid var(--accent-purple-a30);
}

.form-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  margin: 0 0 16px;
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
  background: var(--bg-card-solid, rgba(255, 255, 255, 0.05));
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
  margin-top: 12px;
}

.btn-primary, .btn-ghost, .btn-danger {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  color: #fff;
  background: var(--grad-fire);
  box-shadow: 0 2px 8px rgba(255, 0, 110, 0.3);
}

.btn-primary:hover { transform: translateY(-1px); }

.btn-ghost {
  color: var(--text-soft);
  background: transparent;
  border: 1px solid var(--accent-purple-a30);
}

.btn-ghost:hover { color: var(--neon-cyan); border-color: var(--neon-cyan); }

.btn-danger {
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  border: 1px solid var(--accent-pink-a30);
}

.btn-danger:hover { background: var(--accent-pink-a20); }

.btn-sm { padding: 4px 10px; font-size: 12px; }

.loading-text {
  text-align: center;
  padding: 40px;
  color: var(--text-soft);
  font-size: 13px;
}

.table-card {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--accent-purple-a30);
  background: var(--bg-glass);
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
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid var(--accent-purple-a30);
}

.users-table td {
  padding: 10px 16px;
  color: var(--text-soft);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.users-table tr:hover td {
  background: rgba(0, 245, 255, 0.03);
}

.role-badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
}

.role-admin { color: var(--text-bright); background: var(--neon-magenta); }
.role-user { color: var(--neon-cyan); background: rgba(0, 245, 255, 0.1); }
.role-guest { color: var(--text-dim); background: rgba(255, 255, 255, 0.05); }

.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 6px;
}

.status-active { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
.status-disabled { background: #ff6b6b; }

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
}
</style>
