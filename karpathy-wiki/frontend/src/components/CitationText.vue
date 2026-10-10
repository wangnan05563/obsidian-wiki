<script setup lang="ts">
// FR-21 引用溯源：内联 [n] 角标解析组件（T01754）。
// 职责：接收 Markdown 渲染后的 HTML，把「合法槽位内的 [n]」替换为可点击角标；
// 未匹配到槽位的 [n] 按普通文本保留（SRS 规格 2——防 LLM 编造编号误导跳转）。
// 为什么后处理 HTML 而非改写 Markdown 源：renderMarkdown 管线全站共用（含代码块/链接），
// 在产物上做受控替换（n 为纯数字，注入面为零）侵入最小，且代码块外的正文替换已够用。
import { computed } from 'vue';
import { replaceCitationMarks, resolveCiteSlot } from '../utils/citation';

const props = defineProps<{
  /** renderMarkdown 产物（已转义的 HTML） */
  html: string;
  /** 本次回答的引用槽位（refs 路径数组，下标+1 = [n] 的 n） */
  refs: string[];
  /** 外部补充的内容区 class（桌面 msg-content / 移动端 mq-md 等布局类） */
  contentClass?: string;
}>();

const emit = defineEmits<{ (e: 'cite', slot: number): void }>();

// 合法槽位判定：1 ≤ n ≤ refs.length；非法编号原样保留
const maxSlot = computed(() => props.refs.length);

// 替换规则在 utils/citation.ts 纯函数中（可单测），组件只负责装配
const processed = computed(() => replaceCitationMarks(props.html, maxSlot.value));

// 事件委托：角标是动态 HTML，逐个绑定不可行；点击 sup.cite-ref 时读取 data-n 上抛
function handleClick(ev: MouseEvent) {
  const n = resolveCiteSlot(ev.target, maxSlot.value);
  if (n !== null) {
    ev.preventDefault();
    ev.stopPropagation();
    emit('cite', n);
  }
}
</script>

<template>
  <!-- 外层接管原内容区 class 与点击委托；HTML 经上方受控替换，数字来源受 maxSlot 约束 -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="msg-content markdown-body" :class="contentClass" @click="handleClick" v-html="processed"></div>
</template>

<style>
/* 角标样式（不设 scoped：v-html 内容不受 scoped 约束）——小号上标按钮，accent 色提示可点 */
sup.cite-ref {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  margin: 0 1px;
  padding: 0 3px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  border-radius: 8px;
  border: 1px solid var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
  background: transparent;
  cursor: pointer;
  vertical-align: super;
  user-select: none;
  transition: background-color 0.15s ease, color 0.15s ease;
}
sup.cite-ref:hover {
  background: var(--neon-cyan, #00f5ff);
  color: var(--text-bright, #fff);
}
</style>
