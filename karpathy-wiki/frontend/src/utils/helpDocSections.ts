// T02784（PRD「与代码同源」推广）：帮助文档章节数据模块。
// 此前 600+ 行文案内联在 Help.vue 的 <script setup> 里，测试只能挂载组件读 DOM；
// 抽到本模块后：
//   1. 章节结构可被单测直接 import，按章节 id 定位断言，失败直接知道哪章漂移；
//   2. 页面实名（菜单名、配置页签名、清理目标、问题分类、编译阶段词、守卫提示原文）
//      一律从单一来源导出拼接，不在文档里抄第二份——页面改名文档跟着变。
// 写法模板沿用 T02698（users 章节先例）；回归测试在 test/help-doc-code-sync.test.ts。
import { menuItems, type ViewName } from '../config/menu';
import { CONFIG_TAB_GROUPS, type ConfigTabName } from './configTabs';
import {
  CLEANUP_CARDS,
  CLEANUP_PAGE_TITLE,
  buildPreviewBanner,
} from './cleanupPresentation';
import { ISSUE_CATEGORIES, PAGE_SCOPE_DIRS, type IssueKey } from './dataCleanPresentation';
import { STEP_LABEL } from '../stores/compile';
import {
  PASSWORD_RULE,
  SEED_ACCOUNT_HINT,
  SEED_ACCOUNT_NAMES,
  USERNAME_RULE,
  deleteGuard,
  disableGuard,
} from './userManagePresentation';

// ===== 单一来源取词的辅助 =====
const menuLabel = (key: ViewName): string => menuItems.find((m) => m.key === key)?.label ?? '';

const tabLabel = (name: ConfigTabName): string =>
  CONFIG_TAB_GROUPS.flatMap((g) => g.tabs).find((t) => t.name === name)?.label ?? name;

const tabCount = CONFIG_TAB_GROUPS.reduce((n, g) => n + g.tabs.length, 0);
const adminOnlyTabCount = CONFIG_TAB_GROUPS.flatMap((g) => g.tabs).filter((t) => t.adminOnly).length;

// 「点击导航栏「X」进入页面」：菜单实名不再逐章手抄
const enterStep = (key: ViewName): string => `点击导航栏「${menuLabel(key)}」进入页面`;

// 编译阶段链（quickstart / progress 章）：从 compile store 的步骤实名表拼出，
// 后端 step 标识或阶段措辞变化时文档跟着变
const COMPILE_STAGE_CHAIN = ['read_schema', 'extract', 'generate_page', 'update_index']
  .map((k) => STEP_LABEL[k] ?? k)
  .join(' → ');

// 缓存与日志清理（cleanup 章）：四类目标的名称/说明/后果全部来自页面卡片定义
const CLEANUP_TARGET_CHAIN = CLEANUP_CARDS.map((c) => c.target).join('/');
const CLEANUP_DAYS_TARGETS = CLEANUP_CARDS.filter((c) => c.showDays).map((c) => c.target).join('/');
const CLEANUP_DAYS_TITLES = CLEANUP_CARDS.filter((c) => c.showDays).map((c) => c.title).join(' / ');
const CLEANUP_FEATURE_TEXT =
  CLEANUP_CARDS.map((c) => `${c.title}＝${c.plain}${c.consequence}`).join('') +
  `「仅预览」是页级单一开关，默认开启。${buildPreviewBanner(false)}`;

// 页面质量清洗（dataclean 章）：问题分类实名与批量动作来自 ISSUE_CATEGORIES
const issueDef = (key: IssueKey): (typeof ISSUE_CATEGORIES)[number] => {
  const def = ISSUE_CATEGORIES.find((c) => c.key === key);
  if (!def) throw new Error(`未知问题分类：${key}`);
  return def;
};
const DATA_CLEAN_PAGE_TYPES = PAGE_SCOPE_DIRS.join(' / ');
const DATA_CLEAN_LABELS = ISSUE_CATEGORIES.map((c) => c.label).join('、');
const DATA_CLEAN_FILL_ACTION = issueDef('missingFrontmatter').action;

// 用户管理（users 章）引用的规则原文（T02698）：不抄第二份，直接从守卫函数用「必然被拦」的上下文算出来。
// 这样页面上的 data-tip 改了而文档没改时，文档里的句子也跟着变——两者不可能各说一套。
const GUARD_DELETE_SELF = deleteGuard(
  { id: 'someone', role: 'user' },
  { currentUserId: 'someone', adminCount: 2, activeAdminCount: 2 },
).reason;
const GUARD_DELETE_LAST_ADMIN = deleteGuard(
  { id: 'admin1', role: 'admin' },
  { currentUserId: 'someone', adminCount: 1, activeAdminCount: 1 },
).reason;
const GUARD_DISABLE_SELF = disableGuard(
  { id: 'someone', role: 'user', enabled: true },
  { currentUserId: 'someone', adminCount: 2, activeAdminCount: 2 },
).reason;
const GUARD_DISABLE_LAST_ADMIN = disableGuard(
  { id: 'admin1', role: 'admin', enabled: true },
  { currentUserId: 'someone', adminCount: 2, activeAdminCount: 1 },
).reason;
const SEED_ACCOUNT_LIST = SEED_ACCOUNT_NAMES.join(' / ');

// ===== 类型定义 =====
// 内容抽象为数据，渲染逻辑与内容分离，便于维护
export type BlockType = 'feature' | 'steps' | 'scenario' | 'config' | 'note' | 'code';

export interface DocBlock {
  type: BlockType;
  title: string;
  // 不同类型对应不同载荷：steps/config 走结构化数据，feature/scenario/note 走字符串
  content: string | string[] | Array<[string, string, string]>;
  noteType?: 'info' | 'warning';
  // code 类型：展示代码语言标记（用于顶部小徽标，如 json / shell）
  codeLang?: string;
  // T02455（PRD D1x）：步骤块的可点击直达动作——跳到真实菜单路径（可带 tab）
  action?: { label: string; view: string; tab?: string };
}

export interface DocSection {
  id: string;
  title: string;
  icon: string; // SVG 路径字符串
  intro: string;
  blocks: DocBlock[];
  // T02455（PRD D2x）：子功能条目（如配置中心下的 MCP 接口）缩进一级显示，不与一级菜单平级
  sub?: boolean;
}

// ===== 15 个导航视图，本文档覆盖其全部（用户管理 / 技能管理 / 页面质量清洗 随迭代新增）=====
// 章节顺序：快速开始 → 关于 → 各功能模块 → 配置类 → 维护类
export const DOC_SECTIONS: DocSection[] = [
  {
    id: 'quickstart',
    title: '快速开始',
    icon: 'M9 2L11 7L16 9L11 11L9 16L7 11L2 9L7 7L9 2Z',
    intro: '从安装到首次问答的完整流程，新用户必读。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: 'Karpathy Wiki 是基于 LLM 的本地知识库问答系统。投递 Markdown / URL / 纯文本资料后，系统自动编译生成知识页面，支持基于引用的问答、知识图谱可视化、体检中心、内网穿透远程访问。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        // T02455（D1x）：文档路径精确到 tab，并提供可点击直达按钮（与菜单实名一致）
        action: { label: `前往：配置中心 → ${tabLabel('ai')}`, view: 'config', tab: 'ai' },
        content: [
          `配置 LLM：进入「配置中心 → ${tabLabel('ai')}」标签页，选择 LLM 预设（OpenAI/DeepSeek/GLM/Qwen 等），填入 API Key 并保存`,
          `投递资料：进入「${menuLabel('ingest')}」页面，拖拽 .md 文件 / 粘贴 URL / 输入纯文本，点击「开始编译」`,
          `查看进度：进入「${menuLabel('progress')}」页面，观察「${COMPILE_STAGE_CHAIN}」各阶段进度`,
          `知识问答：进入「${menuLabel('query')}」页面，输入问题，AI 基于本地知识库回答并引用相关页面`,
          `可选 - 体检：进入「${menuLabel('health')}」页面，检测孤立页面、断链、过期内容`,
          `可选 - 远程访问：进入「${menuLabel('tunnel')}」页面，启动 Cloudflare 隧道暴露本机服务到公网`,
          `管理员专属：进入「${(['users', 'skill', 'dataclean'] as const).map(menuLabel).join(' / ')}」维护账户、技能与知识库质量`,
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
          `点击导航栏「${menuLabel('about')}」进入页面`,
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
    title: menuLabel('dashboard'),
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
          enterStep('dashboard'),
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
    title: menuLabel('ingest'),
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
          enterStep('ingest'),
          '选择投递方式：文件 / 文件夹 / URL / 文本 / 书签 / QQ',
          '文件方式：拖拽 .md 文件到上传区，或点击选择文件',
          'URL 方式：粘贴网页链接，系统自动抓取正文',
          '文本方式：直接在编辑器输入 Markdown 内容',
          `点击「开始编译」提交，自动跳转到「${menuLabel('progress')}」页面`,
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
    title: menuLabel('progress'),
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    intro: '实时查看编译流程，支持断点续传。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: `通过 SSE 流式推送编译进度：${COMPILE_STAGE_CHAIN} → 完成。支持断点续传，中断后可从上次断点恢复。`,
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          `在「${menuLabel('ingest')}」页提交后自动跳转至「${menuLabel('progress')}」`,
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
    title: menuLabel('browse'),
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
          enterStep('browse'),
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
    title: menuLabel('query'),
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
          enterStep('query'),
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
    title: menuLabel('graph'),
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
          enterStep('graph'),
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
    title: menuLabel('health'),
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
          enterStep('health'),
          '点击「重新体检」按钮',
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
    title: menuLabel('config'),
    icon: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    intro: 'LLM 服务、联网搜索、工具、朗读与系统级配置。页内按「个人偏好 / AI 服务 / 系统」三组分区，无权限的项置灰保留并标注「仅管理员」，不会消失。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: `配置中心左侧是分组导航，共 ${CONFIG_TAB_GROUPS.length} 组 ${tabCount} 个页签。${CONFIG_TAB_GROUPS.map((g) => g.label).join('、')}。个人偏好：朗读设置、界面主题、数据备份——只影响当前浏览器里的你自己。AI 服务：AI 服务（本用户的模型与私有 Key）、共享 AI（仅管理员）、Prompt IDE（仅管理员）。系统：系统配置、SCHEMA 规范、MCP 接口、工具配置、QQ 导入、数据迁移。两处容易找错：联网搜索是「AI 服务」页签内的分区，批量编译是「系统配置」页签内「高级配置」的分区，它们都不是独立页签。本地问答会话的解锁 / 导出 / 导入在「数据备份」页签（已从帮助文档迁入，见文末「本地数据保护」）。仅管理员可改的 ${adminOnlyTabCount} 个页签对普通用户置灰保留（不隐藏），点开会收到一句「仅管理员可查看和修改」的说明，而不是被静默送到别的页签。`,
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
        type: 'feature',
        title: '字段旁的标签说明它什么时候生效',
        content: '可保存的字段旁有一枚生效标签，含义在页顶图例里解释一次：「即时生效」= 保存即写入运行时，下一次使用就是新值；「改文件需热加载」= 直接编辑 config.json 只落盘，需点「热加载配置」才会被运行时读到，在本页保存则即时生效；「需重启服务」= 该值在进程启动时固定，保存后仍需重启服务才完全生效。只要有过一次保存落到「需重启服务」，页顶会常驻一条待重启汇总并逐项列出改了哪些字段；重启服务后点「我已重启，清除」收掉它——没真重启就别点，否则改动实际还没落地。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        // T02623：配置中心章节自身也给直达；tab 用系统组实名，普通用户点开会看到权限说明而不是静默跳页
        action: { label: `前往：配置中心 → ${tabLabel('config')}`, view: 'config', tab: 'config' },
        content: [
          `${enterStep('config')}（所有登录用户均可进入）`,
          `（个人）在「${tabLabel('ai')}」页签选择 LLM 预设或自定义输入，填入本账户 API Key，点击「测试连接」后保存（仅存本机）`,
          `（个人）联网搜索不是独立页签——在「${tabLabel('ai')}」页签内的「联网搜索」分区配置 Tavily / Bing 的 Key 并启用`,
          `（个人）在「${tabLabel('tools')}」页签配置 MCP / CLI / 场景路由，在「${tabLabel('tts')}」调整 TTS，在「${tabLabel('theme')}」切换外观`,
          `（管理员）在「系统」组的「系统配置 / SCHEMA 规范 / MCP 接口 / QQ 导入 / 数据迁移」，以及「AI 服务」组的「${tabLabel('sharedAi')} / ${tabLabel('prompts')}」编辑系统级配置并保存`,
          `（管理员）批量编译与运行参数、健康检查同在「${tabLabel('config')}」页签的「高级配置」分区内，不是独立页签`,
          '动手前先看字段旁的生效标签；改到需重启的字段后，页顶会汇总待重启项，重启后点「我已重启，清除」',
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
    sub: true, // T02455（D2x）：配置中心下的子功能，目录与标题均缩进一级
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
    title: menuLabel('tunnel'),
    icon: 'M20 10V8c0-1.1-.9-2-2-2h-7V5c0-.55-.45-1-1-1H6c-.55 0-1 .45-1 1v2c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h13c1.1 0 2-.9 2-2v-1h2v-5h-2z',
    intro: 'Cloudflare / cpolar / tailscale 三种隧道方案。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '支持 3 种内网穿透方案：Cloudflare Tunnel（quick 临时域名 / named 固定域名）、cpolar（国内高速）、tailscale（P2P 直连）。可配置开机自启，启动后获取公网访问 URL。页面上方有「前置条件自检」卡片，按「已满足 / 未满足 / 待确认」三态逐项列出条件（隧道程序、授权证书、命名隧道与配置文件、域名指向等），点「重新检测」按当前配置复跑；启动失败时后端原因会翻译成一句人话直接显示在页面上，不必再翻日志。',
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
          enterStep('tunnel'),
          '选择 Provider（推荐 Cloudflare quick 模式）——切换只改表单，不会自己写盘',
          '按需改端口 / 程序路径 / 开机自启，点「保存配置」写入；页面上方若出现「N 项改动尚未保存」，说明还有改动没落盘',
          '看「前置条件自检」卡片，标红/标黄的项按它给的入口处理，处理完点「重新检测」',
          '点击「启动隧道」',
          '等待 5-15 秒获取公网 URL',
          '点击 URL 在新窗口打开访问',
          '可选：点击「停止」关闭隧道',
          '启动失败时读页面顶部内联告警条（原因 + 建议动作），修好再重试',
        ],
      },
      {
        type: 'note',
        title: '注意事项',
        content: 'quick 模式每次重启 URL 都会变化；named 模式需先执行 cloudflared tunnel 三步向导（创建隧道、配置 credentials、绑定 hostname）。CORS 默认仅放行 localhost，tunnel 域名需手动加白。配置改动只有点「保存配置」才生效——带着未保存改动点「启动隧道」，会先问你「保存并启动」还是「按已保存配置启动」（启动读的是已保存的那一份）。切换 Provider 会换掉公网地址，已分享出去的链接随之失效；隧道正在运行时切换不会中断它，需保存后停止并重新启动才换服务商。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'cleanup',
    title: menuLabel('cleanup'),
    icon: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    // T02784：四类目标不再手抄，来自 cleanupPresentation.CLEANUP_CARDS（与页面卡片同源）
    intro: `只删运行产生的缓存与日志，不改动知识库内容。可清四类：${CLEANUP_CARDS.map((c) => c.title).join('、')}。`,
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: CLEANUP_FEATURE_TEXT,
      },
      {
        type: 'config',
        title: '参数配置',
        content: [
          ['target', 'all', `清理目标：${CLEANUP_TARGET_CHAIN}/all`],
          ['days', '30', `保留天数（仅 ${CLEANUP_DAYS_TARGETS} 使用）`],
          ['dry_run', 'true', '由页顶「仅预览（不实际执行）」开关统一控制：true 仅列出，false 实际执行'],
        ],
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          enterStep('cleanup'),
          `查看 ${CLEANUP_CARDS.length} 类对象的占用（大小 / 文件数 / 最早时间）`,
          '保持页顶「仅预览（不实际执行）」开启，点「清理××」只会列出会删哪些文件',
          '需要真实删除时关闭该开关——页面顶部出现红色横幅，点击后仍会弹二次确认',
          `按保留天数清理的两类（${CLEANUP_DAYS_TITLES}）可先调整天数`,
          '某类没有可清对象时按钮显示「无需清理」并置灰',
          '想看实际路径与技术说明，点「高级：查看实际路径与技术说明」',
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
    title: menuLabel('users'),
    icon: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    intro: '管理系统账户、角色与启停状态，仅管理员可见；对随代码公开的出厂账号给出风险告警。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        content: '统计卡片给出账户总数 / 管理员数 / 普通用户数 / 已启用数；表格列用户名、角色、状态、创建时间、最后登录，支持按用户名搜索、按这四列排序与分页，筛空时可「清空筛选」。行内操作是「编辑」和「停用 / 启用」，表头是「新建用户」与「刷新」。仍启用的出厂账号会打「出厂账号」标记，并在页顶给一条告警与「一键停用可停用的出厂账号」。',
      },
      {
        type: 'config',
        title: '输入规则（与后端校验同源，报错原文一致）',
        content: [
          ['用户名', 'wiki_admin', USERNAME_RULE],
          ['密码', '不显示明文', PASSWORD_RULE],
          ['角色', '管理员 / 普通用户 / 游客', '只有本页能指定角色；公开的注册接口会强制按普通用户创建，请求体里带的角色被忽略（防权限提升）'],
          ['出厂账号', SEED_ACCOUNT_LIST, SEED_ACCOUNT_HINT],
        ],
      },
      {
        type: 'feature',
        title: '四条改不动的红线',
        content: `按钮置灰时把鼠标停在上面就是这句原因，文档与它逐字一致：${GUARD_DELETE_SELF}；${GUARD_DELETE_LAST_ADMIN}；${GUARD_DISABLE_SELF}；${GUARD_DISABLE_LAST_ADMIN}。前两条管删除，后两条管停用与降级——目的是不让任何人把自己或整个系统锁在管理页之外。`,
      },
      {
        type: 'feature',
        title: '停用和删除有什么不同',
        content: '停用：该账户已登录的会话立即失效、无法再登录，但随时可以「启用」恢复，账户记录与历史都留着。删除：同样立即销毁其会话，且不可撤销。两者都不影响该账户此前产生的页面与操作记录。另外「编辑」里给账户重置口令不会把对方踢下线——已登录的会话继续有效，需要它立刻下线请改用「停用」。',
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          `以管理员身份${enterStep('users')}`,
          '点「新建用户」，填用户名与密码（规则见上表），选角色后点「创建」',
          '在搜索框（占位提示「搜索用户名」）定位账户，点表头可按用户名 / 角色 / 创建时间 / 最后登录排序；筛空后点「清空筛选」',
          '点某行的「编辑」可改角色、启停状态，或在「新密码（留空表示不修改）」里填新口令，改完点「保存」',
          '「停用」和「删除」都在行内，都会先弹二次确认；被红线保护的按钮直接置灰并写明原因，不会点了才告诉你不行',
          '页顶出现出厂账号告警时，点「一键停用可停用的出厂账号」批量处理（当前登录账户与唯一启用管理员不会被波及）',
        ],
      },
      {
        type: 'steps',
        title: '出厂账号处置顺序（真实部署）',
        content: [
          '先用出厂 admin 登录；生产环境（非本地调试模式）首次登录会被要求修改口令',
          '点「新建用户」新建你自己的管理员账户，创建时角色直接选「管理员」（创建页允许指定角色）',
          '退出出厂 admin，改用新管理员登录——此时告警里 admin 的「停用」按钮不再受「当前登录账户」保护',
          '逐项停用仍启用的 admin 与 user；guest 出厂即为停用。停用保留账户记录，需要时可再启用',
          '本地调试模式（localOnly）不强制改密：出厂账号只用于本机调试，不要用于对外提供服务',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '多用户部署时分配账户与角色；回收离职人员访问权限用「停用」（保留记录、可恢复），确认不再需要该账户才用「删除」。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '角色分三级：管理员（全部功能）、普通用户（仪表盘 + 知识浏览 / 图谱 / 问答 + 公共辅助页）、游客（当前与普通用户同权）。出厂账号若仍在使用默认口令，会在首次登录时被要求强制改密（本地调试模式除外），文档不记录默认口令本身。登录有防爆破限流：单 IP 每分钟 10 次、单用户名每分钟 5 次，超限返回 429。登录、登出、越权与用户管理操作都会追加写入审计日志；写入侧自动保留最近 1 万条（超出后最旧的记录被轮转淘汰）。管理员在「用户管理」页点「审计日志」即可查看最近 1000 条（时间 / 动作 / 账户 / IP / 结果，可按动作与账户筛选），也可以直接调 GET /api/auth/audit-log 取同样的数据。',
        noteType: 'warning',
      },
    ],
  },
  {
    id: 'skill',
    title: menuLabel('skill'),
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
          `以管理员身份${enterStep('skill')}`,
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
    title: menuLabel('dataclean'),
    icon: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    intro: '扫描知识库页面质量、查重合并、补元信息与归档，只处理页面内容；临时缓存与日志在「缓存与日志清理」。',
    blocks: [
      {
        type: 'feature',
        title: '核心功能',
        // T02784：页面目录口径与问题分类实名不再手抄，来自 dataCleanPresentation（与页面卡片同源）
        content: `仅管理员可执行改动文件的操作（与缓存与日志清理同权限）。页面总数与仪表盘同源（${DATA_CLEAN_PAGE_TYPES} 六类页面，不含联调遗留的测试文件）。统计区不再显示「平均分 / 优秀 / 需改进」，改为五类可操作问题：${DATA_CLEAN_LABELS}，每类直接给批量动作。表格支持搜索路径与标题、按目录筛选、点列头排序（默认问题数倒序）、50/100/200 分页；翻页与其他页勾选会保留。另提供 Vault 预检（只读）、重复检测（内容哈希 + Jaccard 相似度，配对视图与分组视图）、行级差异对比、合并重复页、归档、补齐元信息，以及调用你自己模型的 AI 分析。`,
      },
      {
        type: 'steps',
        title: '操作步骤',
        content: [
          `${enterStep('dataclean')}（自动扫描知识库页面）`,
          '看上方五张问题分类卡：数字为 0 表示没有这类问题；有数字时点「只看这类」把表格筛到该类，再点批量按钮处理',
          `「${issueDef('missingFrontmatter').label}」卡的「${DATA_CLEAN_FILL_ACTION}」直接为这批页面写入 type 与 title（需管理员）`,
          `「${issueDef('duplicateTitle').label}」卡会选中这类页面并重跑重复检测，在配对 / 分组视图看相似度，再点「查看差异」对比行级 diff 或「合并」把低质量页并入代表页`,
          '在搜索框输入路径或标题关键字、用目录下拉缩小范围，点列头改排序，表格下方翻页',
          '勾选页面后用工具栏「归档」移入 archive/YYYY-MM-DD/，或「永久删除」（不可撤销，需管理员）',
        ],
      },
      {
        type: 'scenario',
        title: '使用场景',
        content: '知识库长期累积后清理重复与低质量页面、补全元信息、归档过时内容，保持检索与图谱质量。',
      },
      {
        type: 'note',
        title: '注意事项',
        content: '归档、删除、合并与补齐元信息都会改动知识库文件；合并默认保留质量较高的代表页并替换双向链接，建议先「预检」与「查看差异」确认。非管理员账户这些按钮会整组置灰并说明需要管理员。AI 分析调用你在「配置 / 我的」填写的模型，按你的额度计费。',
        noteType: 'warning',
      },
    ],
  },
];
