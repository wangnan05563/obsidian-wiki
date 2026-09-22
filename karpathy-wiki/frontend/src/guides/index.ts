// 用户引导向导系统 · 配置数据
//
// 为什么把引导内容抽成纯数据而非硬编码进组件：便于逐菜单扩展步骤、
//   且高亮目标选择器集中管理，视觉/文案调整无需触碰核心组件。
//
// GuideStep.target 为高亮目标元素选择器（document.querySelector 定位），
//   缺省（空串）时高亮主内容区 .content。
// 侧边栏导航按钮已统一注入 data-guide="{viewKey}" 属性，引导首步据此定位对应菜单按钮。

export interface GuideStep {
  /** 高亮目标元素选择器；空串=高亮主内容区（.content） */
  target: string;
  /** 引导步骤标题 */
  title: string;
  /** 引导步骤说明文字 */
  description: string;
  /** 气泡相对高亮目标的位置：right/left/top/bottom/center */
  placement: 'right' | 'left' | 'top' | 'bottom' | 'center';
}

export interface GuideDefinition {
  /** 归属视图 key（与 App.vue 的 ViewName 对应） */
  view: string;
  /** 引导标题（常驻按钮/首步展示） */
  title: string;
  /** 引导步骤列表，至少 1 步 */
  steps: GuideStep[];
}

// 各菜单首次访问引导定义。
// 结构约定：
//   - 第 1 步 target 指向侧边栏对应菜单按钮 [data-guide=key]，说明「这是什么菜单」；
//   - 后续步骤 target 指向主内容区 .content，介绍该模块关键功能入口/操作方式。
// 菜单 key 与 App.vue menuItems 保持一致，未配置的视图不产生自动引导。
export const GUIDE_DEFINITIONS: Record<string, GuideDefinition> = {
  dashboard: {
    view: 'dashboard',
    title: '仪表盘',
    steps: [
      { target: '[data-guide="dashboard"]', title: '仪表盘', description: '这里是您的工作台，展示知识库整体概况与关键指标，帮助您快速掌握当前状态。', placement: 'right' },
      { target: '.content', title: '概览模块', description: '可查看知识库统计、最近活动与系统健康度摘要。', placement: 'top' },
    ],
  },
  ingest: {
    view: 'ingest',
    title: '投递资料',
    steps: [
      { target: '[data-guide="ingest"]', title: '投递资料', description: '这是知识库的内容入口，负责将外部资料导入系统。', placement: 'right' },
      { target: '.content', title: '资料投递', description: '上传 QQ 聊天记录或文本资料，触发 LLM 抽取为结构化知识页面。', placement: 'top' },
      { target: '.content', title: '抽取流程', description: '投递后可在「编译进度」中查看抽取与编译过程。', placement: 'top' },
    ],
  },
  progress: {
    view: 'progress',
    title: '编译进度',
    steps: [
      { target: '[data-guide="progress"]', title: '编译进度', description: '查看知识抽取与编译任务的实时进度。', placement: 'right' },
      { target: '.content', title: '任务监控', description: '展示编译批次、成功/失败状态，支持中途取消。', placement: 'top' },
    ],
  },
  browse: {
    view: 'browse',
    title: '知识浏览',
    steps: [
      { target: '[data-guide="browse"]', title: '知识浏览', description: '以目录树/章节/看板/日历等视图浏览知识库全部页面。', placement: 'right' },
      { target: '.content', title: '多视图浏览', description: '切换目录树、看板、日历等视图，并支持多文档 Tab 浏览。', placement: 'top' },
      { target: '.content', title: '编辑与全屏', description: '打开文档后可编辑、保存、全屏查看内容。', placement: 'top' },
    ],
  },
  query: {
    view: 'query',
    title: '知识问答',
    steps: [
      { target: '[data-guide="query"]', title: '知识问答', description: '基于知识库内容向 AI 提问，获取带引用的回答。', placement: 'right' },
      { target: '.content', title: '智能问答', description: '输入问题，AI 结合知识库给出可溯源的答案与参考资料。', placement: 'top' },
    ],
  },
  graph: {
    view: 'graph',
    title: '知识图谱',
    steps: [
      { target: '[data-guide="graph"]', title: '知识图谱', description: '以关系图谱方式展示知识点之间的关联。', placement: 'right' },
      { target: '.content', title: '图谱交互', description: '节点/连线可视化知识关联，可切换质量/性能模式。', placement: 'top' },
    ],
  },
  health: {
    view: 'health',
    title: '体检中心',
    steps: [
      { target: '[data-guide="health"]', title: '体检中心', description: '对系统服务、依赖与知识库数据做健康检查。', placement: 'right' },
      { target: '.content', title: '健康检查', description: '检测后端各项服务与页面状态，及时发现问题。', placement: 'top' },
    ],
  },
  config: {
    view: 'config',
    title: '配置中心',
    steps: [
      { target: '[data-guide="config"]', title: '配置中心', description: '集中管理系统配置、AI 服务、工具与 Prompt 等。', placement: 'right' },
      { target: '.content', title: '参数配置', description: '各配置项按 Tab 分级，敏感项仅管理员可见可改。', placement: 'top' },
    ],
  },
  tunnel: {
    view: 'tunnel',
    title: '内网穿透',
    steps: [
      { target: '[data-guide="tunnel"]', title: '内网穿透', description: '通过隧道将本地服务暴露到公网访问。', placement: 'right' },
      { target: '.content', title: '隧道管理', description: '配置与管理访问链接，需先登录 Tailscale。', placement: 'top' },
    ],
  },
  cleanup: {
    view: 'cleanup',
    title: '系统清理',
    steps: [
      { target: '[data-guide="cleanup"]', title: '系统清理', description: '清理系统运行产生的临时与冗余文件。', placement: 'right' },
      { target: '.content', title: '清理任务', description: '按配置清理临时文件、日志与缓存，释放磁盘空间。', placement: 'top' },
    ],
  },
  users: {
    view: 'users',
    title: '用户管理',
    steps: [
      { target: '[data-guide="users"]', title: '用户管理', description: '管理系统用户、角色与权限分配。', placement: 'right' },
      { target: '.content', title: '账号管理', description: '创建/编辑/删除用户，配置角色与权限点。', placement: 'top' },
    ],
  },
  skill: {
    view: 'skill',
    title: '技能管理',
    steps: [
      { target: '[data-guide="skill"]', title: '技能管理', description: '管理 AI 对话技能、预设角色与能力扩展。', placement: 'right' },
      { target: '.content', title: '技能配置', description: '查看与配置 AI 伙伴技能，影响问答行为。', placement: 'top' },
    ],
  },
  dataclean: {
    view: 'dataclean',
    title: '数据清洗',
    steps: [
      { target: '[data-guide="dataclean"]', title: '数据清洗', description: '对知识库数据进行去重、规范化等清洗操作。', placement: 'right' },
      { target: '.content', title: '清洗任务', description: '执行数据质量检查与智能清洗，提升知识库质量。', placement: 'top' },
    ],
  },
  help: {
    view: 'help',
    title: '帮助文档',
    steps: [
      { target: '[data-guide="help"]', title: '帮助文档', description: '查看系统的使用说明与常见问题。', placement: 'right' },
      { target: '.content', title: '文档查阅', description: '浏览帮助内容，快速解决使用疑问。', placement: 'top' },
    ],
  },
  about: {
    view: 'about',
    title: '关于',
    steps: [
      { target: '[data-guide="about"]', title: '关于', description: '查看系统版本、技术栈与版权信息。', placement: 'right' },
      { target: '.content', title: '版本信息', description: '展示当前构建版本与模块清单。', placement: 'top' },
    ],
  },
};

// 首次访问标记持久化键前缀（localStorage）：值为 JSON 数组，记录已引导过的视图 key
export const GUIDE_SEEN_KEY = 'karpathy-guide-seen';