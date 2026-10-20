<script setup lang="ts">
// T02482（PRD D4x）：「本地数据保护」表单从 Help.vue 迁入配置中心「数据备份」页签。
// ------------------------------------------------------------------
// 迁移原则：行为口径逐字保留，只换位置——
//   - vault 解锁门照旧：cryptoOn 仍由 isUnlocked() 初始化，localLocked 走 conversations store；
//   - 备份口令独立于登录密码（风险 R-2 口径不变），ElMessage 反馈原文一字不改；
//   - 导入成功后仍然 reload 会话列表；
//   - 登录态变化按 owner 隔离重载（原 Help.vue 的 watch，防御与 Query.vue 一致）随表单一起搬来，
//     因为这条 watch 只为这块 UI 服务。
// 帮助页只留说明 + 「前往：配置中心 → 数据备份」直达按钮（T02455 的 jumpTo 机制）。
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useConversationsStore } from '../stores/conversations';
import { useAuthStore } from '../stores/auth';
import { isUnlocked } from '../services/localVault';
import { createBackup, restoreBackup, downloadBackup, readBackupFile } from '../services/backup';

const conversationsStore = useConversationsStore();
const authStore = useAuthStore();

// 登录态变化后重新按 owner 隔离加载会话（与 Query.vue 一致的多账户隔离防御）
watch(
  () => authStore.user?.id,
  async () => {
    try {
      await conversationsStore.loadConversations();
    } catch {
      // 静默降级
    }
  },
);

onMounted(async () => {
  // 同步本地加密状态（FR-RM-07）：若已登录且密钥在内存 / sessionStorage，则视为已开启
  cryptoOn.value = isUnlocked();
});

const cryptoOn = ref(false);
const localLocked = computed(() => conversationsStore.localLocked);

const unlockPwd = ref('');
const exportPwd = ref('');
const importPwd = ref('');
const importFile = ref<File | null>(null);
const busy = ref(false);

async function doUnlock() {
  if (!unlockPwd.value) return;
  try {
    await conversationsStore.unlockLocalData(unlockPwd.value);
    cryptoOn.value = true;
    ElMessage.success('本地数据已解锁');
    unlockPwd.value = '';
  } catch (e) {
    ElMessage.error('解锁失败：' + (e instanceof Error ? e.message : String(e)));
  }
}

async function doExport() {
  if (!exportPwd.value) {
    ElMessage.warning('请先设置备份口令');
    return;
  }
  busy.value = true;
  try {
    const backup = await createBackup(exportPwd.value);
    downloadBackup(backup);
    ElMessage.success('备份已导出（请用安全方式保存该文件）');
    exportPwd.value = '';
  } catch (e) {
    ElMessage.error('导出失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    busy.value = false;
  }
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  importFile.value = input.files?.[0] ?? null;
}

async function doImport() {
  if (!importFile.value) {
    ElMessage.warning('请先选择备份文件');
    return;
  }
  if (!importPwd.value) {
    ElMessage.warning('请输入备份口令');
    return;
  }
  busy.value = true;
  try {
    const backup = await readBackupFile(importFile.value);
    const res = await restoreBackup(backup, importPwd.value);
    ElMessage.success(`导入完成：会话 ${res.conversations} 条、附件 ${res.attachments} 条`);
    importFile.value = null;
    importPwd.value = '';
    await conversationsStore.loadConversations();
  } catch (e) {
    ElMessage.error('导入失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    busy.value = false;
  }
}

// 供测试与调用方感知导出/导入是否在处理中（按钮 disabled 已用同一状态）
defineExpose({ busy });
</script>

<template>
  <div id="local-backup-panel" class="local-backup-panel">
    <div class="panel-intro">
      问答会话与附件仅保存在本地浏览器（IndexedDB）。可开启加密（基于登录密码派生密钥）以防同设备其他进程读取，
      并建议定期导出加密备份以防丢失。本页面只操作<b>当前浏览器</b>的数据，不影响其他设备与服务端。
    </div>

    <div class="panel-block">
      <div class="panel-block-title"><span class="dot feature"></span><span>加密状态</span></div>
      <p class="panel-text">
        本地加密：<b>{{ cryptoOn ? '已开启' : '未启用' }}</b>；
        数据锁定：<b>{{ localLocked ? '已锁定（需解锁）' : '正常' }}</b>。
      </p>
    </div>

    <div v-if="localLocked" class="panel-block">
      <div class="panel-block-title"><span class="dot steps"></span><span>解锁本地数据</span></div>
      <p class="panel-text">
        检测到已加密的本地会话，请输入登录密码解锁以查看历史记录。
      </p>
      <div class="panel-actions">
        <el-input
          v-model="unlockPwd"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="登录密码"
          size="small"
          style="max-width: 240px"
        />
        <el-button size="small" type="primary" data-tip="使用登录密码解锁本地加密数据" :disabled="!unlockPwd" @click="doUnlock">解锁</el-button>
      </div>
    </div>

    <div class="panel-block">
      <div class="panel-block-title"><span class="dot scenario"></span><span>导出备份</span></div>
      <p class="panel-text note-warning">
        风险 R-2：清除缓存 / 换设备 / 重装会导致本地数据丢失。请定期导出加密备份；
        备份使用<b>独立口令</b>，即使遗忘登录密码也可凭备份口令恢复本地数据。
      </p>
      <div class="panel-actions">
        <el-input
          v-model="exportPwd"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="备份口令"
          size="small"
          style="max-width: 240px"
        />
        <el-button size="small" type="primary" data-tip="导出加密备份文件（使用独立备份口令，换设备可凭此恢复）" :disabled="!exportPwd || busy" @click="doExport">导出</el-button>
      </div>
    </div>

    <div class="panel-block">
      <div class="panel-block-title"><span class="dot config"></span><span>导入备份</span></div>
      <p class="panel-text">
        从备份文件恢复会话与附件（合并写入本地）。导入前请输入备份时设置的口令。
      </p>
      <div class="panel-actions">
        <input type="file" accept="application/json,.json" @change="onFileChange" />
        <el-input
          v-model="importPwd"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="备份口令"
          size="small"
          style="max-width: 240px"
        />
        <el-button size="small" type="primary" data-tip="从备份文件恢复会话与附件（合并写入本地，需备份口令）" :disabled="!importFile || !importPwd || busy" @click="doImport">
          导入
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.local-backup-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.panel-intro {
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-soft);
}
.panel-block {
  border-left: 2px solid rgba(34, 211, 238, 0.35);
  padding-left: 14px;
}
.panel-block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot.feature { background: var(--neon-cyan); }
.dot.steps { background: var(--neon-purple); }
.dot.scenario { background: #f59e0b; }
.dot.config { background: #10b981; }
.panel-text {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-soft);
}
.note-warning {
  color: #d97706;
}
.panel-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.panel-actions input[type='file'] {
  max-width: 240px;
  font-size: 12px;
  color: var(--text-soft);
}
</style>
