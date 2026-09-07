// PPT 渲染器：把既有的 Marp Markdown 幻灯片解析为结构化页纲，再用 pptxgenjs 生成原生 .pptx。
// 为什么由后端解析 Marp 而非二次调用 LLM：Marp 已含封面/目录/内容/总结/结语与每页标题/要点，
//   结构化程度足够，避免额外 token 与延迟（见 .trae/documents/ppt-quality-improve-plan.md）。
// 为什么用 pptxgenjs：来自内置技能 pptx-skill-for-trae（package.json 依赖），服务端纯 Node 生成，
//   交付物是可在 PowerPoint/WPS 打开编辑的原生 .pptx，弥补浏览器 marpit 仅内联预览的不足。

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { VaultService } from '../vault/vault-service.js';

// pptxgenjs 通过 `export as namespace` 暴露，default 导出类型在 InstanceType 里解析异常，
// 这里用本地最小接口约束我们用到的 API 面（addText/addShape/write/write），既避免类型私有推导问题，
// 也不引入 `any` 破坏类型安全度。
interface PptxCanvas {
  defineLayout(opts: { name: string; width: number; height: number }): void;
  layout: string;
  author: string;
  title: string;
  addSlide(): PptxSlide;
  write(opts: { outputType: 'nodebuffer' }): Promise<unknown>;
}
// 一页幻灯片的最小形状/文本/背景接口
interface PptxSlide {
  background: { color: string } | string;
  addShape(shape: string, opts: Record<string, unknown>): unknown;
  addText(text: string, opts: Record<string, unknown>): unknown;
}

// ===== 数据结构：Marp 页 → 结构化页 =====
// level=0 顶层要点，level>=1 缩进子点
export interface SlideItem {
  kind: 'bullet' | 'plain';
  level: number;
  text: string;
}
export interface Slide {
  title: string;
  items: SlideItem[];
}

// ===== 主题常量（贴合项目浅色清新 UI：浅蓝/浅紫主色系）=====
// 为什么抽为常量：与前端 accent 色一致，保证 PPT 与产品视觉统一；后续换肤只改一处
const COLORS = {
  primary: '#165DFF', // 主蓝（标题/色条/页码）
  purple: '#722ED1', // 点缀紫（封面/结语强调）
  heading: '#1D2129', // 标题文字
  body: '#4E5969', // 正文
  light: '#A9B0B8', // 子点/辅助
  bg: '#F7F9FE', // 整页浅色底
  bar: '#E8F0FF', // 标题左侧色条淡底
  pageText: '#86909C', // 页码文字
};
// 中文字体统一用系统字体，避免打包时嵌入字体文件过大
const FONT = 'Microsoft YaHei';
// 宽屏 16:9，与 marpit 渲染尺寸一致（避免导出后长宽比不同）
const PAGE_W = 13.333;
const PAGE_H = 7.5;

// ===== Marp Markdown → 结构化页 =====
// frontmatter 移除：目录归档在 Markdown 前自动加了 --- marp:true ... --- 头块，
//   它不是幻灯片内容，解析时必须剥掉否则被误判为分页符。
export function parseMarpSlides(markdown: string): Slide[] {
  const text = markdown
    // 剥离 frontmatter：开头 --- 到下一个独立 --- 行之间的 YAML 块
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .trim();
  // Marp 用独立行的 --- 分页
  const blocks = text.split(/\r?\n---\r?\n/);

  const slides: Slide[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let title = '';
    const items: SlideItem[] = [];

    for (let line of lines) {
      // 剥掉行首可折叠的空格后判定，保证解析不受缩进噪声影响
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 标题：单 # 或 ## 开头（Marp 封面用 #，内容页用 ##）
      const heading = trimmed.match(/^#+\s+(.*)$/);
      if (heading && !title) {
        title = heading[1].trim();
        continue;
      }
      // 编号列表（目录页）：保留文字、去掉编号
      const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ordered) {
        items.push({ kind: 'bullet', level: 0, text: ordered[1].trim() });
        continue;
      }
      // 无序列表：顶层 `- ` 或子点（2 空格以上缩进）
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        // 子点判定：原行以「2+ 空格 + -/*」开头，且非顶层
        const level = /^\s{2,}[-*]/.test(line) ? 1 : 0;
        items.push({ kind: 'bullet', level, text: bullet[1].trim() });
        continue;
      }
      // 其它非列表文本（封面副标题/说明）：仅在没有标题内容时当作 plain 保留
      items.push({ kind: 'plain', level: 0, text: trimmed });
    }

    // 空块（Markdown 末尾多一个分隔符等）跳过，避免产生空白页
    if (!title && items.length === 0) continue;
    slides.push({ title, items });
  }
  return slides;
}

// ===== 溢出控制工具 =====
// 按每页要点数/文字量动态定字号：要点越少越大、越多越小，避免内容溢出屏幕之外（skill 防溢出原则）
function pickBodyFontSize(itemCount: number): number {
  if (itemCount <= 4) return 18;
  if (itemCount <= 7) return 16;
  return 14;
}
// 每条要点的行高（pt → inch），字号越大行越高；多行文本按字数估算高度
function itemHeightPt(fontSize: number, text: string): number {
  const lines = Math.max(1, Math.ceil(text.length / 22));
  return fontSize * 1.45 * lines;
}

// ===== 各种布局：每页至少一个可见元素（skill 硬性要求「无空页」）=====
// 各类布局参数用到的简报类型：这里只作为函数签名类型别名，避免反复写完整对象
type PptxInstance = PptxCanvas;

// 内容页：顶部色条 + 标题，下方按要求竖排，底部页码
function addContentSlide(pptx: PptxInstance, slide: Slide, pageNo: number, total: number): void {
  const s = pptx.addSlide();
  // 全页浅色底（保证整页有可见元素，避免仅背景色块的"空页"观感）
  s.background = { color: COLORS.bg };
  // 顶部主色标题条（左侧窄 accent 竖条 + 标题）
  s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 1.0, fill: { color: COLORS.bar }, line: { type: 'none' } });
  s.addShape('rect', { x: 0, y: 0, w: 0.12, h: 1.0, fill: { color: COLORS.primary }, line: { type: 'none' } });
  s.addText(slide.title, {
    x: 0.4, y: 0.18, w: PAGE_W - 0.8, h: 0.64,
    fontSize: 26, fontFace: FONT, bold: true, color: COLORS.heading,
    valign: 'middle', align: 'left',
  });

  // 正文要点区：逐条 addText，子点缩进并换灰；plain 作为说明覆盖该页首条区域
  const bodyItems = slide.items.length > 0 ? slide.items : [{ kind: 'bullet' as const, level: 0, text: slide.title }];
  const fade = bodyItems.length;
  const fontSize = pickBodyFontSize(fade);
  let y = 1.5;
  const maxY = PAGE_H - 0.6;
  for (const item of bodyItems) {
    if (y > maxY - 0.4) break; // 防垂直溢出：超出行高直接截断，避免压到页码
    const h = itemHeightPt(fontSize, item.text) / 72;
    s.addText(item.text, {
      x: item.level > 0 ? 0.9 : 0.5, y, w: PAGE_W - (item.level > 0 ? 1.4 : 1.0), h,
      fontSize, fontFace: FONT, color: item.level > 0 ? COLORS.light : COLORS.body,
      bullet: item.level > 0 ? { indent: 0, code: '2013' } : { indent: 6, code: '2022' },
      valign: 'top', align: 'left', breakLine: false,
    });
    y += h + 0.12;
  }

  // 底部页码（内容页都需要，区分于封面/结语）非空元素补充
  s.addText(`${pageNo} / ${total}`, {
    x: 0, y: PAGE_H - 0.42, w: PAGE_W, h: 0.3,
    fontSize: 11, fontFace: FONT, color: COLORS.pageText, align: 'center',
  });
}

// 封面页：居中大标题 + 副标题，浅蓝渐变底
function addCoverSlide(pptx: PptxInstance, slide: Slide): void {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  // 顶部/底部主色装饰带，保证整页非"光板"
  s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.08, fill: { color: COLORS.primary }, line: { type: 'none' } });
  // 居中的主标题
  s.addText(slide.title, {
    x: 1, y: 2.0, w: PAGE_W - 2, h: 1.2,
    fontSize: 40, fontFace: FONT, bold: true, color: COLORS.heading, align: 'center', valign: 'bottom',
  });
  // 副标题：取第一个 plain 文本（若存在）
  const sub = slide.items.length > 0 ? slide.items[0].text : '';
  s.addText(sub, {
    x: 1, y: 3.2, w: PAGE_W - 2, h: 0.6,
    fontSize: 20, fontFace: FONT, color: COLORS.primary, align: 'center', valign: 'top',
  });
}

// 目录页：标题 + 编号条目列表
function addAgendaSlide(pptx: PptxInstance, slide: Slide): void {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  s.addShape('rect', { x: 0, y: 0, w: 0.12, h: PAGE_H, fill: { color: COLORS.primary }, line: { type: 'none' } });
  s.addText(slide.title || '目录', {
    x: 0.7, y: 0.6, w: PAGE_W - 1.2, h: 0.8,
    fontSize: 32, fontFace: FONT, bold: true, color: COLORS.heading, valign: 'middle',
  });
  const fontSize = pickBodyFontSize(slide.items.length);
  let y = 1.8;
  slide.items.forEach((item, i) => {
    if (item.kind !== 'bullet') return;
    const h = itemHeightPt(fontSize, item.text) / 72;
    s.addText(`${i + 1}.  ${item.text}`, {
      x: 0.9, y, w: PAGE_W - 1.8, h,
      fontSize, fontFace: FONT, color: COLORS.body, valign: 'top', align: 'left',
    });
    y += h + 0.16;
  });
}

// 总结/结语页：居中标题 + 要点/致谢
function addClosingSlide(pptx: PptxInstance, slide: Slide): void {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  // 上缘 accent 细线 + 居中标题块
  s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.08, fill: { color: COLORS.purple }, line: { type: 'none' } });
  s.addText(slide.title, {
    x: 1, y: 0.7, w: PAGE_W - 2, h: 0.9,
    fontSize: 34, fontFace: FONT, bold: true, color: COLORS.purple, align: 'center',
  });
  // 是否致谢类（无要点）→ 居中一句收尾，避免空页
  const bodyItems = slide.items.filter((i) => i.kind === 'bullet');
  if (bodyItems.length === 0) {
    const last = slide.items[slide.items.length - 1]?.text || slide.title;
    s.addText(last, {
      x: 1.5, y: 3.2, w: PAGE_W - 3, h: 0.8,
      fontSize: 22, fontFace: FONT, color: COLORS.body, align: 'center',
    });
    return;
  }
  const fontSize = pickBodyFontSize(bodyItems.length);
  let y = 2.0;
  for (const item of bodyItems) {
    const h = itemHeightPt(fontSize, item.text) / 72;
    s.addText(item.text, {
      x: 1.4, y, w: PAGE_W - 2.8, h,
      fontSize, fontFace: FONT, color: COLORS.body, bullet: { indent: 6, code: '2022' }, valign: 'top',
    });
    y += h + 0.14;
  }
}

// ===== 按页类型分发布局 =====
// 布局判定：首页封面；标题含关键词的目录/总结/结语页单独处理；其余内容页
function isClosingTitle(t: string): boolean {
  return /(总结|结语|谢谢|感谢|致谢|结束|THE END|THANKS)/i.test(t);
}
function isAgendaTitle(t: string): boolean {
  return /(目录|大纲|AGENDA|CONTENTS)/i.test(t);
}

// 生成单个 .pptx 的 Buffer（供单测与写入 vault 共用）
export async function renderPptx(slides: Slide[], pptTitle: string): Promise<Buffer> {
  // 动态 import：pptxgenjs 体积较大且仅 PPT 模式使用，避免拖慢后端常驻主模块加载
  const mod = (await import('pptxgenjs')) as { default?: new () => PptxCanvas };
  const pptx = new (mod.default as new () => PptxCanvas)();
  // 明确声明宽屏布局，避免 4:3 默认布局与 marpit 预览横竖比例不一致
  pptx.defineLayout({ name: 'KARPATHY_WIDE', width: PAGE_W, height: PAGE_H });
  pptx.layout = 'KARPATHY_WIDE';
  pptx.author = 'Karpathy Wiki';
  pptx.title = pptTitle || '知识库幻灯片';

  const total = Math.max(slides.length, 1);
  slides.forEach((slide, idx) => {
    const t = slide.title.trim();
    if (idx === 0) {
      addCoverSlide(pptx, slide);
    } else if (isAgendaTitle(t)) {
      addAgendaSlide(pptx, slide);
    } else if (isClosingTitle(t)) {
      addClosingSlide(pptx, slide);
    } else {
      addContentSlide(pptx, slide, idx + 1, total);
    }
  });
  // 防御：若解析出零页（不应发生），补一页占位标题，确保产出非空 .pptx
  if (slides.length === 0) {
    addCoverSlide(pptx, { title: pptTitle || '知识库幻灯片', items: [] });
  }

  const data = await pptx.write({ outputType: 'nodebuffer' });
  return data as Buffer;
}

// 生成 .pptx 并写入 vault queries/media/，返回公开下载 URL（与 image 同款路由，无认证）
// 失败策略由调用方决定：此处只负责渲染+落盘，抛错则上层降级为「无下载按钮」不影响预览
export async function generatePptxFile(
  vault: VaultService,
  markdown: string,
  pptTitle: string,
): Promise<{ archivePath: string; url: string }> {
  const slides = parseMarpSlides(markdown);
  const buffer = await renderPptx(slides, pptTitle);

  // 文件名用随机 ID（不可枚举，防被遍历泄露他人内容），与图片归档命名风格一致
  const filename = `ppt-${randomUUID()}.pptx`;
  const archivePath = `queries/media/${filename}`;
  await vault.writeFile(archivePath, buffer);
  return { archivePath, url: `/api/media/file/${filename}` };
}