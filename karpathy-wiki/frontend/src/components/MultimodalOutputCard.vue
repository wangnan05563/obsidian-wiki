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
// 媒体 URL 解析：imageUrl/pptxUrl 是 /api/media 相对路径，需带 Vite base 前缀才可被
//   <img>/<a> 直接加载（<img>/<a> 无法走 fetch 注入 Authorization，只能走公开媒体路由）
import { resolveMediaUrl } from '../utils/apiBase';

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

// 剥离首尾 ``` 代码围栏（如 ```mindmap 与结尾 ```）：
// 仅处理第一行与最后一行，中间内容原样保留；无围栏时原样返回。
function stripCodeFence(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 0 && /^\s*```/.test(lines[0])) lines.shift();
  if (lines.length > 0 && /^\s*```\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

// 动态加载 mermaid 并渲染 mindmap
// 为什么动态加载：mermaid 库 ~600KB，首屏加载会拖慢初始渲染；仅在首次使用 mindmap 时加载
async function renderMindmap(content: string) {
  if (!mermaidContainer.value) return;
  try {
    // 剥离 LLM 输出的 ```mindmap ... ``` 代码围栏：mermaid 只认纯 mindmap 语法，
    // 文本以 ``` 开头时无法识别 diagram type（报 "No diagram type detected"）。
    // 为什么用正则剥离首尾围栏而非整体 replace：只影响首尾两行，不动中间可能含 ``` 的内容
    const src = stripCodeFence(content.trim());
    if (!src) {
      renderError.value = '空内容，无思维导图可渲染';
      return;
    }
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
    await (await import('mermaid')).default.parse(src);
    // 预解析通过后再渲染：成功路径，正常挂载 SVG
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { svg } = await (await import('mermaid')).default.render(id, src);
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
    // mermaid 语法错误时显示原始文本，让用户看到 LLM 输出内容便于排查；
    // 同时暴露 err.message，便于进一步定位（如动态导入失败 / DOM 异常 / 版本兼容）。
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
          <div class="error-title">渲染失败</div>
          <div class="error-detail">{{ renderError }}</div>
          <pre class="raw-content">{{ props.output.content }}</pre>
        </div>
      </div>
      <!-- image: 直接 img 标签内联显示（T00274：无需点击查看原图；lazy 懒加载 + 异步解码降阻塞） -->
      <div v-else-if="props.output.type === 'image'" class="image-container">
        <img
          v-if="props.output.imageUrl"
          :src="resolveMediaUrl(props.output.imageUrl)"
          :alt="props.output.content"
          class="generated-image"
          loading="lazy"
          decoding="async"
        />
        <div class="image-meta">
          <a v-if="props.output.imageUrl" :href="resolveMediaUrl(props.output.imageUrl)" target="_blank" rel="noopener" class="image-link">
            查看原图
          </a>
        </div>
      </div>
      <!-- ppt: marpit 渲染幻灯片容器 -->
      <div v-else-if="props.output.type === 'ppt'" class="ppt-container">
        <div ref="marpContainer" class="marp-output"></div>
        <!-- 下载入口：原生 .pptx 由后端生成并通过公开媒体路由提供，a[download] 直接保存。
             pptxUrl 缺失（生成降级）时不渲染按钮，仅保留预览与错误提示 -->
        <div v-if="props.output.pptxUrl" class="ppt-download">
          <a :href="resolveMediaUrl(props.output.pptxUrl)" download="知识库PPT.pptx" class="ppt-download-link">
            下载 .pptx
          </a>
        </div>
        <!-- PPT 分支此前的缺陷：只显示原始文本，渲染失败时看不到 renderError，无法定位根因；
             现与 mindmap 分支一致，透出具体错误信息(error-detail)以便排查 -->
        <div v-if="renderError" class="render-error">
          <div class="error-title">渲染失败</div>
          <div class="error-detail">{{ renderError }}</div>
          <div class="error-raw-label">原始 Marp Markdown：</div>
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
/* 卡片内 markdown（FAQ/时间线）背景统一跟随主题，避免再引用全局 style.css 中
   硬编码的近黑 pre 背景 rgba(5,0,16,0.6)。FAQ 内容常被模型包进代码块，若沿用全局深色
   pre 会填满卡片主体，形成"整卡黑色"（且在浅/深主题都一致黑，观感突兀）。
   这里用主题变量（浅色主题为浅色，深色主题仍为深色），实现"与主题背景一致"。
   注意必须 :deep：卡片内容经 v-html 注入、不带本组件 data-v，scoped 需穿透命中。 */
.card-body :deep(.markdown-body pre) {
  background: var(--bg-elevated, rgba(247, 248, 250, 0.9));
  border-color: var(--border-color, rgba(128, 128, 128, 0.25));
}
.card-body :deep(.markdown-body pre code) {
  color: var(--text-base);
  background: transparent;
}
.card-body :deep(.markdown-body code) {
  background: var(--accent-cyan-a12, rgba(21, 84, 209, 0.1));
  color: var(--neon-purple, #1554d1);
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
  max-width: 100%;
}
.marp-output :deep(svg) {
  max-width: 100%;
  height: auto;
}
/* 下载 .pptx 入口：主色弱化链接，置于预览下方，hover 加深 */
.ppt-download {
  margin-top: 10px;
  text-align: center;
}
.ppt-download-link {
  display: inline-block;
  padding: 6px 16px;
  border: 1px solid var(--accent-purple, #8a5cf5);
  border-radius: 16px;
  color: var(--accent-purple, #8a5cf5);
  font-size: 13px;
  text-decoration: none;
  transition: background 0.2s;
}
.ppt-download-link:hover {
  background: var(--accent-purple-a10, rgba(138, 92, 245, 0.1));
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
.error-detail {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--accent-pink, #ff6496);
  white-space: pre-wrap;
  word-break: break-word;
}
.raw-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
