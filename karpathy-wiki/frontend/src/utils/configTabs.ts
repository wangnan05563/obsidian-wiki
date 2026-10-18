// 配置中心 tab 分组与权限可见性（T02467 / PRD §10 C2+C3 / REQ-033+REQ-034）
// ------------------------------------------------------------------
// 为什么抽成纯函数模块：
//   C2 的「11 个 tab 单行平铺且溢出被截断」与 C3 的「权限藏在 v-if 里，非管理员被静默跳到
//   另一个 tab」本质是同一份 tab 元数据被写散在模板的 11 个 v-if 与 onMounted 的一句赋值里。
//   把「有哪些 tab / 属于哪一组 / 谁能动 / 落在哪」收敛成一处声明后，
//   视图只负责渲染，测试不依赖浏览器即可断言分组完整、锁定判定与默认落点。
//
// 口径：
//   - 分组沿用 PRD §10 C2 建议的三组：个人偏好 / AI 服务 / 系统。
//   - adminOnly 与改造前的 v-if="isAdmin" 逐项对齐（7 项），做到「置灰保留」而非「消失」。
//   - 非管理员默认可达 tab 为「朗读设置」（保持既有习惯），但不再有静默跳转逻辑：
//     resolveInitialTab 只接受未锁定的 tab，锁定 tab 一律回落，且由调用方给出解释文案。

export type ConfigTabName =
  | 'schema'
  | 'config'
  | 'migrate'
  | 'mcp'
  | 'ai'
  | 'sharedAi'
  | 'tts'
  | 'tools'
  | 'theme'
  | 'qq'
  | 'prompts';

export interface ConfigTabMeta {
  name: ConfigTabName;
  /** tab 名必须与左侧菜单「配置中心」下的真实标签一致（术语表单来源，见 REQ-029） */
  label: string;
  /** 仅管理员可编辑：置灰保留 + 标注，不隐藏 */
  adminOnly: boolean;
  /** 一句话说明这个 tab 管什么，供导航 tooltip 与空态提示复用 */
  desc: string;
}

export interface ConfigTabGroup {
  key: 'personal' | 'ai' | 'system';
  label: string;
  /** 组级说明：让用户一眼看出这组改动影响的是「只有我」还是「所有人」 */
  desc: string;
  tabs: ConfigTabMeta[];
}

export const CONFIG_TAB_GROUPS: readonly ConfigTabGroup[] = [
  {
    key: 'personal',
    label: '个人偏好',
    desc: '只影响当前浏览器里的你自己',
    tabs: [
      { name: 'tts', label: '朗读设置', adminOnly: false, desc: '音色、语速与朗读行为，保存在本机' },
      { name: 'theme', label: '界面主题', adminOnly: false, desc: '配色与主题切换，只影响当前浏览器' },
    ],
  },
  {
    key: 'ai',
    label: 'AI 服务',
    desc: '模型与提示词：私有 Key 只影响你，共享配置影响所有人',
    tabs: [
      { name: 'ai', label: 'AI 服务', adminOnly: false, desc: '本用户的模型与私有 Key（BYOK）' },
      { name: 'sharedAi', label: '共享 AI', adminOnly: true, desc: '服务端共享的生图/视频配置，全员可用' },
      { name: 'prompts', label: 'Prompt IDE', adminOnly: true, desc: '编辑 AI 使用的提示词模板文件' },
    ],
  },
  {
    key: 'system',
    label: '系统',
    desc: '改的是服务端与知识库本身，会影响其他用户，动手前留意每项的生效方式',
    tabs: [
      { name: 'config', label: '系统配置', adminOnly: true, desc: '引擎、运行参数、批量与日志等服务端配置' },
      { name: 'schema', label: 'SCHEMA 规范', adminOnly: true, desc: '页面规范文件，控制 AI 编译出的结构' },
      { name: 'mcp', label: 'MCP 接口', adminOnly: true, desc: '本应用对外的 MCP 端点与访问令牌' },
      { name: 'tools', label: '工具配置', adminOnly: false, desc: '本应用作为客户端连接的外部工具，存于服务端配置' },
      { name: 'qq', label: 'QQ 导入', adminOnly: true, desc: 'QQ 聊天记录导入的解析与落盘规则' },
      { name: 'migrate', label: '数据迁移', adminOnly: true, desc: '整体导出 / 导入配置，换机器换环境用' },
    ],
  },
];

/** 展平后的全部 tab（顺序即导航顺序） */
export function allConfigTabs(): ConfigTabMeta[] {
  return CONFIG_TAB_GROUPS.flatMap((group) => group.tabs);
}

/** 合法 tab 名清单（供帮助文档直达、URL 深链等外部输入校验） */
export function configTabNames(): ConfigTabName[] {
  return allConfigTabs().map((tab) => tab.name);
}

export function findTabMeta(name: string): ConfigTabMeta | undefined {
  return allConfigTabs().find((tab) => tab.name === name);
}

/** 当前用户是否被锁在这个 tab 外（锁定时置灰保留，不隐藏） */
export function isTabLocked(tab: ConfigTabMeta, isAdmin: boolean): boolean {
  return tab.adminOnly && !isAdmin;
}

/** 非管理员点锁定 tab 时给的解释文案（同一处文案，避免模板里各写一遍） */
export const LOCKED_TAB_HINT = '该配置影响所有人的知识库，仅管理员可查看和修改';

export function lockedTabLabel(tab: ConfigTabMeta): string {
  return `${tab.label} - ${LOCKED_TAB_HINT}`;
}

/**
 * 初始落点：只接受未锁定的 tab。
 * @param preferred 外部指定（如帮助文档「可点击直达」带来的 tab）
 * @param isAdmin 当前角色
 * @returns 可直接渲染的 tab 名；preferred 不可用时回落 FALLBACK_TAB
 */
export function resolveInitialTab(preferred: string | null | undefined, isAdmin: boolean): ConfigTabName {
  const FALLBACK: ConfigTabName = 'tts';
  if (!preferred) return isAdmin ? 'config' : FALLBACK;
  const meta = findTabMeta(preferred);
  if (!meta || isTabLocked(meta, isAdmin)) return isAdmin ? 'config' : FALLBACK;
  return meta.name;
}

/** 供导航渲染的组视图：组内 tab 已标出锁定态（类型放本模块，SFC 不能导出类型） */
export interface ConfigNavGroup {
  key: string;
  label: string;
  desc: string;
  items: Array<ConfigTabMeta & { locked: boolean }>;
}

export function navGroupsFor(isAdmin: boolean): ConfigNavGroup[] {
  return CONFIG_TAB_GROUPS.map<ConfigNavGroup>((group) => ({
    key: group.key,
    label: group.label,
    desc: group.desc,
    items: group.tabs.map((tab) => ({ ...tab, locked: isTabLocked(tab, isAdmin) })),
  }));
}
