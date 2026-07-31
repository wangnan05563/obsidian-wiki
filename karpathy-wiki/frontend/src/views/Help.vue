<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Search } from '@element-plus/icons-vue';

// ===== 类型定义 =====
// 内容抽象为数据，渲染逻辑与内容分离，便于维护
type BlockType = 'feature' | 'steps' | 'scenario' | 'config' | 'note';

interface DocBlock {
  type: BlockType;
  title: string;
  // 不同类型对应不同载荷：steps/config 走结构化数据，feature/scenario/note 走字符串
  content: string | string[] | Array<[string, string, string]>;
  noteType?: 'info' | 'warning';
}

interface DocSection {
  id: string;
  title: string;
  icon: string; // SVG 路径字符串
  intro: string;
  blocks: DocBlock[];
}

// ===== 12 个章节内容（与 App.vue 导航栏视图一一对应）=====
// 章节顺序：快速开始 → 关于 → 各功能模块 → 配置类 → 维护类
const DOC_SECTIONS: DocSection[] = [
  {
    id: 'quickstart',
    title: '快速开始',
    icon: 'M9 2L11 7L16 9L11 11L9 16L7 11L2 9L7 7L9 2Z',
    intro: '从安装到首次问答的完整流程，新用户必读。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: 'Karpathy Wiki 是基于 LLM 的本地知识库问答系统。投递 Markdown / URL / 纯文本资料后，系统自动编译生成知识页面，支持基于引用的问答、知识图谱可视化、健康体检、内网穿透远程访问。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '配置 LLM：进入「配置」页面，选择 LLM 预设（OpenAI/DeepSeek/GLM/Qwen 等），填入 API Key 并保存',
          '投递资料：进入「投递资料」页面，拖拽 .md 文件 / 粘贴 URL / 输入纯文本，点击「开始编译」',
          '查看进度：进入「编译进度」页面，观察 read_schema → extract → generate_page → update_index 流程',
          '知识问答：进入「知识问答」页面，输入问题，AI 基于本地知识库回答并引用相关页面',
          '可选 - 体检：进入「体检」页面，检测孤立页面、断链、过期内容',
          '可选 - 远程访问：进入「内网穿透」页面，启动 Cloudflare 隧道暴露本机服务到公网',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '刚部署完系统，需要从零开始配置 LLM、投递资料并跑通第一次问答。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: 'API Key 仅存储在后端 config.json，前端 localStorage 只保存非敏感 UI 状态。首次编译需要 LLM 调用，请确保 API Key 有效且有配额。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'about',
    title: '关于 / 版本信息',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
    intro: '系统元信息与文档资源统一入口。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '展示当前版本号、发布日期、Git SHA、Node 版本与平台；一键检查更新；汇总 8 项外部资源链接（用户协议、隐私条款、开源声明、帮助文档、API 文档、联系我们、官方社区、报告问题）；浏览 19 项前后端依赖的开源许可清单。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「关于」进入页面',
          '查看版本号、发布日期、Git SHA 等元信息',
          '点击「检查更新」按钮查询最新版本',
          '点击菜单列表项跳转外部资源或打开开源声明 Modal',
          '在 Modal 搜索框按包名 / 许可证过滤依赖',
        ],
      },
      {
        type: 'note',
        title: '注意事项',
        content: '自动检查更新：进入页面 5 秒后首次检查，之后每 5 分钟检查一次；后端 5 分钟缓存避免重复读取。本项目无外网发布通道，检查更新固定返回"已是最新"。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'dashboard',
    title: '仪表盘',
    icon: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    intro: '系统总览入口，展示知识库规模与最近运行状态。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '展示知识库规模（页面数、原始资料数）、最近编译任务、最近问答记录、健康概览。提供到投递、浏览、问答、体检的快捷导航。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「仪表盘」进入首页',
          '查看顶部统计卡片了解知识库整体规模',
          '点击快捷入口跳转到对应功能页',
          '查看最近活动了解系统使用情况',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '日常使用时快速了解知识库运行状态，发现异常及时处理。',
      },
    ],
  },
  {
    id: 'ingest',
    title: '投递资料',
    icon: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    intro: '知识库内容入口，支持文件 / URL / 纯文本三种方式。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '支持拖拽 .md 文件上传（多文件）、粘贴 URL 自动抓取网页内容、直接输入纯文本三种方式。提交后自动存档到 vault/raw/ 并触发编译流程。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「投递资料」进入页面',
          '选择投递方式：文件 / URL / 文本',
          '文件方式：拖拽 .md 文件到上传区，或点击选择文件',
          'URL 方式：粘贴网页链接，系统自动抓取正文',
          '文本方式：直接在编辑器输入 Markdown 内容',
          '点击「开始编译」提交，自动跳转到「编译进度」页面',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '将外部资料（Obsidian 笔记、网页文章、技术文档）导入知识库，建立可问答的知识图谱。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '单文件大小上限 10MB；URL 抓取依赖站点反爬策略，部分站点可能失败；编译需要 LLM 调用，请确保 API Key 配额充足。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'progress',
    title: '编译进度',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    intro: '实时查看编译流程，支持断点续传。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '通过 SSE 流式推送编译进度：read_schema（读取 schema）→ extract（提取实体）→ generate_page（生成页面）→ update_index（更新索引）→ done。支持断点续传，中断后可从上次断点恢复。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '在「投递资料」页提交后自动跳转至「编译进度」',
          '观察流程步骤的实时进度条',
          '查看每步生成的页面路径',
          '如需中断，关闭页面即可（状态已持久化）',
          '重新进入页面时点击「继续」恢复未完成任务',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '监控长资料（如长文档、多文件批量上传）的编译过程，及时发现问题。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '编译进度页面仅在编译中或编译完成后可访问；空状态会自动禁用导航。断点续传依赖 .harness/state/ 目录下的状态文件，清理后无法恢复。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'browse',
    title: '知识浏览',
    icon: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    intro: '浏览编译生成的知识页面，支持全文检索。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '左侧文件树展示 vault 目录结构，右侧渲染 Markdown 页面。支持全文检索（关键词高亮）、[[页面名]] 双向链接跳转、按 mtime 排序。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「知识浏览」进入页面',
          '在左侧文件树点击目标 .md 文件',
          '右侧自动渲染页面内容',
          '使用顶部搜索框进行全文检索',
          '点击页面内的 [[链接]] 跳转到对应页面',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '回顾已投递的资料；查阅 AI 生成的内容页面；通过双向链接发现知识关联。',
      },
    ],
  },
  {
    id: 'query',
    title: '知识问答',
    icon: 'M21 6h-2v9H6v2c0 .55.45 1 1 1h12l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z',
    intro: '基于本地知识库的 AI 问答，支持引用溯源与多模态。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '基于本地知识库的 RAG 问答，AI 回答时引用具体页面（[[页面名]] 格式）。支持流式输出、思考过程展示、追问建议、多模态图片输入（vision 模型）、TTS 朗读、联网搜索（Tavily/Bing）、深度思考模式。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「知识问答」进入页面',
          '在底部输入框输入问题',
          '可选：点击工具栏切换深度思考 / 联网搜索 / 上传图片',
          '可选：使用 ModelSelector 切换 LLM 模型',
          '查看 AI 回答，点击引用标记跳转对应页面',
          '点击追问建议继续对话',
          '点击消息工具栏复制 / 重新生成 / 朗读',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '针对已投递的资料提问，AI 基于本地内容回答；多模态场景可上传图片让 vision 模型分析。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '问答历史持久化到后端 data/conversations/，按 UUID 命名避免冲突；开发模式（5173）和生产模式（3000）的会话隔离。联网搜索需要配置 Tavily 或 Bing API Key。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'graph',
    title: '图谱',
    icon: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    intro: '知识图谱可视化，展示页面间关联。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '使用 vis-network 渲染知识图谱，4 类节点（页面/概念/对比/查询）按颜色区分。支持缩放、拖拽、点击节点跳转、悬停高亮关联边。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「图谱」进入页面',
          '鼠标滚轮缩放图谱',
          '拖拽节点重新布局',
          '点击节点跳转到对应页面',
          '悬停节点高亮其关联边',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '直观发现知识关联，识别孤立主题，规划下一步投递方向。',
      },
    ],
  },
  {
    id: 'health',
    title: '体检',
    icon: 'M19 3H5c-1.11 0-2 .89-2 2v14c0 1.11.89 2 2 2h14c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm-2 11h-3v3h-4v-3H7v-4h3V7h4v3h3v4z',
    intro: '检测知识库健康度，支持一键修复。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '检测 3 类问题：孤立页面（无入链）、断链（指向不存在的页面）、过期页面（超过 staleDays 未更新）。支持 LLM 驱动的一键修复，SSE 流式返回修复进度。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「体检」进入页面',
          '点击「执行体检」按钮',
          '查看三类问题列表',
          '点击问题项的「一键修复」按钮',
          '观察修复进度日志，完成后自动重新体检',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '定期维护知识库质量，清理无效链接，补充孤立页面的引用关系。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '一键修复会调用 LLM 生成修复内容，可能产生 token 消耗。修复前请确保已配置有效的 API Key。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'config',
    title: '配置',
    icon: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    intro: 'LLM 服务、联网搜索、模型切换配置。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '配置 LLM Provider（8 家预设：OpenAI/DeepSeek/GLM/Qwen/Moonshot/豆包/Ollama/Agnes）、API Key、baseUrl、模型。支持连接测试、一键恢复默认、联网搜索（Tavily/Bing）配置。',
      },
      {
        type: 'config',
        title: '参数配置',
        content: [
          ['provider', 'glm', 'LLM 提供商标识'],
          ['baseUrl', 'https://open.bigmodel.cn/api/paas/v4', 'OpenAI 兼容 API 基础地址'],
          ['model', 'glm-4-plus', '模型名称'],
          ['apiKeyRef', 'GLM_KEY', '环境变量名（向后兼容）'],
          ['apiKey', '****xxxx', 'API Key（脱敏存储在 config.json）'],
          ['maxSteps', '20', 'LLM Agent 最大步数'],
          ['tokenBudget', '50000', '单次会话 token 预算'],
        ],
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「配置」进入页面',
          '选择 LLM 预设或自定义输入',
          '填入 API Key（脱敏显示）',
          '点击「测试连接」验证配置',
          '点击「保存」写入 config.json',
          '可选：配置联网搜索 Provider 与 API Key',
        ],
      },
      {
        type: 'note',
        title: '注意事项',
        content: 'API Key 仅存储在后端 config.json，前端 localStorage 只保存非敏感 UI 状态（baseUrl/model）。模型切换通过 PUT /api/ai/config 同步 config.json 与运行时 EngineAdapter 实例。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'tunnel',
    title: '内网穿透',
    icon: 'M20 10V8c0-1.1-.9-2-2-2h-7V5c0-.55-.45-1-1-1H6c-.55 0-1 .45-1 1v2c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h13c1.1 0 2-.9 2-2v-1h2v-5h-2z',
    intro: 'Cloudflare / cpolar / tailscale 三种隧道方案。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '支持 3 种内网穿透方案：Cloudflare Tunnel（quick 临时域名 / named 固定域名）、cpolar（国内高速）、tailscale（P2P 直连）。可配置开机自启，启动后获取公网访问 URL。',
      },
      {
        type: 'config',
        title: '参数配置',
        content: [
          ['provider', 'cloudflare', '隧道提供商：cloudflare/cpolar/tailscale'],
          ['tunnelMode', 'quick', 'cloudflare 模式：quick 临时域名 / named 固定域名'],
          ['localPort', '0', '本地端口，0 表示从 server.port 继承'],
          ['autoStart', 'false', '是否服务启动时自动建立隧道'],
          ['cpolarAuthtoken', '', 'cpolar 平台的 authtoken'],
          ['binaryPath', '', '隧道二进制文件路径（留空使用 PATH）'],
        ],
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「内网穿透」进入页面',
          '选择 Provider（推荐 Cloudflare quick 模式）',
          '点击「启动隧道」',
          '等待 5-15 秒获取公网 URL',
          '点击 URL 在新窗口打开访问',
          '可选：点击「停止」关闭隧道',
        ],
      },
      {
        type: 'note',
        title: '注意事项',
        content: 'quick 模式每次重启 URL 都会变化；named 模式需先执行 cloudflared tunnel 三步向导（创建隧道、配置 credentials、绑定 hostname）。CORS 默认仅放行 localhost，tunnel 域名需手动加白。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'cleanup',
    title: '系统清理',
    icon: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    intro: '4 类对象清理：编译缓存、运行状态、运行日志、原始资料。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '清理 4 类对象：编译缓存（compile-cache.json）、运行状态（state/*.json）、运行日志（logs/*.log）、原始资料（vault/raw/input-*.md）。支持 dry_run 预览模式、按保留天数清理、审计日志记录。',
      },
      {
        type: 'config',
        title: '参数配置',
        content: [
          ['target', 'all', '清理目标：compile_cache/run_state/run_logs/raw_archive/all'],
          ['days', '30', '保留天数（仅 run_logs/raw_archive 使用）'],
          ['dry_run', 'true', '预览模式：true 仅列出，false 实际执行'],
        ],
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「系统清理」进入页面',
          '查看 4 类对象的存储状态（大小 / 文件数 / 最早时间）',
          '对每类对象独立配置 dry_run 开关与保留天数',
          '点击「清理」按钮，非预览模式会弹出二次确认',
          '查看结果列表（dry_run 前缀 [预览]，实际执行显示释放空间）',
        ],
      },
      {
        type: 'note',
        title: '注意事项',
        content: '清理操作不可逆，建议先 dry_run 预览。清理后 .harness/cleanup-audit.log 记录每次操作的 target/days/cleaned_items，便于追溯。compile_cache 清理后下次编译全部重新生成，token 消耗增加。',
        noteType: 'warning',
      },
    ],
  },
];

// ===== 搜索过滤 =====
const search = ref('');

const filteredSections = computed(() => {
  if (!search.value.trim()) return DOC_SECTIONS;
  const kw = search.value.toLowerCase();
  return DOC_SECTIONS.filter(
    (s) => s.title.toLowerCase().includes(kw) || s.intro.toLowerCase().includes(kw),
  );
});

// ===== 锚点导航 =====
const activeAnchor = ref('');

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    activeAnchor.value = id;
  }
}

// 监听滚动更新激活的锚点
function handleScroll() {
  const scrollContainer = document.querySelector('.help-content-area');
  if (!scrollContainer) return;
  // 找到离顶部最近的章节
  for (const section of DOC_SECTIONS) {
    const el = document.getElementById(section.id);
    if (el) {
      const rect = el.getBoundingClientRect();
      // 章节顶部距离视口顶部 80px 内视为激活
      if (rect.top >= 0 && rect.top < 120) {
        activeAnchor.value = section.id;
        break;
      }
    }
  }
}

onMounted(async () => {
  await nextTick();
  // 默认激活第一个章节
  if (DOC_SECTIONS.length > 0) {
    activeAnchor.value = DOC_SECTIONS[0].id;
  }
  const scrollContainer = document.querySelector('.help-content-area');
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
  }
});

onBeforeUnmount(() => {
  const scrollContainer = document.querySelector('.help-content-area');
  if (scrollContainer) {
    scrollContainer.removeEventListener('scroll', handleScroll);
  }
});
</script>

<template>
  <div class="help-page">
    <div class="help-layout">
      <!-- 左侧侧栏：搜索 + 章节锚点 -->
      <aside class="help-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">文档目录</span>
        </div>
        <el-input
          v-model="search"
          placeholder="搜索章节..."
          :prefix-icon="Search"
          size="small"
          clearable
          class="sidebar-search"
        />
        <nav class="anchor-nav">
          <a
            v-for="section in filteredSections"
            :key="section.id"
            :href="'#' + section.id"
            class="anchor-item"
            :class="{ active: activeAnchor === section.id }"
            @click.prevent="scrollToSection(section.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="anchor-icon">
              <path :d="section.icon" />
            </svg>
            <span class="anchor-label">{{ section.title }}</span>
          </a>
          <div v-if="filteredSections.length === 0" class="empty-anchor">
            未找到匹配的章节
          </div>
        </nav>
      </aside>

      <!-- 右侧内容区 -->
      <div class="help-content-area">
        <!-- 头部简介卡 -->
        <div class="glass-card intro-card">
          <div class="card-deco"></div>
          <div class="intro-content">
            <div class="intro-icon-wrap">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 2L11 7L16 9L11 11L9 16L7 11L2 9L7 7L9 2Z" />
              </svg>
            </div>
            <div class="intro-text">
              <h2 class="intro-title grad-text">Karpathy Wiki 使用文档</h2>
              <p class="intro-desc">
                系统涵盖投递资料、编译、问答、图谱、体检、内网穿透全流程。本文档详细介绍各功能模块的使用方法，
                包括核心功能、操作步骤、使用场景、参数配置和注意事项。
              </p>
            </div>
          </div>
        </div>

        <!-- 各章节内容 -->
        <div
          v-for="section in filteredSections"
          :key="section.id"
          :id="section.id"
          class="glass-card section-card"
        >
          <div class="section-head">
            <div class="section-icon-wrap">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path :d="section.icon" />
              </svg>
            </div>
            <h3 class="section-title">{{ section.title }}</h3>
          </div>
          <p class="section-intro">{{ section.intro }}</p>
          <div class="section-divider"></div>

          <div class="blocks">
            <div v-for="block in section.blocks" :key="block.title" class="block">
              <div class="block-title">
                <span class="block-bullet" :class="block.type"></span>
                <span>{{ block.title }}</span>
              </div>

              <!-- feature / scenario / note：字符串 -->
              <p v-if="block.type === 'feature' || block.type === 'scenario'" class="block-text">
                {{ block.content }}
              </p>

              <p
                v-else-if="block.type === 'note'"
                class="block-text note-text"
                :class="'note-' + (block.noteType || 'info')"
              >
                {{ block.content }}
              </p>

              <!-- steps：有序列表 -->
              <ol v-else-if="block.type === 'steps'" class="block-steps">
                <li v-for="(step, idx) in (block.content as string[])" :key="idx">{{ step }}</li>
              </ol>

              <!-- config：参数表格 -->
              <div v-else-if="block.type === 'config'" class="block-config">
                <table>
                  <thead>
                    <tr>
                      <th>参数</th>
                      <th>示例</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, idx) in (block.content as Array<[string, string, string]>)" :key="idx">
                      <td><code>{{ row[0] }}</code></td>
                      <td class="cell-example">{{ row[1] }}</td>
                      <td class="cell-desc">{{ row[2] }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div v-if="filteredSections.length === 0" class="empty-content">
          未找到匹配的章节
        </div>

        <!-- 底部 -->
        <div class="help-footer">
          <span class="footer-line"></span>
          <span class="footer-text">Karpathy Wiki · 帮助文档</span>
          <span class="footer-line"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.help-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.help-layout {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

/* 左侧侧栏 */
.help-sidebar {
  width: 240px;
  flex-shrink: 0;
  padding: 16px 14px;
  background: var(--bg-card);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: var(--border-glass);
  border-radius: var(--radius-card);
  box-shadow: var(--glow-soft);
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.sidebar-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 4px;
}

.sidebar-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--neon-cyan);
  text-transform: uppercase;
}

.sidebar-title {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.sidebar-search :deep(.el-input__wrapper) {
  background: var(--bg-scene, rgba(10, 1, 24, 0.4)) !important;
}

.anchor-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.anchor-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--text-soft);
  font-size: 13px;
  font-family: var(--font-body);
  transition: all 0.2s ease;
  cursor: pointer;
}

.anchor-item:hover {
  background: var(--accent-purple-a12);
  color: var(--neon-cyan);
}

.anchor-item.active {
  background: var(--accent-purple-a20);
  color: var(--neon-magenta);
  text-shadow: 0 0 8px var(--accent-pink-a40);
}

.anchor-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.anchor-item.active .anchor-icon {
  opacity: 1;
}

.empty-anchor {
  padding: 16px 10px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}

/* 右侧内容区
 * 滚动策略：让 .content (App.vue 外层) 统一接管滚动，自身不嵌套 overflow。
 * 原因：双重滚动（外层 + 内层）容易导致 flex 子项被压缩到 min-content 高度，
 *       章节卡片只显示标题一行、内容被裁切。把滚动交给外层后，
 *       卡片按内容自然高度撑开，整个页面自然出现一条滚动条 */
.help-content-area {
  flex: 1;
  min-width: 0;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 章节卡片不参与高度压缩，按内容自然撑开。
 * 为什么需要 flex-shrink: 0：flex 默认 0 1 auto，容器有限高度时会被等比压缩 */
.intro-card,
.section-card {
  flex-shrink: 0;
}

/* 头部简介卡 */
.intro-card {
  position: relative;
  padding: 20px 24px;
  overflow: hidden;
}

.intro-content {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.intro-icon-wrap {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--grad-aurora);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 0 18px var(--accent-purple-a40);
}

.intro-text {
  flex: 1;
}

.intro-title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.intro-desc {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
  line-height: 1.6;
}

/* 章节卡片 */
.section-card {
  padding: 20px 24px;
  scroll-margin-top: 16px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.section-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--accent-purple-a15);
  border: 1px solid var(--accent-purple-a30);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--neon-cyan);
  flex-shrink: 0;
}

.section-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.02em;
}

.section-intro {
  margin: 0 0 12px;
  color: var(--text-soft);
  font-size: 13px;
  padding-left: 46px;
}

.section-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent-purple-a30), transparent);
  margin: 0 0 16px;
}

/* 内容块 */
.blocks {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  font-family: var(--font-body);
  letter-spacing: 0.02em;
}

.block-bullet {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.block-bullet.feature {
  background: var(--neon-cyan);
  box-shadow: 0 0 8px var(--neon-cyan);
}

.block-bullet.steps {
  background: var(--neon-lime);
  box-shadow: 0 0 8px var(--neon-lime);
}

.block-bullet.scenario {
  background: var(--neon-purple);
  box-shadow: 0 0 8px var(--neon-purple);
}

.block-bullet.config {
  background: var(--neon-pink);
  box-shadow: 0 0 8px var(--neon-pink);
}

.block-bullet.note {
  background: var(--neon-magenta);
  box-shadow: 0 0 8px var(--neon-magenta);
}

.block-text {
  margin: 0;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.65;
  padding-left: 16px;
}

.note-text {
  padding: 8px 12px;
  border-radius: 8px;
  border-left: 3px solid;
}

.note-text.note-info {
  background: var(--accent-cyan-a08);
  border-left-color: var(--neon-cyan);
}

.note-text.note-warning {
  background: var(--accent-pink-a08);
  border-left-color: var(--neon-magenta);
}

.block-steps {
  margin: 0;
  padding-left: 32px;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.7;
}

.block-steps li {
  margin-bottom: 4px;
}

/* 配置表格 */
.block-config {
  padding-left: 16px;
  overflow-x: auto;
}

.block-config table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: var(--font-mono);
}

.block-config th {
  text-align: left;
  padding: 8px 12px;
  background: var(--accent-purple-a12);
  color: var(--text-bright);
  border-bottom: 1px solid var(--accent-purple-a30);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.block-config td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--accent-purple-a10);
  color: var(--text-soft);
}

.block-config code {
  background: var(--accent-cyan-a10);
  color: var(--neon-cyan);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.cell-example {
  color: var(--neon-purple) !important;
}

.cell-desc {
  color: var(--text-dim) !important;
}

.empty-content {
  text-align: center;
  padding: 64px 0;
  color: var(--text-dim);
  font-size: 13px;
}

/* 底部 */
.help-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
}

.footer-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--neon-purple), transparent);
}

.footer-text {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.18em;
  white-space: nowrap;
}

/* 响应式：小屏隐藏侧栏，内容铺满 */
@media (max-width: 900px) {
  .help-sidebar {
    display: none;
  }

  .help-layout {
    gap: 0;
  }

  .section-intro {
    padding-left: 0;
  }
}
</style>
