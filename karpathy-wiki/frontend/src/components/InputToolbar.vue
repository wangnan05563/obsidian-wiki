<script setup lang="ts">
// §F-3.4 InputToolbar — 输入区上方工具栏（仿豆包）。
// 7 类工具 chip：快速 / 写作 / PPT / 图像 / 视频 / 翻译 / 更多
//   - "更多"点击展开下拉菜单显示次要工具（联网搜索 / 深度思考）
//   - PPT/图像/视频在 v2.0.0 仅做 UI 标记 + mode 字段传递，实际生成留 v3
// 设计选择：图标内置为自定义 SVG（霓虹科技风线条风格），不依赖 emoji 或第三方图标库
// §5.2 iconOnly 模式：仅显示图标不显示文字标签，鼠标悬浮显示 title 提示

interface Tool {
  key: string;
  label: string;
  disabled?: boolean;       // v3 待实现工具灰显
  disabledReason?: string;   // 灰显时的 tooltip 说明
}

const props = defineProps<{
  tools: Tool[];
  secondaryTools?: Tool[];   // "更多"下拉中的次要工具
  activeMode: string;
  iconOnly?: boolean;
  moreOpen?: boolean;        // "更多"下拉是否展开
}>();
const emit = defineEmits<{
  select: [mode: string];
  toggleMore: [];
}>();

function handleSelect(tool: Tool) {
  if (tool.disabled) return;
  emit('select', tool.key);
}
</script>

<template>
  <div class="input-toolbar" :class="{ 'icon-only': props.iconOnly }">
    <button v-for="tool in props.tools" :key="tool.key"
      type="button"
      class="tool-chip"
      :class="{
        active: props.activeMode === tool.key,
        'icon-only': props.iconOnly,
        disabled: tool.disabled,
      }"
      :title="props.iconOnly
        ? (tool.disabled ? tool.disabledReason || '暂未实现' : tool.label)
        : (tool.disabled ? tool.disabledReason || '暂未实现' : undefined)"
      :disabled="tool.disabled"
      @click="handleSelect(tool)">
      <!-- 快速：闪电图标 -->
      <svg v-if="tool.key === 'fast'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
      <!-- 帮我写作：笔与纸 -->
      <svg v-else-if="tool.key === 'write'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M3 21l3-3 11-11 3 3-11 11-3 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M14 7l3 3" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <!-- PPT 生成：幻灯片框架 -->
      <svg v-else-if="tool.key === 'ppt'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="4" width="18" height="13" rx="1" stroke="currentColor" stroke-width="1.8"/>
        <line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" stroke-width="1.5"/>
        <line x1="9" y1="20" x2="15" y2="20" stroke="currentColor" stroke-width="1.5"/>
        <line x1="12" y1="17" x2="12" y2="20" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <!-- 图像生成：画板调色 -->
      <svg v-else-if="tool.key === 'image'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="8.5" cy="8.5" r="1.8" stroke="currentColor" stroke-width="1.5"/>
        <path d="M3 16l5-5 4 4 4-4 5 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <!-- 视频生成：播放按钮 -->
      <svg v-else-if="tool.key === 'video'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <!-- 翻译：地球 + 对话框 -->
      <svg v-else-if="tool.key === 'translate'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M4 5h9l-1 4M8 3v2c0 4-3 7-6 8M5 9c2 2 5 3 8 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M12 20l4-9 4 9M14 17h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <!-- 更多 ⋯：三点折叠 -->
      <svg v-else-if="tool.key === 'more'" class="tool-icon" :class="{ rotated: props.moreOpen }" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="5" cy="12" r="1.8" fill="currentColor"/>
        <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
        <circle cx="19" cy="12" r="1.8" fill="currentColor"/>
      </svg>
      <!-- 联网搜索：地球 + 信号 -->
      <svg v-else-if="tool.key === 'web'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
        <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.5"/>
        <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="18" cy="6" r="2" fill="currentColor" opacity="0.6"/>
      </svg>
      <!-- 深度思考：神经网络节点 -->
      <svg v-else-if="tool.key === 'deep'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="18" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="12" cy="14" r="2.5" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="6" cy="20" r="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="18" cy="20" r="2" stroke="currentColor" stroke-width="1.5"/>
        <line x1="7.5" y1="7" x2="10.5" y2="12.5" stroke="currentColor" stroke-width="1.2"/>
        <line x1="16.5" y1="7" x2="13.5" y2="12.5" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10.5" y1="15.5" x2="7.5" y2="19" stroke="currentColor" stroke-width="1.2"/>
        <line x1="13.5" y1="15.5" x2="16.5" y2="19" stroke="currentColor" stroke-width="1.2"/>
      </svg>
      <span v-if="!props.iconOnly" class="tool-label">{{ tool.label }}</span>
    </button>

    <!-- "更多"下拉层：展示次要工具（web/deep 等） -->
    <div v-if="props.moreOpen && props.secondaryTools && props.secondaryTools.length" class="more-dropdown">
      <button v-for="tool in props.secondaryTools" :key="tool.key"
        type="button"
        class="tool-chip secondary"
        :class="{ active: props.activeMode === tool.key }"
        :title="tool.label"
        @click="emit('select', tool.key)">
        <svg v-if="tool.key === 'web'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
          <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.5"/>
          <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="18" cy="6" r="2" fill="currentColor" opacity="0.6"/>
        </svg>
        <svg v-else-if="tool.key === 'deep'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="18" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="12" cy="14" r="2.5" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="6" cy="20" r="2" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="18" cy="20" r="2" stroke="currentColor" stroke-width="1.5"/>
          <line x1="7.5" y1="7" x2="10.5" y2="12.5" stroke="currentColor" stroke-width="1.2"/>
          <line x1="16.5" y1="7" x2="13.5" y2="12.5" stroke="currentColor" stroke-width="1.2"/>
          <line x1="10.5" y1="15.5" x2="7.5" y2="19" stroke="currentColor" stroke-width="1.2"/>
          <line x1="13.5" y1="15.5" x2="16.5" y2="19" stroke="currentColor" stroke-width="1.2"/>
        </svg>
        <span class="tool-label">{{ tool.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.input-toolbar {
  display: flex;
  gap: 8px;
  padding: 4px 0 0;
  overflow-x: auto;
  position: relative;
  z-index: 2;
}
.tool-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 16px;
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  background: var(--accent-cyan-a05, rgba(0, 245, 255, 0.05));
  color: var(--text-soft, #888);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.25s;
  white-space: nowrap;
  position: relative;
}
.tool-chip:hover:not(.disabled) {
  background: var(--accent-cyan-a12, rgba(0, 245, 255, 0.12));
  border-color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 8px var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  /* F-3.4 验收：hover 有动效（玻璃光泽滑动） */
  transform: translateY(-1px);
}
.tool-chip:focus-visible {
  /* F-3.4 验收：键盘可达 */
  outline: 2px solid var(--neon-cyan, #00f5ff);
  outline-offset: 2px;
}
.tool-chip.active {
  background: var(--accent-cyan-a18, rgba(0, 245, 255, 0.18));
  border-color: var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 12px var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
}
.tool-chip.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-style: dashed;
}
.tool-chip.icon-only {
  padding: 8px;
  border-radius: 10px;
}
.tool-icon {
  flex-shrink: 0;
  transition: filter 0.25s, transform 0.25s;
}
.tool-icon.rotated {
  transform: rotate(90deg);
}
.tool-chip.active .tool-icon {
  filter: drop-shadow(0 0 3px var(--neon-cyan, #00f5ff));
}
.tool-label {
  font-size: 12px;
  font-weight: 500;
}
.more-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  display: flex;
  gap: 8px;
  padding: 8px;
  background: var(--bg-card-solid, rgba(20, 20, 35, 0.95));
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-radius: 12px;
  box-shadow: 0 8px 24px var(--accent-purple-a20, rgba(0, 0, 0, 0.4));
  z-index: 10;
  backdrop-filter: var(--blur, blur(12px));
}
.more-dropdown .secondary {
  padding: 6px 10px;
  font-size: 12px;
}
</style>
