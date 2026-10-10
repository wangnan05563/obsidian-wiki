// FR-21 引用角标解析纯函数（T01769 从 CitationText.vue 抽出）。
// 为什么抽成纯函数：解析规则（合法/非法槽位）是单测计划的覆盖对象，
// 挂在组件 computed 里无法脱离 Vue 实例测试；抽离后组件只剩装配与事件上抛。

/**
 * 把 HTML 产物中「合法槽位内的 [n]」替换为可点击角标。
 * 未匹配到槽位的 [n] 按普通文本保留（SRS 规格 2——防 LLM 编造编号误导跳转）。
 * n 限 1~2 位纯数字：三位以上编号必非法，直接跳过减少无谓替换。
 */
export function replaceCitationMarks(html: string, maxSlot: number): string {
  if (maxSlot <= 0) return html;
  return html.replace(/\[(\d{1,2})\]/g, (match, num: string) => {
    const n = Number(num);
    if (n < 1 || n > maxSlot) return match; // 非法槽位：普通文本保留
    return `<sup class="cite-ref" data-n="${n}" role="button" title="查看引用来源">${n}</sup>`;
  });
}

/**
 * 从点击事件的 target 解析角标槽位号（事件委托用：角标是动态 HTML，逐个绑定不可行）。
 * 命中合法角标返回槽位号，否则返回 null（含未点中角标 / data-n 越界两种情况）。
 */
export function resolveCiteSlot(target: EventTarget | null, maxSlot: number): number | null {
  const el = target as HTMLElement | null;
  const sup = el?.closest?.('sup.cite-ref') as HTMLElement | null;
  if (!sup) return null;
  const n = Number(sup.dataset.n);
  if (n >= 1 && n <= maxSlot) return n;
  return null;
}
