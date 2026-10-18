// 编译状态枚举 → 中文标签（PRD P3：禁止把 running/done/error 等裸枚举渲染给用户）
// 时间线/分组卡片里 item.status / group.status 实际取值含 'error'（与 RunSummary 的 'failed' 并存），
// 故此处统一映射 failed/error → 失败，避免界面出现英文。

export function stepStatusLabel(status: string): string {
  switch (status) {
    case 'done':
      return '完成';
    case 'failed':
    case 'error':
      return '失败';
    case 'running':
      return '运行中';
    default:
      // 兜底不裸暴漏未知枚举：原样返回，由上层决定是否展示
      return status;
  }
}
