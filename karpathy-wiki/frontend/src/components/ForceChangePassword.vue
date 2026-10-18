<script setup lang="ts">
// T02453（PRD A1）：生产环境首登强制改密对话框
// 触发：login/me 返回 mustChangePassword=true（后端按 localOnly 门控，本地调试不弹）
// 约束：不可跳过（无关闭按钮/遮罩/Esc），改密成功才由父组件卸载本组件
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import AppModal from './AppModal.vue';
import { apiFetch, API_BASE } from '../utils/apiBase';

const emit = defineEmits<{ (e: 'changed'): void }>();

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const errorMsg = ref('');

async function handleSubmit() {
  errorMsg.value = '';
  if (!oldPassword.value) {
    errorMsg.value = '请输入当前密码';
    return;
  }
  // 与后端 validateNewPassword 同口径（8-64 位），前端预校验减少无效请求
  if (newPassword.value.length < 8 || newPassword.value.length > 64) {
    errorMsg.value = '新密码长度须为 8-64 位';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    errorMsg.value = '两次输入的新密码不一致';
    return;
  }
  if (newPassword.value === oldPassword.value) {
    errorMsg.value = '新密码不能与当前密码相同';
    return;
  }
  submitting.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      body: JSON.stringify({
        oldPassword: oldPassword.value,
        newPassword: newPassword.value,
        confirmPassword: confirmPassword.value,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok || !data.ok) {
      errorMsg.value = data.message ?? `修改失败（HTTP ${res.status}）`;
      return;
    }
    ElMessage.success('密码修改成功');
    emit('changed');
  } catch {
    errorMsg.value = '网络错误，请重试';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal
    :model-value="true"
    title="为了账户安全，请先修改密码"
    width="440px"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
  >
    <p class="fc-tip">检测到您的账户仍在使用默认口令。生产环境要求首次登录后立即修改，修改完成前无法使用系统。</p>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="当前密码">
        <el-input v-model="oldPassword" type="password" show-password placeholder="请输入当前密码" />
      </el-form-item>
      <el-form-item label="新密码（8-64 位）">
        <el-input v-model="newPassword" type="password" show-password placeholder="请输入新密码" />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input
          v-model="confirmPassword"
          type="password"
          show-password
          placeholder="请再次输入新密码"
          @keyup.enter="handleSubmit"
        />
      </el-form-item>
    </el-form>
    <p v-if="errorMsg" class="fc-error">{{ errorMsg }}</p>
    <template #footer>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">确认修改</el-button>
    </template>
  </AppModal>
</template>

<style scoped>
.fc-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-soft);
  line-height: 1.6;
}

.fc-error {
  margin: 0 0 8px;
  font-size: 12px;
  color: #d03050;
}
</style>
