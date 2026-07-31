<script setup lang="ts">
// FR-09-2 多模态输出卡片：渲染 mindmap/faq/timeline/image/ppt 结构化输出
// - mindmap: 使用 mermaid.js 渲染思维导图（动态导入，避免首屏加载 mermaid）
// - faq: 渲染 Markdown 问答对（复用 renderMarkdown）
// - timeline: 渲染 Markdown 时间线（复用 renderMarkdown）
// - image: 渲染图像（img 标签 + 下载归档链接）
// - ppt: 使用 @marp-team/marp-core 渲染 Marp Markdown 为 HTML 幻灯片（动态导入）
// 设计选择：mermaid/marp 动态 import 减少首屏体积；faq/timeline/image 复用现有渲染管线
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { DataAnalysis, Picture, Document } from '@element-plus/icons-vue';
import type { MultimodalOutput } from '../types';
import { renderMarkdown } from '../utils/markdown';

const props = defineProps<{
  output: MultimodalOutput;
}>();

// mermaid 渲染容器引用，动态导入 mermaid 后挂载渲染结果
const mermaidContainer = ref<HTMLElement | null>(null);
// marp 渲染容器引用，动态导入 marp-core 后挂载渲染结果
const marpContainer = ref<HTMLElement | null>(null);
// 是否已加载 mermaid 库（避免重复加载）
let mermaidLoaded = false;
// 是否已加载 marp-core 库（避免重复加载）
let marpLoaded = false;
// 渲染错误信息（mermaid/marp 语法错误时显示原始文本）
const renderError = ref('');

// 动态加载 mermaid 并渲染 mindmap
// 为什么动态加载：mermaid 库 ~600KB，首屏加载会拖慢初始渲染；仅在首次使用 mindmap 时加载
async function renderMindmap(content: string) {
  if (!mermaidContainer.value) return;
  try {
    if (!mermaidLoaded) {
      // 动态 import mermaid，避免打包到主 chunk
      const mermaid = (await import('mermaid')).default;
      // 为什么 mermaid.initialize：配置主题与安全策略，避免 XSS
      // suppressErrorRendering: true 关键：mermaid 11.x 默认在 parse/draw 失败时向容器注入
      //   含 "Syntax error in text" 文字的错误 SVG（error-icon + error-text），启用此选项后
      //   失败时仅调用 removeTempElements() 清理临时元素并直接抛错，避免污染 .mermaid-output
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        suppressErrorRendering: true,
        mindmap: { padding: 16 },
      });
      mermaidLoaded = true;
    }
    // F-3.x 先清空容器：避免上次错误 SVG（如 "Syntax error in text"）残留
    mermaidContainer.value.innerHTML = '';
    // F-3.x 预解析语法：mermaid 11.x 的 render() 在 parse 失败时除了抛错，还可能注入临时 div/svg
    //   （即使 suppressErrorRendering: true 也会走 Diagram.fromText("error") 分支）。
    //   先用 parse() 单独验证语法，失败时只抛错不污染容器；此处配合 try/catch 清空容器兜底。
    await (await import('mermaid')).default.parse(content);
    // 预解析通过后再渲染：成功路径，正常挂载 SVG
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { svg } = await (await import('mermaid')).default.render(id, content);
    // F-3.x render 成功后也要清空容器：mermaid 11.x 内部在挂载 SVG 前可能向容器插入临时 wrapper div
    //   （即使 suppressErrorRendering 已开，正常路径仍会创建 enclosingDiv），innerHTML = svg 覆盖避免残留
    mermaidContainer.value.innerHTML = '';
    mermaidContainer.value.innerHTML = svg;
    renderError.value = '';
  } catch (err) {
    // 兜底：mermaid 11.x 在某些版本/分支下 parse 失败后仍可能向容器注入错误 SVG。
    // 清空容器避免用户看到 mermaid 内置的 "Syntax error in text" 错误图标
    if (mermaidContainer.value) {
      mermaidContainer.value.innerHTML = '';
    }
    // mermaid 语法错误时显示原始文本，让用户看到 LLM 输出内容便于排查
    renderError.value = err instanceof Error ? err.message : String(err);
  }
}

// 动态加载 marpit 并渲染 PPT 幻灯片
// 为什么用 marpit 而非 marp-core：marp-core 依赖 Node.js 内置 util 模块（util.deprecate），
// Vite 在浏览器中无法提供完整 polyfill，导致渲染时报 "u2 is not a function"；
// marpit 是 marp-core 的浏览器友好核心子库，提供相同的 Marp Markdown → HTML/CSS 渲染能力
// 为什么动态加载：marpit 库较大，首屏加载会拖慢初始渲染
async function renderPpt(markdown: string) {
  if (!marpContainer.value) return;
  try {
    if (!marpLoaded) {
      // 动态 import marpit，避免打包到主 chunk
      // marpit 是 CJS 模块，Vite 预构建后命名导出挂在 default 上，需兼容访问
      const mod = await import('@marp-team/marpit');
      const Marpit = mod.Marpit ?? mod.default?.Marpit;
      if (!Marpit) throw new Error('Marpit constructor not found in @marp-team/marpit');
      // inlineSVG: 每页渲染为 SVG（1280x720），支持矢量缩放，与 marp-core 渲染效果一致
      // markdown.html: 允许幻灯片 Markdown 中嵌入原生 HTML 标签（Marpit 的 html 选项需挂在 markdown 下传给 markdown-it）
      marpInstance = new Marpit({ markdown: { html: true }, inlineSVG: true });
      marpLoaded = true;
    }
    // render 返回 { html, css }，组合后挂载到容器
    const { html, css } = marpInstance.render(markdown);
    marpContainer.value.innerHTML = `<style>${css}</style>${html}`;
    renderError.value = '';
  } catch (err) {
    // marp 渲染失败时显示原始 Markdown，让用户看到 LLM 输出内容
    renderError.value = err instanceof Error ? err.message : String(err);
  }
}

// marpit 实例缓存：加载后复用，避免每次渲染重建
let marpInstance: any = null;

// 监听 output 变化，按类型分发渲染
watch(
  () => props.output,
  async (output) => {
    if (output.type === 'mindmap') {
      // 等 DOM 更新后 mermaidContainer 才可用
      await nextTick();
      await renderMindmap(output.content);
    } else if (output.type === 'ppt' && output.pptMarkdown) {
      // 等 DOM 更新后 marpContainer 才可用
      await nextTick();
      await renderPpt(output.pptMarkdown);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  // 清理渲染容器，避免内存泄漏
  mermaidContainer.value = null;
  marpContainer.value = null;
});

// 计算卡片标题
function cardLabel(type: MultimodalOutput['type']): string {
  switch (type) {
    case 'mindmap': return '思维导图';
    case 'faq': return 'FAQ 问答对';
    case 'timeline': return '时间线';
    case 'image': return '生成图像';
    case 'ppt': return 'PPT 幻灯片';
    default: return '结构化输出';
  }
}
</script>

<template>
  <div class="multimodal-card">
    <div class="card-header">
      <el-icon class="card-icon">
        <Picture v-if="props.output.type === 'image'" />
        <Document v-else-if="props.output.type === 'ppt'" />
        <DataAnalysis v-else />
      </el-icon>
      <span class="card-title">{{ cardLabel(props.output.type) }}</span>
    </div>
    <div class="card-body">
      <!-- mindmap: mermaid 渲染容器 -->
      <div v-if="props.output.type === 'mindmap'" class="mindmap-container">
        <div ref="mermaidContainer" class="mermaid-output"></div>
        <div v-if="renderError" class="render-error">
          <div class="error-title">渲染失败，原始内容：</div>
          <pre class="raw-content">{{ props.output.content }}</pre>
        </div>
      </div>
      <!-- image: 直接 img 标签渲染 -->
      <div v-else-if="props.output.type === 'image'" class="image-container">
        <img
          v-if="props.output.imageUrl"
          :src="props.output.imageUrl"
          :alt="props.output.content"
          class="generated-image"
        />
        <div class="image-meta">
          <a v-if="props.output.imageUrl" :href="props.output.imageUrl" target="_blank" rel="noopener" class="image-link">
            查看原图
          </a>
        </div>
      </div>
      <!-- ppt: marpit 渲染幻灯片容器 -->
      <div v-else-if="props.output.type === 'ppt'" class="ppt-container">
        <div ref="marpContainer" class="marp-output"></div>
        <div v-if="renderError" class="render-error">
          <div class="error-title">渲染失败，原始 Marp Markdown：</div>
          <pre class="raw-content">{{ props.output.pptMarkdown || props.output.content }}</pre>
        </div>
      </div>
      <!-- faq / timeline: 复用 markdown 渲染 -->
      <div v-else class="markdown-body" v-html="renderMarkdown(props.output.content)"></div>
    </div>
  </div>
</template>

<style scoped>
.multimodal-card {
  margin-top: 12px;
  border: 1px solid var(--accent-purple-a20, rgba(138, 92, 245, 0.2));
  border-radius: 12px;
  background: var(--accent-purple-a05, rgba(138, 92, 245, 0.05));
  overflow: hidden;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--accent-purple-a10, rgba(138, 92, 245, 0.1));
  border-bottom: 1px solid var(--accent-purple-a20, rgba(138, 92, 245, 0.2));
  font-size: 13px;
  font-weight: 500;
  color: var(--accent-purple, #8a5cf5);
}
.card-icon {
  font-size: 14px;
}
.card-body {
  padding: 12px 16px;
  max-height: 480px;
  overflow-y: auto;
}
.mindmap-container {
  display: flex;
  justify-content: center;
}
.mermaid-output {
  width: 100%;
  text-align: center;
}
.mermaid-output :deep(svg) {
  max-width: 100%;
  height: auto;
}
/* v3 图像生成卡片样式 */
.image-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.generated-image {
  max-width: 100%;
  max-height: 480px;
  object-fit: contain;
  border-radius: 8px;
}
.image-meta {
  font-size: 12px;
}
.image-link {
  color: var(--accent-purple, #8a5cf5);
  text-decoration: none;
}
.image-link:hover {
  text-decoration: underline;
}
/* v3 PPT 幻灯片卡片样式 */
.ppt-container {
  width: 100%;
}
.marp-output {
  width: 100%;
}
/* marpit 渲染的幻灯片需要允许滚动查看多页 */
.marp-output :deep(.marpit) {
  max-width: 100%;
}
.marp-output :deep(svg) {
  max-width: 100%;
  height: auto;
}
/* F-3.x 终极兜底：mermaid 11.x 在错误时会向容器插入含 .error-icon / .error-text 的 SVG。
   即使 suppressErrorRendering + 预解析 + render() 成功路径清空容器 三层防护都失效，
   全局隐藏 .mermaid-output 下的 .error-icon/.error-text 类名 SVG 元素，
   用户绝对看不到 "Syntax error in text" 错误图标，由 renderError 状态提供友好错误提示。 */
.mermaid-output :deep(.error-icon),
.mermaid-output :deep(.error-text) {
  display: none !important;
}
.render-error {
  margin-top: 12px;
  padding: 8px;
  border-radius: 6px;
  background: var(--accent-pink-a10, rgba(255, 100, 150, 0.1));
  border: 1px solid var(--accent-pink-a30, rgba(255, 100, 150, 0.3));
  font-size: 12px;
  color: var(--text-soft, #888);
}
.error-title {
  font-weight: 500;
  margin-bottom: 4px;
  color: var(--accent-pink, #ff6496);
}
.raw-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
