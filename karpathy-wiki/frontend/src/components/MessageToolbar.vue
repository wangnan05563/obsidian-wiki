<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
// 统一采用 Element Plus 开源图标库（@element-plus/icons-vue），避免使用 emoji 或 AI 预制图标
import {
  DocumentCopy,
  Document,
  RefreshRight,
  VideoPlay,
  VideoPause,
  Delete,
  Edit,
  Microphone,
} from '@element-plus/icons-vue';
import { useTtsStore } from '../stores/tts';
import { msgFeedbackKey } from '../constants/storageKeys';
// 反馈图标（点赞/点踩）改用项目自研开源 SVG 图标 NavIcons（向上/向下大拇指），
// 比 Element Plus 的 Star（星标）语义更直观；跟随主题 currentColor。
import NavIcons from './NavIcons.vue';

// F-3.7 + F-3.13 + F-3.6 消息操作工具栏：hover 气泡时浮窗淡入
// user 消息：时间 / 复制 / 删除
// assistant 消息：时间 / 复制纯文本 / 复制 MD / 朗读 / 重新生成 / 点赞 / 点踩 / 删除
const props = withDefaults(
  defineProps<{
    content: string;
    // F-3.13 消息 ID：用于 localStorage 反馈持久化的 key，以及 TTS 朗读切换
    msgId?: string;
    // F-3.13 是否允许重新生成：流式输出中或正在加载时应禁用
    canRegenerate?: boolean;
    // 消息角色：决定工具栏内容差异化（user 仅复制+删除，assistant 含朗读/重新生成/反馈）
    role: 'user' | 'assistant';
    // 消息创建时间（ISO 字符串）：用于工具栏左侧时间显示
    createdAt?: string;
    // 是否允许编辑（仅 user 消息有意义）：默认 true（用户消息应可再次编辑重发）；
    // 悬浮窗(FloatingChat)传 false 不展示编辑入口
    canEdit?: boolean;
    // 是否允许归档：仅 assistant 消息且具备 sessionId（可定位后端会话）时为 true
    // 默认 false（悬浮窗/FloatingChat 不展示归档入口，与主问答页行为一致）
    canArchive?: boolean;
    // 是否已归档：归档成功后由父组件置位，按钮置灰不可重复归档
    archived?: boolean;
  }>(),
  {
    canEdit: true,
    canArchive: false,
    archived: false,
  },
);

const emit = defineEmits<{
  // F-3.13 重新生成：父组件处理"复用 user 问题 + 丢弃当前 assistant 回答 + 触发新问答"
  regenerate: [];
  // 删除当前消息：父组件调用 store.removeMessage(idx)
  remove: [];
  // 编辑当前 user 消息：父组件将气泡切换为可编辑态并重发
  edit: [];
  // 归档当前 assistant 消息到知识库：父组件调用 archiveMessage(idx)
  archive: [];
}>();

// F-3.13 反馈状态：'up' | 'down' | null
// 为什么用 ref + localStorage 同步：本地读取避免每次点击都查 localStorage
const feedback = ref<'up' | 'down' | null>(null);

// 时间显示：短格式 HH:mm 常态显示，完整格式 YYYY-MM-DD HH:mm:ss 在 title 中 hover 显示
// 为什么用 computed 而非方法：依赖 props.createdAt 变化时自动重算
const timeDisplay = computed(() => {
  if (!props.createdAt) return '';
  const d = new Date(props.createdAt);
  if (Number.isNaN(d.getTime())) return '';
  // 短格式：HH:mm（同日）或 MM-DD HH:mm（跨日）
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
});
const timeFull = computed(() => {
  if (!props.createdAt) return '';
  const d = new Date(props.createdAt);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});

// F-3.6 TTS：通过 store 协调多条消息的朗读切换，避免同时多条朗读
const ttsStore = useTtsStore();

// TTS 始终可用：edge provider 通过后端 API 实现，不依赖浏览器 speechSynthesis
// browser provider 仍需 speechSynthesis，但 edge 为默认 provider
const ttsSupported = true;

// Edge TTS 可用音色列表（与后端 EDGE_TTS_VOICES 一致）
const edgeVoices = [
  { shortName: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温婉）' },
  { shortName: 'zh-CN-YunyangNeural', label: '云扬（男·播报）' },
  { shortName: 'zh-CN-XiaoyiNeural', label: '晓伊（女·甜美）' },
  { shortName: 'zh-CN-YunxiNeural', label: '云希（男·沉稳）' },
  { shortName: 'zh-CN-XiaochenNeural', label: '晓辰（女·知性）' },
  { shortName: 'zh-CN-YunfengNeural', label: '云枫（男·低沉）' },
  { shortName: 'zh-CN-XiaohanNeural', label: '晓涵（女·温暖）' },
  { shortName: 'zh-CN-YunhaoNeural', label: '云皓（男·活力）' },
  { shortName: 'zh-CN-XiaomengNeural', label: '晓梦（女·清新）' },
  { shortName: 'zh-CN-YunzeNeural', label: '云泽（男·儒雅）' },
];

// Edge 神经语音可选的说话风格（提升拟人度，对应后端 ALLOWED_STYLES 的白名单子集）
// 'general' 表示不使用 express-as（标准朗读），其余为微软 neural 专属风格
const ttsStyles = [
  { value: 'general', label: '标准' },
  { value: 'narration-relaxed', label: '轻松讲述' },
  { value: 'chat', label: '闲聊' },
  { value: 'newscast', label: '新闻播报' },
  { value: 'newscast-casual', label: '轻松新闻' },
  { value: 'empathetic', label: '共情' },
  { value: 'calm', label: '平静' },
  { value: 'gentle', label: '温柔' },
  { value: 'cheerful', label: '欢快' },
  { value: 'serious', label: '严肃' },
];

// F-3.6 当前消息朗读状态：仅当 currentMsgId === props.msgId 时才有意义
// 为什么用 computed：store 中 currentMsgId 变化时自动更新按钮图标
const ttsState = computed(() => {
  if (ttsStore.currentMsgId !== props.msgId) return 'idle';
  return ttsStore.state;
});

// F-3.6 朗读按钮图标：未朗读 → VideoPlay；朗读中 → VideoPause；已暂停 → VideoPlay
const ttsIcon = computed(() => {
  if (ttsState.value === 'playing') return VideoPause;
  if (ttsState.value === 'paused') return VideoPlay;
  return VideoPlay;
});
const ttsTitle = computed(() => {
  if (ttsState.value === 'playing') return '暂停朗读';
  if (ttsState.value === 'paused') return '继续朗读';
  return '朗读';
});

// 音色选择浮窗显示状态
const showVoicePanel = ref(false);

// F-3.6 语速浮窗显示状态：仅当本消息正在朗读且用户点击 rate-btn 时展开
const showRatePanel = ref(false);

// F-3.6 处理语速滑块变化：转为数字后调 store.setRate
// 为什么 parseFloat 后 clamp：防御滑块原始值越界（极端浏览器行为）
function handleRateChange(raw: string) {
  const v = Number.parseFloat(raw);
  if (Number.isNaN(v)) return;
  ttsStore.setRate(v);
}

// 音量/音调滑块变化：转为数字后调 store.setVolume / setPitch（store 内部已 clamp + 重启朗读）
function handleVolumeChange(raw: string) {
  const v = Number.parseFloat(raw);
  if (Number.isNaN(v)) return;
  ttsStore.setVolume(v);
}
function handlePitchChange(raw: string) {
  const v = Number.parseFloat(raw);
  if (Number.isNaN(v)) return;
  ttsStore.setPitch(v);
}

onMounted(() => {
  // 恢复当前消息已记录的反馈状态
  if (props.msgId) {
    const saved = localStorage.getItem(msgFeedbackKey(props.msgId));
    if (saved === 'up' || saved === 'down') {
      feedback.value = saved;
    }
  }
});

// 复制到剪贴板：优先 navigator.clipboard（HTTPS / localhost 可用）
// 降级到 document.execCommand('copy')（兼容非 HTTPS 场景，如 HTTP 局域网访问）
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // 降级路径：创建临时 textarea + execCommand，兼容旧浏览器 / 非 HTTPS
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Markdown → 纯文本：剥离常见 markdown 语法
// 为什么不引入 marked.lexer：单文件正则足够覆盖 90% 场景，避免增加 bundle
// 为什么不复用 useTTS.ts 的 stripMarkdown：两者用途不同
//   - 这里用于「复制纯文本」：代码块需保留代码内容（用户希望粘贴可读源码）
//   - useTTS.ts 用于「语音朗读」：代码块替换为「代码块」占位（避免朗读源码）
//   - 拆分两份实现避免引入跨模块耦合，且各自职责清晰
function stripMarkdown(md: string): string {
  return md
    // 代码块：替换为占位（保留代码内容，去除 ``` 围栏）
    .replaceAll(/```[\s\S]*?\n([\s\S]*?)```/g, (_, code) => code.trim())
    // 行内代码：去反引号
    .replaceAll(/`([^`]+)`/g, '$1')
    // 图片：替换为 alt 文本
    .replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 链接：替换为文本
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 标题井号
    .replaceAll(/^#{1,6}\s+/gm, '')
    // 引用块 >
    .replaceAll(/^>\s+/gm, '')
    // 粗体/斜体
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/\*([^*]+)\*/g, '$1')
    .replaceAll(/__([^_]+)__/g, '$1')
    .replaceAll(/_([^_]+)_/g, '$1')
    // 删除线
    .replaceAll(/~~([^~]+)~~/g, '$1')
    // 无序列表标记
    .replaceAll(/^[-*+]\s+/gm, '')
    // 有序列表标记
    .replaceAll(/^\d+\.\s+/gm, '')
    // 水平分割线
    .replaceAll(/^---+$/gm, '')
    // 收敛多余空行
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

async function handleCopyPlain() {
  const ok = await copyToClipboard(stripMarkdown(props.content));
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制纯文本' : '复制失败，请手动选择');
}

async function handleCopyMarkdown() {
  const ok = await copyToClipboard(props.content);
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制 Markdown' : '复制失败，请手动选择');
}

// user 消息复制：直接复制原始内容（无 markdown 解析需求）
async function handleCopyUser() {
  const ok = await copyToClipboard(props.content);
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制' : '复制失败，请手动选择');
}

// 删除当前消息：直接 emit，由父组件调用 store.removeMessage(idx)
// 为什么不在组件内直接操作 store：组件应保持"无状态 UI"职责，删除由父组件统一管理索引
function handleRemove() {
  emit('remove');
}

// 编辑当前 user 消息：直接 emit，由父组件将气泡切换为可编辑态并准备重发
function handleEdit() {
  emit('edit');
}

// 归档当前 assistant 消息：直接 emit，由父组件调用 archiveMessage(idx)
// 已归档态由 props.archived 控制禁用，避免重复归档
function handleArchive() {
  if (props.archived) return;
  emit('archive');
}

// F-3.6 朗读切换：根据当前状态决定 speak / pause / resume / stop
// 切换到其他消息会自动停止当前（store.speak 内部已处理）
function handleTtsToggle() {
  if (!ttsSupported) {
    ElMessage.warning('当前浏览器不支持语音朗读');
    return;
  }
  if (!props.msgId) {
    ElMessage.warning('消息 ID 缺失，无法朗读');
    return;
  }
  if (ttsState.value === 'playing') {
    ttsStore.pause();
  } else if (ttsState.value === 'paused') {
    ttsStore.resume();
  } else {
    // idle 或其他消息朗读中 → 重新 speak
    // useTTS.stripMarkdown 已内置剥离，这里直接传原始 content
    ttsStore.speak(props.content, props.msgId);
  }
}

// F-3.13 重新生成：直接 emit，由父组件处理具体逻辑（删除消息、复用问题、重新触发）
function handleRegenerate() {
  if (props.canRegenerate === false) {
    ElMessage.warning('回答生成中，请稍后');
    return;
  }
  emit('regenerate');
}

// F-3.13 反馈：写 localStorage（v2.0.0 仅本地，后续可云端）
// 重复点击同一反馈 = 取消；点击相反反馈 = 切换
function handleFeedback(type: 'up' | 'down') {
  if (!props.msgId) {
    ElMessage.warning('消息 ID 缺失，无法记录反馈');
    return;
  }
  if (feedback.value === type) {
    // 取消反馈
    feedback.value = null;
    localStorage.removeItem(msgFeedbackKey(props.msgId));
    ElMessage.info('已取消反馈');
  } else {
    feedback.value = type;
    localStorage.setItem(msgFeedbackKey(props.msgId), type);
    ElMessage.success('感谢反馈');
  }
}
</script>

<template>
  <!-- F-3.7 / F-3.13 / F-3.6 浮窗：默认透明 + pointer-events:none，hover 父气泡(.msg-content-wrapper)时显现。
       用户与 AI 气泡工具栏采用同一套隐藏/悬停浮现逻辑（需求：用户工具栏默认隐藏、悬停才浮现），
       不再为 user 单独加 msg-toolbar--user 强制常显类，统一由 Query.vue 的 .msg-content-wrapper:hover 规则控制 -->
  <div class="msg-toolbar" @click.stop>
    <!-- 时间戳：左对齐显示，hover 显示完整时间 -->
    <span v-if="timeDisplay" class="toolbar-time" :title="timeFull">{{ timeDisplay }}</span>

    <!-- user 消息工具栏：编辑 + 复制 + 删除 -->
    <template v-if="role === 'user'">
      <button
        v-if="canEdit !== false"
        class="toolbar-btn"
        title="编辑并重新发送"
        @click="handleEdit"
      >
        <el-icon><Edit /></el-icon>
      </button>
      <button class="toolbar-btn" title="复制" @click="handleCopyUser">
        <el-icon><DocumentCopy /></el-icon>
      </button>
      <button class="toolbar-btn danger-btn" title="删除" @click="handleRemove">
        <el-icon><Delete /></el-icon>
      </button>
    </template>

    <!-- assistant 消息工具栏：复制纯文本 / 复制 MD / 朗读 / 重新生成 / 点赞 / 点踩 / 删除 -->
    <template v-else>
      <button
        class="toolbar-btn"
        title="复制纯文本"
        @click="handleCopyPlain"
      >
        <el-icon><Document /></el-icon>
      </button>
      <button
        class="toolbar-btn"
        title="复制 Markdown"
        @click="handleCopyMarkdown"
      >
        <el-icon><DocumentCopy /></el-icon>
      </button>
      <!-- F-3.6 朗读按钮：未朗读 ▶；朗读中 ⏸；已暂停 ▶；不支持时灰显 -->
      <button
        class="toolbar-btn"
        :class="{ active: ttsState !== 'idle', disabled: !ttsSupported }"
        :disabled="!ttsSupported"
        :title="ttsTitle"
        @click="handleTtsToggle"
      >
        <el-icon><component :is="ttsIcon" /></el-icon>
      </button>
      <!-- F-3.6 语速调节按钮：点击展开浮窗滑块，仅当本消息正在朗读时显示 -->
      <button
        v-if="ttsState !== 'idle'"
        class="toolbar-btn rate-btn"
        :class="{ active: showRatePanel }"
        title="语速"
        @click.stop="showRatePanel = !showRatePanel"
      >{{ Math.round(ttsStore.rate * 100) / 100 }}x</button>
      <!-- F-3.6 语速浮窗：0.5-2.0 滑块，步长 0.1，默认 1.0 -->
      <div v-if="showRatePanel && ttsState !== 'idle'" class="rate-panel" @click.stop>
        <span class="rate-label">语速 {{ ttsStore.rate.toFixed(1) }}x</span>
        <input
          type="range"
          min="0.5"
          max="2.0"
          step="0.1"
          :value="ttsStore.rate"
          class="rate-slider"
          @input="handleRateChange(($event.target as HTMLInputElement).value)"
        />
        <button class="rate-reset" title="恢复默认 1.0x" @click="handleRateChange('1')">1.0x</button>
      </div>
      <!-- 音色/引擎选择按钮：点击展开浮窗选择音色和切换引擎 -->
      <button
        v-if="ttsState !== 'idle'"
        class="toolbar-btn voice-btn"
        :class="{ active: showVoicePanel }"
        title="音色设置"
        @click.stop="showVoicePanel = !showVoicePanel"
      >
        <el-icon><Microphone /></el-icon>
      </button>
      <!-- 音色/引擎选择浮窗 -->
      <div v-if="showVoicePanel && ttsState !== 'idle'" class="voice-panel" @click.stop>
        <div class="voice-section">
          <span class="voice-section-label">语音引擎</span>
          <div class="voice-toggle">
            <button
              class="voice-toggle-btn"
              :class="{ active: ttsStore.providerName === 'edge' }"
              @click="ttsStore.setProvider('edge')"
            >神经语音</button>
            <button
              class="voice-toggle-btn"
              :class="{ active: ttsStore.providerName === 'browser' }"
              @click="ttsStore.setProvider('browser')"
            >浏览器</button>
          </div>
        </div>
        <!-- 音色列表：仅 edge provider 显示 -->
        <div v-if="ttsStore.providerName === 'edge'" class="voice-section">
          <span class="voice-section-label">音色</span>
          <div class="voice-list">
            <button
              v-for="v in edgeVoices"
              :key="v.shortName"
              class="voice-item"
              :class="{ active: ttsStore.currentVoice === v.shortName }"
              @click="ttsStore.setVoice(v.shortName)"
            >{{ v.label }}</button>
          </div>
        </div>
        <!-- 说话风格：仅 edge provider 显示，显著提升拟人度 -->
        <div v-if="ttsStore.providerName === 'edge'" class="voice-section">
          <span class="voice-section-label">说话风格</span>
          <div class="voice-list">
            <button
              v-for="s in ttsStyles"
              :key="s.value"
              class="voice-item"
              :class="{ active: ttsStore.currentStyle === s.value }"
              @click="ttsStore.setStyle(s.value)"
            >{{ s.label }}</button>
          </div>
        </div>
        <!-- 音量 / 音调：仅 edge provider 显示，实时微调朗读听感 -->
        <div v-if="ttsStore.providerName === 'edge'" class="voice-section">
          <div class="voice-slider-row">
            <span class="voice-section-label">音量 {{ ttsStore.currentVolume >= 0 ? '+' : '' }}{{ ttsStore.currentVolume }}%</span>
            <input
              type="range"
              min="-30"
              max="30"
              step="1"
              :value="ttsStore.currentVolume"
              class="voice-slider"
              @input="handleVolumeChange(($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="voice-slider-row">
            <span class="voice-section-label">音调 {{ ttsStore.currentPitch >= 0 ? '+' : '' }}{{ ttsStore.currentPitch }}Hz</span>
            <input
              type="range"
              min="-10"
              max="10"
              step="1"
              :value="ttsStore.currentPitch"
              class="voice-slider"
              @input="handlePitchChange(($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
      </div>
      <!-- F-3.13 重新生成：复用该消息对应的 user 问题，重新发起问答 -->
      <button
        class="toolbar-btn"
        :class="{ disabled: canRegenerate === false }"
        :title="canRegenerate === false ? '回答生成中' : '重新生成'"
        @click="handleRegenerate"
      >
        <el-icon><RefreshRight /></el-icon>
      </button>
      <!-- 归档：将本条 assistant 问答存入知识库（archived 置灰禁用，避免重复归档）
           图标采用 NavIcons 的 Lucide 开源 archive 图标，与点赞/点踩同源 -->
      <button
        v-if="canArchive"
        class="toolbar-btn"
        :class="{ disabled: archived }"
        :disabled="archived"
        :title="archived ? '已归档' : '归档到知识库'"
        @click="handleArchive"
      >
        <NavIcons name="archive" :size="16" />
      </button>
      <!-- F-3.13 反馈：向上/向下大拇指（NavIcons 开源 SVG），写 localStorage 持久化
           点赞=thumb-up，点踩=thumb-down；激活态由 .toolbar-btn.active 高亮 -->
      <button
        class="toolbar-btn"
        :class="{ active: feedback === 'up' }"
        title="点赞"
        @click="handleFeedback('up')"
      >
        <NavIcons name="thumb-up" :size="16" />
      </button>
      <button
        class="toolbar-btn"
        :class="{ active: feedback === 'down' }"
        title="点踩"
        @click="handleFeedback('down')"
      >
        <NavIcons name="thumb-down" :size="16" />
      </button>
      <!-- 删除按钮：danger 样式以示警告 -->
      <button class="toolbar-btn danger-btn" title="删除" @click="handleRemove">
        <el-icon><Delete /></el-icon>
      </button>
    </template>
  </div>
</template>

<style scoped>
/* 工具栏：气泡外部下方流式布局，避免挡住气泡内文字
   为什么从 absolute 改为 static：absolute 定位在气泡内部会覆盖文字，
   改为气泡下方独立行显示，hover 气泡或工具栏时显现 */
.msg-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  margin-top: 4px;
  background: transparent;
  /* 默认隐藏：hover 父气泡才显现，避免常态视觉噪音 */
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
}

/* 时间戳：左侧紧凑显示，弱化以突出操作按钮 */
.toolbar-time {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-soft, #888);
  padding: 0 4px;
  margin-right: 2px;
  border-right: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  white-space: nowrap;
  user-select: none;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-soft, #888);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s ease;
  font-size: 13px;
}

.toolbar-btn:hover {
  background: var(--accent-cyan-a18, rgba(0, 245, 255, 0.18));
  color: var(--neon-cyan, #00f5ff);
}

/* 删除按钮：hover 时使用主题粉色警示色，与其他操作按钮视觉区分 */
.toolbar-btn.danger-btn:hover {
  background: var(--accent-pink-a25, rgba(255, 0, 110, 0.25));
  color: var(--neon-pink, #ff006e);
}

/* F-3.6 / F-3.13 激活态：高亮显示当前朗读/反馈状态 */
.toolbar-btn.active {
  background: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  color: var(--neon-cyan, #00f5ff);
  box-shadow: inset 0 0 0 1px var(--accent-cyan-a50, rgba(0, 245, 255, 0.5));
}

/* F-3.6 / F-3.13 禁用态：降低不透明度 + 阻止 hover 反馈 */
.toolbar-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.toolbar-btn.disabled:hover {
  background: transparent;
  color: var(--text-soft, #888);
}

/* hover 父气泡时显现：触发规则由 Query.vue 控制
   为什么不放这里：scoped 隔离下无法选中父元素，需在父组件作用域定义 */

/* F-3.6 语速按钮：紧凑显示当前语速值 */
.rate-btn {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  min-width: 32px;
  padding: 0 6px;
}

/* F-3.6 语速浮窗：绝对定位在工具栏下方 */
.rate-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  padding: 8px 12px;
  background: var(--bg-scene, rgba(20, 20, 30, 0.92));
  backdrop-filter: var(--blur);
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 10;
  white-space: nowrap;
  box-shadow: 0 4px 12px var(--accent-purple-a20, rgba(0, 0, 0, 0.4));
}

.rate-label {
  font-size: 11px;
  color: var(--text-soft, #888);
  font-family: var(--font-mono, monospace);
}

/* F-3.6 语速滑块：原生 input[type=range] 样式适配主题 */
.rate-slider {
  width: 120px;
  height: 4px;
  cursor: pointer;
  accent-color: var(--neon-cyan, #00f5ff);
}

.rate-reset {
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 4px;
  color: var(--text-soft, #888);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.rate-reset:hover {
  background: var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  color: var(--neon-cyan, #00f5ff);
  border-color: var(--neon-cyan, #00f5ff);
}

/* 音色/引擎选择浮窗 */
.voice-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  padding: 10px 12px;
  background: var(--bg-scene, rgba(20, 20, 30, 0.92));
  backdrop-filter: var(--blur);
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 8px;
  z-index: 10;
  min-width: 180px;
  max-width: 240px;
  box-shadow: 0 4px 12px var(--accent-purple-a20, rgba(0, 0, 0, 0.4));
}

.voice-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voice-section + .voice-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
}

.voice-section-label {
  font-size: 10px;
  color: var(--text-soft, #888);
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.voice-toggle {
  display: flex;
  gap: 4px;
}

.voice-toggle-btn {
  flex: 1;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-radius: 4px;
  color: var(--text-soft, #888);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}

.voice-toggle-btn:hover {
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
  color: var(--neon-cyan, #00f5ff);
}

.voice-toggle-btn.active {
  background: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  color: var(--neon-cyan, #00f5ff);
  border-color: var(--accent-cyan-a50, rgba(0, 245, 255, 0.5));
}

.voice-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.voice-item {
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  border-radius: 4px;
  color: var(--text-soft, #888);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.voice-item:hover {
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
  color: var(--neon-cyan, #00f5ff);
}

.voice-item.active {
  background: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  color: var(--neon-cyan, #00f5ff);
  border-color: var(--accent-cyan-a50, rgba(0, 245, 255, 0.5));
}

/* 音量 / 音调滑块行：标签 + 原生 range 横向布局 */
.voice-slider-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-slider {
  width: 100%;
  height: 4px;
  cursor: pointer;
  accent-color: var(--neon-cyan, #00f5ff);
}
</style>
