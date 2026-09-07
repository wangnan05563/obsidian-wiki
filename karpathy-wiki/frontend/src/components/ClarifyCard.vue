<script setup lang="ts">
// 意图澄清卡片：后端检测到问题歧义时（SSE clarify 事件），暂停回答并列出多义解读选项。
// 用户选择某个解读（或按推荐直接回答）后，由消费方携带 clarifyId + choiceIndex 重发同一问题；
// 后端据此确认的意图继续检索回答。轮次徽标展示「第 N 次 / 共 M 次」，让用户感知打断次数上限。
import { QuestionFilled } from '@element-plus/icons-vue';
import type { Clarification } from '../types';

const props = defineProps<{
  clarification: Clarification;
  // 用户已选择、正在重发确认后的问答（按钮禁用 + 旋转提示）
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [index: number];
  // 放弃澄清：清卡片并解除 loading，允许用户重新输入/换个问法
  dismiss: [];
}>();

function selectOption(index: number) {
  if (props.loading) return;
  emit('select', index);
}

function selectRecommended() {
  if (props.loading) return;
  emit('select', props.clarification.recommendedIndex);
}
</script>

<template>
  <div class="clarify-card">
    <div class="clarify-header">
      <span class="clarify-icon">
        <el-icon><QuestionFilled /></el-icon>
      </span>
      <span class="clarify-title">需要确认你的问题</span>
      <span v-if="clarification.round > 1" class="clarify-round">第 {{ clarification.round }} / {{ clarification.maxRounds }} 次确认</span>
    </div>

    <p class="clarify-prompt">{{ clarification.prompt }}</p>

    <div class="clarify-options">
      <button
        v-for="opt in clarification.interpretations"
        :key="opt.index"
        type="button"
        class="clarify-option"
        :class="{ recommended: opt.index === clarification.recommendedIndex }"
        :disabled="loading"
        @click="selectOption(opt.index)"
      >
        <span class="option-label">
          {{ opt.label }}
          <span v-if="opt.index === clarification.recommendedIndex" class="recommend-tag">推荐</span>
        </span>
        <span v-if="opt.description" class="option-desc">{{ opt.description }}</span>
      </button>
    </div>

    <div class="clarify-actions">
      <el-button
        type="primary"
        size="small"
        :loading="loading"
        @click="selectRecommended"
      >
        {{ loading ? '正在理解你的意图…' : '按推荐理解直接回答' }}
      </el-button>
      <el-button size="small" text :disabled="loading" @click="emit('dismiss')">
        换个问法
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.clarify-card {
  background: var(--bg-card, rgba(22, 10, 45, 0.55));
  border: var(--border-neon, 1px solid rgba(176, 38, 255, 0.35));
  border-radius: 12px;
  padding: 14px 16px;
  margin: 8px 0;
  max-width: 560px;
  box-shadow: var(--glow-soft, 0 8px 40px rgba(176, 38, 255, 0.18));
}
.clarify-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.clarify-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent-purple-a12, rgba(176, 38, 255, 0.12));
  color: var(--neon-cyan, #00f5ff);
  font-size: 13px;
}
.clarify-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #f3e9ff);
}
.clarify-round {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-soft, #9d8ec4);
  border: 1px solid var(--border-glass, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  padding: 1px 8px;
  white-space: nowrap;
}
.clarify-prompt {
  margin: 10px 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-soft, #9d8ec4);
}
.clarify-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.clarify-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--accent-purple-a04, rgba(176, 38, 255, 0.04));
  border: 1px solid var(--border-glass, rgba(255, 255, 255, 0.08));
  cursor: pointer;
  transition: all 0.2s;
}
.clarify-option:hover:not(:disabled) {
  background: var(--accent-purple-a08, rgba(176, 38, 255, 0.08));
  border-color: var(--neon-purple, #b026ff);
}
.clarify-option.recommended {
  border-color: var(--neon-cyan, #00f5ff);
}
.clarify-option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.option-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f3e9ff);
}
.recommend-tag {
  font-size: 11px;
  font-weight: 400;
  color: var(--neon-cyan, #00f5ff);
  border: 1px solid rgba(0, 245, 255, 0.35);
  border-radius: 8px;
  padding: 0 6px;
  line-height: 16px;
}
.option-desc {
  font-size: 12px;
  color: var(--text-soft, #9d8ec4);
  line-height: 1.5;
}
.clarify-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
