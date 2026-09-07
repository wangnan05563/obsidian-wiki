<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useConversationsStore } from '../stores/conversations';
import { useAuthStore } from '../stores/auth';
import { isUnlocked } from '../services/localVault';
import { createBackup, restoreBackup, downloadBackup, readBackupFile } from '../services/backup';

// ===== 类型定义 =====
// 内容抽象为数据，渲染逻辑与内容分离，便于维护
type BlockType = 'feature' | 'steps' | 'scenario' | 'config' | 'note' | 'code';

interface DocBlock {
  type: BlockType;
  title: string;
  // 不同类型对应不同载荷：steps/config 走结构化数据，feature/scenario/note 走字符串
  content: string | string[] | Array<[string, string, string]>;
  noteType?: 'info' | 'warning';
  // code 类型：展示代码语言标记（用于顶部小徽标，如 json / shell）
  codeLang?: string;
}

interface DocSection {
  id: string;
  title: string;
  icon: string; // SVG 路径字符串
  intro: string;
  blocks: DocBlock[];
}

// ===== 15 个导航视图，本文档覆盖其全部（用户管理 / 技能管理 / 数据清洗 随迭代新增）=====
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
          '管理员专属：进入「用户管理 / 技能管理 / 数据清洗」维护账户、技能与知识库质量',
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
        content: '展示当前版本号、发布日期、Git SHA、Node 版本与平台；一键检查更新；汇总 8 个菜单项（6 个外链：用户协议 / 隐私条款 / API 文档 / 联系我们 / 官方社区 / 报告问题；开源声明打开许可清单弹窗、帮助文档为站内跳转）；浏览 19 项前后端依赖的开源许可清单。',
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
        content: '展示知识库规模（总页面数、双向链接数、实体页 / 概念页等目录分布）、最近操作日志与编译运行历史。提供知识浏览 / 知识问答 / 图谱 / 帮助文档的快捷入口。',
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
        content: '支持 6 种投递入口：文件（拖拽 / 多选 .md）、文件夹、URL（自动抓取网页正文）、纯文本（直接编写 Markdown）、浏览器书签、QQ 聊天记录（核心为文件、URL、纯文本）。提交后自动存档到 vault/raw/ 并触发编译流程。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「投递资料」进入页面',
          '选择投递方式：文件 / 文件夹 / URL / 文本 / 书签 / QQ',
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
        content: '基于本地知识库的 RAG 问答，AI 回答时引用具体页面（[[页面名]] 格式）。通过工具栏「中间件」多选开关统一控制联网搜索（Tavily/Bing）、深度思考、扩展工具、追问建议、真流式；支持流式输出、思考过程展示、多模态图片输入（vision 模型）、TTS 朗读（Edge 神经网络语音，失败时回退浏览器语音）。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「知识问答」进入页面',
          '在底部输入框输入问题',
          '可选：通过工具栏「中间件」多选开启深度思考 / 联网搜索；点击附件按钮上传图片（需选择支持 vision 的模型）',
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
        content: '问答历史仅保存在本地浏览器（IndexedDB），按账户隔离（ownerId），不上传服务端；清除浏览器缓存或更换设备会丢失，建议定期导出备份。联网搜索需要配置 Tavily 或 Bing API Key。',
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
        content: '使用 vis-network 渲染知识图谱，6 类节点（实体 / 概念 / 对比 / 问答 / 业务问答 / 方案沉淀）按目录着色，与 SCHEMA.md type 枚举对齐。支持缩放、拖拽、点击节点跳转、悬停高亮关联边。',
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
    intro: 'LLM 服务、联网搜索、工具、朗读与系统级配置（按用户隔离 / 仅管理员）。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '配置页入口对所有登录用户开放，按配置项性质分为「个人偏好（按用户隔离、本地存储）」与「系统级（仅管理员）」两类。个人可配置：AI 服务（LLM Provider 预设 / 自定义 baseUrl / model / apiKey，BYOK）、联网搜索（Tavily/Bing）、工具（MCP/CLI/场景路由）、朗读设置（TTS 引擎、音色、语速、语调、音量）、界面主题。仅管理员可改系统级：SCHEMA 规范、系统配置、批量编译、QQ 导入、Prompt IDE。',
      },
      {
        type: 'config',
        title: 'AI 服务参数（按用户隔离，本地存储）',
        content: [
          ['provider', 'glm', 'LLM 提供商标识（8 家预设：OpenAI/DeepSeek/GLM/Qwen/Moonshot/豆包/Ollama/Agnes）'],
          ['baseUrl', 'https://open.bigmodel.cn/api/paas/v4', 'OpenAI 兼容 API 基础地址'],
          ['model', 'glm-4-plus', '模型名称'],
          ['apiKeyRef', 'GLM_KEY', '环境变量名（全局预设引用，向后兼容）'],
          ['apiKey', '****xxxx', 'API Key（仅存本机 IndexedDB，按 userId 命名空间隔离，不写服务端）'],
        ],
      },
      {
        type: 'config',
        title: '高级运行参数（仅管理员保存，经 /api/config 热加载）',
        content: [
          ['maxSteps', '20', 'LLM Agent 最大步数（即时生效）'],
          ['tokenBudget', '200000', '单次会话 token 预算（即时生效）'],
          ['staleDays', '30', '体检判定页面过期的天数（即时生效）'],
        ],
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '点击导航栏「配置」进入页面（所有登录用户均可进入）',
          '（个人）在「AI 服务」选择 LLM 预设或自定义输入，填入本账户 API Key，点击「测试连接」后保存（仅存本机）',
          '（个人）可选在「联网搜索」配置 Tavily / Bing 的 Key 并启用',
          '（个人）在「工具」配置 MCP / CLI / 场景路由，「朗读设置」调整 TTS，「界面主题」切换外观',
          '（管理员）在「SCHEMA 规范 / 系统配置 / 批量编译 / QQ 导入 / Prompt IDE」编辑系统级配置并保存',
        ],
      },
      {
        type: 'note',
        title: '注意事项',
        content: 'API Key 采用 BYOK：仅存储在本机浏览器 IndexedDB（usercfg::ai::<userId>），不写服务端 config.json，每个用户可独立覆盖全局预设（provider/baseUrl/model/apiKey）。非敏感 UI 状态（baseUrl/model）缓存于 localStorage。全局运行参数（maxSteps/tokenBudget/staleDays）经 PUT /api/config/budget、PUT /api/config/health-check 保存，并由 POST /api/config/reload 热加载；adapter/vaultPath/server 等需重启进程生效。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP 接口',
    icon: 'M18 7h-2V5a2 2 0 0 0-4 0v2H8V5a2 2 0 0 0-4 0v2H2v6h2v2a3 3 0 0 0 3 3h2v4h2v-4h2v4h2v-4h2a3 3 0 0 0 3-3v-2h2V7z',
    intro: '以 MCP（Model Context Protocol）服务器形式向外部 AI Agent 暴露知识库的查询 / 维护能力。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '通过 JSON-RPC 2.0 + Streamable HTTP（默认端点 /mcp）对外提供 15 个工具：8 个查询/检索类（列页、目录树、全文检索、读页、查路径、统计、智能问答、待审标签）与 7 个维护/增强类（写页、建页、删页、归档原稿、编译、AI 打标签、确认标签）。支持外部 AI Agent（Claude Code / Cursor / Cline 等）接入后对知识库进行全方位维护、增强与查询。采用 Bearer Token 双轨鉴权：userToken 读、adminToken 写。'
      },
      {
        type: 'config',
        title: 'MCP 配置参数（api/config.json 的 mcp 段，改后重启生效）',
        content: [
          ['enabled', 'true', '是否启用端点（默认 false，未启用返回 503）'],
          ['endpointPath', '/mcp', 'HTTP 端点路径，可自定义'],
          ['name', 'karpathy-wiki', '对客户端展示的服务名'],
          ['version', '1.0.0', '对客户端展示的版本号'],
          ['userToken', '', '读/查询类工具的 Bearer Token'],
          ['adminToken', '', '写/维护类工具的 Bearer Token，未配置时写工具回退 userToken'],
          ['authenticated', 'true', '是否要求鉴权；false 且无任何 token 时开放全部工具（仅内网自用）']
        ]
      },
      {
        type: 'code',
        title: 'MCP JSON 配置示例（写入 api/config.json 的 mcp 段）',
        content: `"mcp": {
  "enabled": true,
  "endpointPath": "/mcp",
  "name": "karpathy-wiki",
  "version": "1.0.0",
  "userToken": "你的只读Token",
  "adminToken": "你的管理Token",
  "authenticated": true
}`,
        codeLang: 'json'
      },
      {
        type: 'steps',
        title: '启用与接入步骤',
        content: [
          '在 api/config.json 的 mcp 段填入 enabled:true，并设置 userToken（读）与 adminToken（写）',
          '重启后端服务（端口 3000，配置修改需重启进程生效）',
          '外部客户端以 http://host:3000/mcp 作为 MCP 服务器地址，HTTP 头携带 Authorization: Bearer token',
          '客户端依次调用 initialize、tools/list、tools/call 完成握手、枚举与调用',
          '客户端按工具权限使用：查询类用 userToken，写/维护类需 adminToken'
        ]
      },
      {
        type: 'note',
        title: '安全与注意',
        content: 'Token 即权限：userToken 只读、adminToken 可写/删/编译，务必保密勿提交版本库；对外暴露请保持 authenticated:true。写类工具与 llm_query/vault_compile/tags_suggest 会消耗 LLM 配额。编译为异步流式，客户端超时应设不小于 120 秒。完整的协议说明、工具清单、curl 与客户端接入示例见 docs/mcp-interface.md。',
        noteType: 'warning'
      }
    ]
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
  {
    id: 'users',
    title: '用户管理',
    icon: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    intro: '管理系统账户，仅管理员可见。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '仅管理员可访问。展示用户总数 / 管理员数 / 普通用户数 / 已启用数统计；维护用户列表（用户名、角色、状态、创建时间、最后登录）。支持创建用户、编辑（修改角色、启用 / 禁用、重置密码）、删除用户。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '以管理员身份点击导航栏「用户管理」进入页面',
          '点击「＋ 新建用户」填写用户名、密码、角色（管理员 / 普通用户 / 游客）后创建',
          '在列表中点击某用户的「编辑」，可修改角色、启用 / 禁用开关、设置新密码（留空不修改）',
          '点击「删除」移除用户（不能删除当前登录账户，操作需二次确认）',
          '查看统计卡片与列表实时反映变更',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '多用户部署时分配账户与角色，回收离职人员访问权限，审计账户启用状态。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '角色分三级：管理员（全部功能）、普通用户（仪表盘 + 知识浏览 / 图谱 / 问答 + 公共辅助页）、游客（同普通用户）。删除当前登录账户被禁止，避免锁死管理员。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'skill',
    title: '技能管理',
    icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    intro: '导入与管理外部技能资源，仅管理员可见。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '仅管理员可访问。导入外部技能文件（.skill 为 ZIP 归档，.md 为 Markdown，单文件上限 10MB），导入时做安全校验并提示警告。支持列表浏览、按名称 / ID / 描述搜索、按格式（ZIP / MD）筛选、查看详情（SKILL.md 内容与文件结构）、删除技能。统计技能总数与占用空间。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '以管理员身份点击导航栏「技能管理」进入页面',
          '点击或拖拽文件到上传区，选择 .skill 或 .md 文件（≤10MB）',
          '等待导入完成，若含警告会弹窗提示',
          '使用搜索框与格式筛选定位技能，点击「查看详情」阅读 SKILL.md',
          '点击「删除」移除不再需要的技能（需确认）',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '扩展系统能力：将社区或自研的 Agent 技能以 .skill 形式导入，供问答工作流按场景调用。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '导入的技能文件会在后端解包并执行其内部逻辑，仅管理员可操作以防供应链风险。技能格式须符合 SKILL.md 规范，否则导入可能失败或仅部分生效。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'dataclean',
    title: '数据清洗',
    icon: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    intro: '扫描 Vault 质量、去重合并、修复与归档，仅管理员可见。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '仅管理员可访问（与系统清理同权限）。扫描 Vault 页面质量评分（评分 / 字数 / 链接 / 目录 / frontmatter / 问题），展示总页数、平均分、优秀 / 良好 / 需改进分布。支持 Vault 预检、重复检测（基于内容哈希 + Jaccard 相似度，提供配对视图与分组视图）、查看行级差异、合并重复页、归档选中页、修复 frontmatter。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          '以管理员身份点击导航栏「数据清洗」进入页面（自动扫描页面）',
          '点击「预检」执行 Vault 预检，查看错误 / 警告',
          '点击「去重」检测重复页面，在配对 / 分组视图查看相似度',
          '对某对重复点击「查看差异」对比行级 diff，点击「合并」将低质量页合并到高质量页',
          '勾选页面后点击「归档」移入 archive/YYYY-MM-DD/，或「修复 Frontmatter」补全元数据',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '知识库长期累积后清理重复与低质量页面、补全 frontmatter、归档过时内容，保持检索质量。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '归档与合并会改动 Vault 文件；合并默认保留质量较高的代表页并替换双向链接，建议先「预检」与「查看差异」确认。归档路径为 archive/YYYY-MM-DD/，操作前请确认选择范围。',
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
  if (!el) return;
  activeAnchor.value = id;
  // 为什么手动驱动滚动而不是 scrollIntoView：.help-sidebar 自身 overflow-y:auto，
  // scrollIntoView 会滚动最近的可滚动祖先（即侧栏），导致正文不定位。页面整体滚动由
  // App.vue 外层 main.content 接管，须显式计算其在 .content 中的偏移并设置 scrollTop。
  const container = document.querySelector('.content');
  if (container) {
    // 用 getBoundingClientRect 差值换算目标相对滚动容器的位置，
    // 顶部留小量间距避免章节标题紧贴视口上缘
    const cRect = (container as HTMLElement).getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    (container as HTMLElement).scrollTo({
      top: (container as HTMLElement).scrollTop + (eRect.top - cRect.top) - 16,
      behavior: 'smooth',
    });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// 监听滚动更新激活的锚点
// 注意：滚动由 App.vue 外层 main.content 统一接管，.help-content-area 自身无滚动，
// 因此 scroll-spy 必须监听 .content，否则下拉时高亮永不更新
function handleScroll() {
  const scrollContainer = document.querySelector('.content');
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
  // 同步本地加密状态（FR-RM-07）：若已登录且密钥在内存 / sessionStorage，则视为已开启
  cryptoOn.value = isUnlocked();
  const scrollContainer = document.querySelector('.content');
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
  }
});

// ===== 本地数据保护（FR-RM-07 加密 + 风险 R-2 导出备份）=====
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

// 复制代码块内容到剪贴板：优先 navigator.clipboard，失败降级 execCommand
// 为什么单独实现而非抽公共工具：仅此处使用，保持 Help.vue 自包含，避免引入额外依赖
async function handleCopyDocCode(text: string) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    ElMessage.success('已复制');
  } catch {
    ElMessage.warning('复制失败，请手动选择');
  }
}

onBeforeUnmount(() => {
  const scrollContainer = document.querySelector('.content');
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
          autocomplete="off"
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

              <!-- code：代码块（原样展示 JSON / 命令等，含语言徽标 + 复制按钮） -->
              <div v-else-if="block.type === 'code'" class="block-code">
                <div class="block-code-head">
                  <span class="code-lang-badge" v-if="block.codeLang">{{ block.codeLang }}</span>
                </div>
                <button
                  class="code-copy-btn"
                  :title="`复制${block.codeLang ? ' ' + block.codeLang : ''}`"
                  @click="handleCopyDocCode(block.content as string)"
                >复制</button>
                <pre><code>{{ block.content }}</code></pre>
              </div>
            </div>
          </div>
        </div>

        <div v-if="filteredSections.length === 0" class="empty-content">
          未找到匹配的章节
        </div>

        <!-- 本地数据保护（FR-RM-07 加密 + 风险 R-2 导出备份）-->
        <div id="local-data" class="glass-card section-card local-data-card">
          <div class="section-head">
            <div class="section-icon-wrap">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
              </svg>
            </div>
            <h3 class="section-title">本地数据保护</h3>
          </div>
          <p class="section-intro">
            问答会话与附件仅保存在本地浏览器（IndexedDB）。可开启加密（基于登录密码派生密钥）以防同设备其他进程读取，
            并建议定期导出加密备份以防丢失。
          </p>
          <div class="blocks">
            <div class="block">
              <div class="block-title">
                <span class="block-bullet feature"></span>
                <span>加密状态</span>
              </div>
              <p class="block-text">
                本地加密：<b>{{ cryptoOn ? '已开启' : '未启用' }}</b>；
                数据锁定：<b>{{ localLocked ? '已锁定（需解锁）' : '正常' }}</b>。
              </p>
            </div>

            <div class="block" v-if="localLocked">
              <div class="block-title">
                <span class="block-bullet steps"></span>
                <span>解锁本地数据</span>
              </div>
              <p class="block-text">
                检测到已加密的本地会话，请输入登录密码解锁以查看历史记录。
              </p>
              <div class="local-actions">
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

            <div class="block">
              <div class="block-title">
                <span class="block-bullet scenario"></span>
                <span>导出备份</span>
              </div>
              <p class="block-text note-text note-warning">
                风险 R-2：清除缓存 / 换设备 / 重装会导致本地数据丢失。请定期导出加密备份；
                备份使用<b>独立口令</b>，即使遗忘登录密码也可凭备份口令恢复本地数据。
              </p>
              <div class="local-actions">
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

            <div class="block">
              <div class="block-title">
                <span class="block-bullet config"></span>
                <span>导入备份</span>
              </div>
              <p class="block-text">
                从备份文件恢复会话与附件（合并写入本地）。导入前请输入备份时设置的口令。
              </p>
              <div class="local-actions">
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
  min-height: 100%;
}

.help-layout {
  display: flex;
  gap: 16px;
  /* 高度交给内容决定（不加 height 锁死），否则 sticky 侧栏会被压死在视口高内、
   * 长内容溢出后吸顶失效。align-items: flex-start 避免侧栏被拉伸到全高。 */
  min-height: 100%;
  align-items: flex-start;
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
  /* 目录树跟随屏幕：右侧内容下拉时侧栏吸附在视口顶部，始终可点击定位。
   * 滚动由外层 main.content 接管，sticky 相对它生效；max-height 限制在视口内，
   * 目录项过多时侧栏内部滚动而不溢出屏外。 */
  position: sticky;
  top: 0;
  max-height: calc(100vh - 24px);
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

/* code 块：深色底 + 语言徽标 + 复制按钮，横向可滚动适配长 JSON */
.block-code {
  position: relative;
  margin-top: 8px;
}

.block-code pre {
  margin: 0;
  padding: 14px 16px;
  background: var(--accent-purple-a10);
  border: 1px solid var(--accent-purple-a25);
  border-radius: 8px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-bright);
  white-space: pre;
}

.block-code code {
  font-family: inherit;
}

.block-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.code-lang-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--neon-purple);
  text-transform: uppercase;
}

.code-copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 2px 10px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
  background: var(--accent-purple-a12);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.code-copy-btn:hover {
  color: var(--neon-cyan);
  border-color: var(--accent-cyan-a50);
  background: var(--accent-cyan-a10);
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

/* 本地数据保护卡片 */
.local-data-card {
  border-left: 3px solid var(--neon-cyan);
}

.local-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-left: 16px;
  margin-top: 8px;
}

.local-actions input[type='file'] {
  max-width: 240px;
  font-size: 12px;
  color: var(--text-soft);
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
