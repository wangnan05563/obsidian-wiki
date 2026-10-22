// T02461（PRD Q7）：追问引导词单一可信源。
// 此前三处三种说法——「追问：」(Query.vue) / 「猜猜你想问：」(FloatingChat.vue) /
// 「你可能想问：」(FollowupsChips.vue)——统一为「你可能想问：」，避免同一功能多词并存。
export const FOLLOWUP_LABEL = '你可能想问：';

// T02782：审计动作实名（用户管理「审计日志」面板与帮助文档共用）。
// 键与 api/src/auth/types.ts 的 AuditAction 枚举对齐；中文沿用既有口径
// （登录 / 登出 / 越权，见帮助文档用户管理节），不新造词。未知动作回退显示原始值。
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: '登录',
  logout: '登出',
  permission_check: '权限校验',
  permission_denied: '越权拒绝',
  user_create: '用户创建',
  user_update: '用户更新',
  user_delete: '用户删除',
  user_register: '用户注册',
  password_change: '修改密码',
  config_change: '配置变更',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
