/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useConversationsStore } from '../stores/conversations';
import { isUnlocked } from '../services/localVault';
import { createBackup, restoreBackup, downloadBackup, readBackupFile } from '../services/backup';
// ===== 12 个章节内容（与 App.vue 导航栏视图一一对应）=====
// 章节顺序：快速开始 → 关于 → 各功能模块 → 配置类 → 维护类
const DOC_SECTIONS = [
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
    if (!search.value.trim())
        return DOC_SECTIONS;
    const kw = search.value.toLowerCase();
    return DOC_SECTIONS.filter((s) => s.title.toLowerCase().includes(kw) || s.intro.toLowerCase().includes(kw));
});
// ===== 锚点导航 =====
const activeAnchor = ref('');
function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        activeAnchor.value = id;
    }
}
// 监听滚动更新激活的锚点
function handleScroll() {
    const scrollContainer = document.querySelector('.help-content-area');
    if (!scrollContainer)
        return;
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
    const scrollContainer = document.querySelector('.help-content-area');
    if (scrollContainer) {
        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    }
});
// ===== 本地数据保护（FR-RM-07 加密 + 风险 R-2 导出备份）=====
const conversationsStore = useConversationsStore();
const cryptoOn = ref(false);
const localLocked = computed(() => conversationsStore.localLocked);
const unlockPwd = ref('');
const exportPwd = ref('');
const importPwd = ref('');
const importFile = ref(null);
const busy = ref(false);
async function doUnlock() {
    if (!unlockPwd.value)
        return;
    try {
        await conversationsStore.unlockLocalData(unlockPwd.value);
        cryptoOn.value = true;
        ElMessage.success('本地数据已解锁');
        unlockPwd.value = '';
    }
    catch (e) {
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
    }
    catch (e) {
        ElMessage.error('导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
    finally {
        busy.value = false;
    }
}
function onFileChange(e) {
    const input = e.target;
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
    }
    catch (e) {
        ElMessage.error('导入失败：' + (e instanceof Error ? e.message : String(e)));
    }
    finally {
        busy.value = false;
    }
}
onBeforeUnmount(() => {
    const scrollContainer = document.querySelector('.help-content-area');
    if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', handleScroll);
    }
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['anchor-item']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-item']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['note-text']} */ ;
/** @type {__VLS_StyleScopedClasses['note-text']} */ ;
/** @type {__VLS_StyleScopedClasses['block-steps']} */ ;
/** @type {__VLS_StyleScopedClasses['block-config']} */ ;
/** @type {__VLS_StyleScopedClasses['block-config']} */ ;
/** @type {__VLS_StyleScopedClasses['block-config']} */ ;
/** @type {__VLS_StyleScopedClasses['block-config']} */ ;
/** @type {__VLS_StyleScopedClasses['local-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['help-sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['help-layout']} */ ;
/** @type {__VLS_StyleScopedClasses['section-intro']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "help-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "help-layout" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.aside, __VLS_intrinsicElements.aside)({
    ...{ class: "help-sidebar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sidebar-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "sidebar-title" },
});
const __VLS_0 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    modelValue: (__VLS_ctx.search),
    placeholder: "搜索章节...",
    prefixIcon: (__VLS_ctx.Search),
    size: "small",
    clearable: true,
    autocomplete: "off",
    ...{ class: "sidebar-search" },
}));
const __VLS_2 = __VLS_1({
    modelValue: (__VLS_ctx.search),
    placeholder: "搜索章节...",
    prefixIcon: (__VLS_ctx.Search),
    size: "small",
    clearable: true,
    autocomplete: "off",
    ...{ class: "sidebar-search" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_asFunctionalElement(__VLS_intrinsicElements.nav, __VLS_intrinsicElements.nav)({
    ...{ class: "anchor-nav" },
});
for (const [section] of __VLS_getVForSourceType((__VLS_ctx.filteredSections))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.scrollToSection(section.id);
            } },
        key: (section.id),
        href: ('#' + section.id),
        ...{ class: "anchor-item" },
        ...{ class: ({ active: __VLS_ctx.activeAnchor === section.id }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "currentColor",
        ...{ class: "anchor-icon" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: (section.icon),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "anchor-label" },
    });
    (section.title);
}
if (__VLS_ctx.filteredSections.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-anchor" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "help-content-area" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card intro-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "intro-content" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "intro-icon-wrap" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
    width: "32",
    height: "32",
    viewBox: "0 0 24 24",
    fill: "currentColor",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
    d: "M9 2L11 7L16 9L11 11L9 16L7 11L2 9L7 7L9 2Z",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "intro-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "intro-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "intro-desc" },
});
for (const [section] of __VLS_getVForSourceType((__VLS_ctx.filteredSections))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (section.id),
        id: (section.id),
        ...{ class: "glass-card section-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-icon-wrap" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        width: "22",
        height: "22",
        viewBox: "0 0 24 24",
        fill: "currentColor",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: (section.icon),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "section-title" },
    });
    (section.title);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "section-intro" },
    });
    (section.intro);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-divider" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "blocks" },
    });
    for (const [block] of __VLS_getVForSourceType((section.blocks))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (block.title),
            ...{ class: "block" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "block-title" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "block-bullet" },
            ...{ class: (block.type) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (block.title);
        if (block.type === 'feature' || block.type === 'scenario') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "block-text" },
            });
            (block.content);
        }
        else if (block.type === 'note') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "block-text note-text" },
                ...{ class: ('note-' + (block.noteType || 'info')) },
            });
            (block.content);
        }
        else if (block.type === 'steps') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.ol, __VLS_intrinsicElements.ol)({
                ...{ class: "block-steps" },
            });
            for (const [step, idx] of __VLS_getVForSourceType(block.content)) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                    key: (idx),
                });
                (step);
            }
        }
        else if (block.type === 'config') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "block-config" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.table, __VLS_intrinsicElements.table)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
            for (const [row, idx] of __VLS_getVForSourceType(block.content)) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
                    key: (idx),
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
                (row[0]);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "cell-example" },
                });
                (row[1]);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "cell-desc" },
                });
                (row[2]);
            }
        }
    }
}
if (__VLS_ctx.filteredSections.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-content" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    id: "local-data",
    ...{ class: "glass-card section-card local-data-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-icon-wrap" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
    width: "22",
    height: "22",
    viewBox: "0 0 24 24",
    fill: "currentColor",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
    d: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "section-intro" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "blocks" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bullet feature" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "block-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
(__VLS_ctx.cryptoOn ? '已开启' : '未启用');
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
(__VLS_ctx.localLocked ? '已锁定（需解锁）' : '正常');
if (__VLS_ctx.localLocked) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bullet steps" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "block-text" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "local-actions" },
    });
    const __VLS_4 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
        modelValue: (__VLS_ctx.unlockPwd),
        type: "password",
        showPassword: true,
        placeholder: "登录密码",
        size: "small",
        ...{ style: {} },
    }));
    const __VLS_6 = __VLS_5({
        modelValue: (__VLS_ctx.unlockPwd),
        type: "password",
        showPassword: true,
        placeholder: "登录密码",
        size: "small",
        ...{ style: {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_5));
    const __VLS_8 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        ...{ 'onClick': {} },
        size: "small",
        type: "primary",
        disabled: (!__VLS_ctx.unlockPwd),
    }));
    const __VLS_10 = __VLS_9({
        ...{ 'onClick': {} },
        size: "small",
        type: "primary",
        disabled: (!__VLS_ctx.unlockPwd),
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    let __VLS_12;
    let __VLS_13;
    let __VLS_14;
    const __VLS_15 = {
        onClick: (__VLS_ctx.doUnlock)
    };
    __VLS_11.slots.default;
    var __VLS_11;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bullet scenario" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "block-text note-text note-warning" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "local-actions" },
});
const __VLS_16 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
    modelValue: (__VLS_ctx.exportPwd),
    type: "password",
    showPassword: true,
    placeholder: "备份口令",
    size: "small",
    ...{ style: {} },
}));
const __VLS_18 = __VLS_17({
    modelValue: (__VLS_ctx.exportPwd),
    type: "password",
    showPassword: true,
    placeholder: "备份口令",
    size: "small",
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_17));
const __VLS_20 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    disabled: (!__VLS_ctx.exportPwd || __VLS_ctx.busy),
}));
const __VLS_22 = __VLS_21({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    disabled: (!__VLS_ctx.exportPwd || __VLS_ctx.busy),
}, ...__VLS_functionalComponentArgsRest(__VLS_21));
let __VLS_24;
let __VLS_25;
let __VLS_26;
const __VLS_27 = {
    onClick: (__VLS_ctx.doExport)
};
__VLS_23.slots.default;
var __VLS_23;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bullet config" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "block-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "local-actions" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onChange: (__VLS_ctx.onFileChange) },
    type: "file",
    accept: "application/json,.json",
});
const __VLS_28 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
    modelValue: (__VLS_ctx.importPwd),
    type: "password",
    showPassword: true,
    placeholder: "备份口令",
    size: "small",
    ...{ style: {} },
}));
const __VLS_30 = __VLS_29({
    modelValue: (__VLS_ctx.importPwd),
    type: "password",
    showPassword: true,
    placeholder: "备份口令",
    size: "small",
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
const __VLS_32 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    disabled: (!__VLS_ctx.importFile || !__VLS_ctx.importPwd || __VLS_ctx.busy),
}));
const __VLS_34 = __VLS_33({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    disabled: (!__VLS_ctx.importFile || !__VLS_ctx.importPwd || __VLS_ctx.busy),
}, ...__VLS_functionalComponentArgsRest(__VLS_33));
let __VLS_36;
let __VLS_37;
let __VLS_38;
const __VLS_39 = {
    onClick: (__VLS_ctx.doImport)
};
__VLS_35.slots.default;
var __VLS_35;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "help-footer" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-line" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-line" },
});
/** @type {__VLS_StyleScopedClasses['help-page']} */ ;
/** @type {__VLS_StyleScopedClasses['help-layout']} */ ;
/** @type {__VLS_StyleScopedClasses['help-sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-header']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-title']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-search']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-nav']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-item']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['anchor-label']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-anchor']} */ ;
/** @type {__VLS_StyleScopedClasses['help-content-area']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-content']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-icon-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-text']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['intro-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['section-intro']} */ ;
/** @type {__VLS_StyleScopedClasses['section-divider']} */ ;
/** @type {__VLS_StyleScopedClasses['blocks']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['block-text']} */ ;
/** @type {__VLS_StyleScopedClasses['block-text']} */ ;
/** @type {__VLS_StyleScopedClasses['note-text']} */ ;
/** @type {__VLS_StyleScopedClasses['block-steps']} */ ;
/** @type {__VLS_StyleScopedClasses['block-config']} */ ;
/** @type {__VLS_StyleScopedClasses['cell-example']} */ ;
/** @type {__VLS_StyleScopedClasses['cell-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-content']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['local-data-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['section-intro']} */ ;
/** @type {__VLS_StyleScopedClasses['blocks']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['feature']} */ ;
/** @type {__VLS_StyleScopedClasses['block-text']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['steps']} */ ;
/** @type {__VLS_StyleScopedClasses['block-text']} */ ;
/** @type {__VLS_StyleScopedClasses['local-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['scenario']} */ ;
/** @type {__VLS_StyleScopedClasses['block-text']} */ ;
/** @type {__VLS_StyleScopedClasses['note-text']} */ ;
/** @type {__VLS_StyleScopedClasses['note-warning']} */ ;
/** @type {__VLS_StyleScopedClasses['local-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bullet']} */ ;
/** @type {__VLS_StyleScopedClasses['config']} */ ;
/** @type {__VLS_StyleScopedClasses['block-text']} */ ;
/** @type {__VLS_StyleScopedClasses['local-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['help-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-line']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-text']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-line']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Search: Search,
            search: search,
            filteredSections: filteredSections,
            activeAnchor: activeAnchor,
            scrollToSection: scrollToSection,
            cryptoOn: cryptoOn,
            localLocked: localLocked,
            unlockPwd: unlockPwd,
            exportPwd: exportPwd,
            importPwd: importPwd,
            importFile: importFile,
            busy: busy,
            doUnlock: doUnlock,
            doExport: doExport,
            onFileChange: onFileChange,
            doImport: doImport,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
