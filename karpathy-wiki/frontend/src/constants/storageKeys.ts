// localStorage 键名集中管理。
// 为什么需要：键名字符串散落在各组件，易拼写错误且无法统一迁移。
//   集中后修改键名只需改一处，且便于审计哪些数据存了 localStorage。
//
// 约束：apiKey 不存 localStorage（apiKey 唯一权威源为后端 config.json）。
//   本文件仅声明非敏感 UI 状态的键名。

export const STORAGE_KEYS = {
  /** 主题选择（useTheme） */
  THEME: 'karpathy-wiki-theme',
  /** 导航栏折叠状态（App.vue） */
  NAV_COLLAPSED: 'navCollapsed',
  /** 问答侧边栏展开状态（Query.vue） */
  SIDEBAR_STATE: 'sidebarState',
  /** 当前选中的 LLM 预设 key（model store） */
  SELECTED_MODEL_PRESET: 'selectedModelPreset',
  /** 按预设持久化的 baseUrl/model 缓存前缀（Config.vue） */
  LLM_PRESET_CONFIG_PREFIX: 'llmPresetConfig:',
  /** 消息反馈标记前缀（MessageToolbar.vue） */
  MSG_FEEDBACK_PREFIX: 'msg-feedback-',
  /** FloatingChat 面板展开状态持久化（FloatingChat.vue） */
  FLOATING_CHAT_OPEN: 'floatingChatOpen',
} as const;

/** 按预设派生 localStorage 完整键名（如 llmPresetConfig:openai） */
export function presetStorageKey(presetKey: string): string {
  return `${STORAGE_KEYS.LLM_PRESET_CONFIG_PREFIX}${presetKey}`;
}

/** 按消息 id 派生反馈标记键名（如 msg-feedback-abc123） */
export function msgFeedbackKey(messageId: string): string {
  return `${STORAGE_KEYS.MSG_FEEDBACK_PREFIX}${messageId}`;
}
