// 移动端底部 Tab 的单一来源：短标签与桌面功能名的映射。
// 为什么单独成文件：MobileShell 只负责渲染，守护用例需要引用同一份名单；
// 若在测试里再抄一份数组，「移动端主控件名 ∈ 术语表」就会随两处各改各的而静默失效。
export interface MobileTab {
  key: 'query' | 'browse' | 'listen' | 'ingest' | 'me';
  label: string;
  /** 对应桌面菜单实名（config/menu.ts）；移动端专属页为 null */
  desktopMenu: string | null;
}

export const MOBILE_TABS: readonly MobileTab[] = [
  { key: 'query', label: '问答', desktopMenu: '知识问答' },
  { key: 'browse', label: '浏览', desktopMenu: '知识浏览' },
  { key: 'listen', label: '聆听', desktopMenu: null },
  { key: 'ingest', label: '投递', desktopMenu: '投递资料' },
  { key: 'me', label: '我的', desktopMenu: null },
];
