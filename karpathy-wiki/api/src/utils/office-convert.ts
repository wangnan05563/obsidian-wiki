import path from 'node:path';
import zlib from 'node:zlib';
import { extractOle2Text } from './ole2-extract.js';

// ZIP Parser - Central Directory scan
interface ZipEntry { name: string; data: Buffer; }

// 为什么 export：qq-preprocess 解析 xlsx 时需复用同一 zip 解压实现，避免重复维护
export async function parseZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return entries;
  const totalEntries = buffer.readUInt16LE(eocdOffset + 8);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  let pos = cdOffset;
  for (let ei = 0; ei < totalEntries; ei++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const fileNameLen = buffer.readUInt16LE(pos + 28);
    const extraFieldLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const relativeOffset = buffer.readUInt32LE(pos + 42);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const name = buffer.toString('utf-8', pos + 46, pos + 46 + fileNameLen);
    const dataStart = relativeOffset + 30 + fileNameLen + extraFieldLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    // Local file header at relativeOffset holds the compression method (offset 8).
    const method = buffer.readUInt16LE(relativeOffset + 8);
    let data: Buffer;
    if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch {
        // Some writers wrap the stream with a zlib header instead of raw deflate.
        try {
          data = zlib.inflateSync(raw);
        } catch {
          data = raw;
        }
      }
    } else {
      data = raw;
    }
    entries.set(name, data);
    pos += 46 + fileNameLen + extraFieldLen + commentLen;
  }
  return entries;
}

// 为什么 export：qq-preprocess 解析 HTML 时需复用同一 entity 解码，避免实现分叉
export function decodeXmlEntities(xml: string): string {
  return xml.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function escapeMarkdownPipe(text: string): string {
  return text.replace(/\|/g, String.raw`\|`).replace(/\n/g, ' ');
}

// 提取段落文本解析逻辑，降低 convertDocxToMarkdown 的认知复杂度
function parseDocxParagraph(paraContent: string): { text: string; isHeading: boolean; isBold: boolean; headingLevel: number } {
  const isHeading = /pStyle[^"]*"Heading\d"/i.test(paraContent);
  const isBold = paraContent.includes('<w:b ') || paraContent.includes('<w:b/>') || paraContent.includes('<w:b>');
  const textMatches = paraContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  let paraText = '';
  for (const t of textMatches) {
    const inner = t.match(/>([^<]*)</);
    if (inner?.[1] !== undefined) paraText += decodeXmlEntities(inner[1]);
  }
  let headingLevel = 0;
  if (isHeading) {
    const levelMatch = paraContent.match(/Heading(\d)/i);
    headingLevel = levelMatch ? Number.parseInt(levelMatch[1], 10) : 1;
  }
  return { text: paraText.trim(), isHeading, isBold, headingLevel: Math.min(headingLevel, 6) };
}

export async function convertDocxToMarkdown(buffer: Buffer): Promise<string> {
  const entries = await parseZip(buffer);
  let markdown = '';
  const docBuffer = entries.get('word/document.xml');
  if (!docBuffer) return '[Error: document.xml not found]';
  const docXml = docBuffer.toString('utf-8');
  const PARA_RE = /<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
  let paraMatch;
  while ((paraMatch = PARA_RE.exec(docXml)) !== null) {
    const { text, isHeading, isBold, headingLevel } = parseDocxParagraph(paraMatch[1]);
    if (isHeading && text) {
      markdown += '\n' + '#'.repeat(headingLevel) + ' ' + text + '\n\n';
    } else if (text) {
      markdown += isBold ? '**' + text + '** ' : text + ' ';
    }
  }
  return markdown.trim() || '[No text content extracted]';
}

// 提取 SharedStrings 解析逻辑，降低 convertXlsxToMarkdown 的认知复杂度
function parseSharedStrings(ssBuffer: Buffer): Map<number, string> {
  const stringCache = new Map<number, string>();
  const ssXml = ssBuffer.toString('utf-8');
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let siMatch;
  let idx = 0;
  while ((siMatch = siRegex.exec(ssXml)) !== null) {
    const textParts = siMatch[1].match(/<t[^>]*>([^<]*)<\/t>/g) || [];
    let text = '';
    for (const t of textParts) {
      const m = t.match(/>([^<]*)</);
      if (m?.[1] !== undefined) text += m[1];
    }
    stringCache.set(idx++, decodeXmlEntities(text));
  }
  return stringCache;
}

// 提取 sheet 单元格解析逻辑，降低 convertXlsxToMarkdown 的认知复杂度
function parseSheetCells(
  sheetXml: string,
  stringCache: Map<number, string>
): Map<number, Array<{ col: number; value: string }>> {
  const rows = new Map<number, Array<{ col: number; value: string }>>();
  const cellRegex = /<c[^>]*r="([A-Z]+)(\d+)"[^>]*>([\s\S]*?)<\/c>/g;
  let cellMatch;
  while ((cellMatch = cellRegex.exec(sheetXml)) !== null) {
    const colStr = cellMatch[1];
    const rowNum = parseInt(cellMatch[2], 10);
    const cellContent = cellMatch[3];
    const colNum = colToNumber(colStr);
    let value = ''; // NOSONAR - 变量在下文 if/else 分支中赋值和使用
    const vMatch = cellContent.match(/<v>([^<]*)<\/v>/);
    if (vMatch?.[1] === undefined) {
      const tMatch = cellContent.match(/<t[^>]*>([^<]*)<\/t>/);
      if (tMatch?.[1] !== undefined) value = decodeXmlEntities(tMatch[1]);
    } else {
      value = stringCache.get(parseInt(vMatch[1], 10)) ?? vMatch[1];
    }
    if (!rows.has(rowNum)) rows.set(rowNum, []);
    rows.get(rowNum)!.push({ col: colNum, value: escapeMarkdownPipe(value) });
  }
  return rows;
}

// 把解析出的行渲染为 Markdown 表格：第一行作为表头，其余作为数据。
// 为什么用首行作表头而非 Col 占位符：占位符丢失"列名"这一真实语义，且与下游 LLM 阅读习惯不符。
function renderSheetTable(rows: Map<number, Array<{ col: number; value: string }>>): string {
  if (rows.size === 0) return '_(空表)_\n\n';
  const sorted = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const maxCol = Math.max(...[...rows.values()].map(maxColInRow));
  const head = new Array(maxCol + 1).fill('');
  for (const c of sorted[0][1]) head[c.col] = c.value;
  let markdown = '| ' + head.join(' | ') + ' |\n';
  markdown += '|' + new Array(maxCol + 1).fill('------').join('|') + '|\n';
  for (const [, cells] of sorted.slice(1)) {
    const rowStrs = new Array(maxCol + 1).fill('');
    for (const c of cells) rowStrs[c.col] = c.value;
    markdown += '| ' + rowStrs.join(' | ') + ' |\n';
  }
  return markdown + '\n';
}

export async function convertXlsxToMarkdown(buffer: Buffer): Promise<string> {
  const entries = await parseZip(buffer);
  let markdown = '# Excel 工作簿\n\n';
  const ssBuffer = entries.get('xl/sharedStrings.xml');
  const stringCache = ssBuffer ? parseSharedStrings(ssBuffer) : new Map<number, string>();
  const wbBuffer = entries.get('xl/workbook.xml');
  if (!wbBuffer) return '[Error: workbook.xml not found]';
  const wbXml = wbBuffer.toString('utf-8');

  // r:id → target worksheet file (order-independent attribute matching).
  const relsBuffer = entries.get('xl/_rels/workbook.xml.rels');
  const ridToTarget = new Map<string, string>();
  if (relsBuffer) {
    const relsXml = relsBuffer.toString('utf-8');
    const relRe = /<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let m;
    while ((m = relRe.exec(relsXml)) !== null) ridToTarget.set(m[1], m[2]);
  }

  const sheetRe = /<sheet\b([^>]*)\/>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRe.exec(wbXml)) !== null) {
    const attrs = sheetMatch[1];
    const nameM = attrs.match(/name="([^"]*)"/);
    const ridM = attrs.match(/r:id="([^"]*)"/);
    if (!nameM || !ridM) continue;
    const sheetName = nameM[1];
    // 优先用 rels 映射定位实际文件名；缺失（无 rels 或 rels 为空）时回退到
    // rId 序号路径（xl/worksheets/sheet{N}.xml），否则会因取不到文件而整表跳过。
    const target = ridToTarget.get(ridM[1]) || '';
    const sheetFile = target
      ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target)
      : 'xl/worksheets/sheet' + ((ridM[1].match(/\d+/) || ['0'])[0]) + '.xml';
    const sheetBuf = entries.get(sheetFile);
    if (!sheetBuf) continue;
    const sheetXml = sheetBuf.toString('utf-8');
    markdown += '## Sheet: ' + sheetName + '\n\n';
    markdown += renderSheetTable(parseSheetCells(sheetXml, stringCache));
  }
  return markdown;
}

function colToNumber(colStr: string): number {
  let num = 0;
  for (const ch of colStr) num = num * 26 + (ch.codePointAt(0)! - 65);
  return num;
}

function maxColInRow(cells: Array<{ col: number }>) {
  let max = 0;
  for (const c of cells) max = Math.max(max, c.col);
  return max;
}

export async function convertPptxToMarkdown(buffer: Buffer): Promise<string> {
  const entries = await parseZip(buffer);
  let markdown = '# PowerPoint\n\n';
  const presBuffer = entries.get('ppt/presentation.xml');
  if (!presBuffer) return '[Error: presentation.xml not found]';
  const presXml = presBuffer.toString('utf-8');
  const sldRegex = /<(?:p:)?sldId[^>]*r:id="rId(\d+)"/g;
  let slideIdx = 0;
  while (sldRegex.exec(presXml) !== null) {
    slideIdx++;
    const slideFile = 'ppt/slides/slide' + slideIdx + '.xml';
    const slideBuffer = entries.get(slideFile);
    if (!slideBuffer) continue;
    const slideXml = slideBuffer.toString('utf-8');
    const textRegex = /<a:t>([^<]*)<\/a:t>/g;
    const texts: string[] = [];
    let txMatch;
    while ((txMatch = textRegex.exec(slideXml)) !== null) {
      const t = decodeXmlEntities(txMatch[1]);
      if (t.trim()) texts.push(t);
    }
    // 为什么统一作为列表项：commit 设计意图为"pptx 幻灯片列表项"，
    // 全局已有 # PowerPoint 前缀；保留 isTitle 分支会让首个文本变成 # 标题，
    // 与全局前缀冲突且破坏列表项语义
    markdown += '---\n\n## Slide ' + slideIdx + '\n\n';
    for (const t of texts) {
      if (t.trim()) markdown += '- ' + t.trim() + '\n';
    }
    markdown += '\n';
  }
  return markdown.trim();
}

export interface ConversionResult {
  contentType: 'document' | 'spreadsheet' | 'presentation' | 'unsupported';
  markdown: string;
}

// Legacy Office (OLE2) files store text as raw bytes; the extractor pulls runs of
// printable characters, which includes Word field-code artifacts (TOC / PAGEREF /
// HYPERLINK / _Toc anchors) and document-property junk from the FIB/style region
// (app names, author, base64 blobs, Excel built-in style names). Strip those so
// the downstream LLM sees clean prose.
function cleanOle2Text(text: string): string {
  const META_DENY =
    /^(Normal|Administrator|Default|WPS Office|微软中国|KSOProductBuildVer|KSOTemplateDocerSaveRecord|等线|标题|链接单元格|Calibri|宋体|黑体|仿宋|楷体|Times New Roman|Arial)/i;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      out.push('');
      continue;
    }
    if (META_DENY.test(t)) continue;
    if (/^(TOC|PAGEREF|HYPERLINK|REF|NOTEREF|SEQ|STYLEREF|FORMULA|SYMBOL|INDEX|TC|RD)\b/i.test(t)) continue;
    if (/^\s*_Toc\d+\s*$/.test(t)) continue;
    if (/\\(o|h|z|u|t|f|p)\b/i.test(t)) continue;
    if (/^[A-Za-z0-9+/=]{40,}$/.test(t)) continue; // base64 blob (e.g. embedded JWT)
    if (/^[0-9A-Fa-f]{16,}(_\d+)?$/.test(t)) continue; // hex GUID + suffix e.g. 6C712A53…_13
    if (/^\d{3,4}-[\d.]+$/.test(t)) continue; // version/lang code e.g. 2052-12.1.0.26895
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function convertOfficeFile(fileName: string, buffer: Buffer): Promise<ConversionResult> {
  const ext = path.extname(fileName).toLowerCase().slice(1);

  // Legacy binary Office (OLE2 / CFB): .doc / .xls / .ppt — extracted via the
  // zero-dependency CFB text extractor in ole2-extract.ts.
  if (['doc', 'xls', 'ppt'].includes(ext)) {
    const text = extractOle2Text(buffer);
    if (text && text.trim().length > 0) {
      const contentType =
        ext === 'doc' ? 'document' : ext === 'xls' ? 'spreadsheet' : 'presentation';
      return { contentType, markdown: cleanOle2Text(text) };
    }
    // 提示用户另存为新格式，便于自行转换后重试
    return {
      contentType: 'unsupported',
      markdown: `[Unsupported format: .${ext}]\n\nThis is an old binary Office format (OLE Compound Document) and no text could be extracted. Please re-save as .docx / .xlsx / .pptx and try again.`
    };
  }

  switch (ext) {
    case 'docx':
      return { contentType: 'document', markdown: await convertDocxToMarkdown(buffer) };
    case 'xlsx':
      return { contentType: 'spreadsheet', markdown: await convertXlsxToMarkdown(buffer) };
    case 'pptx':
      return { contentType: 'presentation', markdown: await convertPptxToMarkdown(buffer) };
    default:
      return { contentType: 'unsupported', markdown: '' };
  }
}