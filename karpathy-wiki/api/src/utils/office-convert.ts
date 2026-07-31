import path from 'node:path';

// ZIP Parser - Central Directory scan
interface ZipEntry { name: string; data: Buffer; }

// 为什么 export：qq-preprocess 解析 xlsx 时需复用同一 zip 解压实现，避免重复维护
export async function parseZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  var eocdOffset = -1;
  for (var i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return entries;
  const totalEntries = buffer.readUInt16LE(eocdOffset + 8);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  var pos = cdOffset;
  for (var ei = 0; ei < totalEntries; ei++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const fileNameLen = buffer.readUInt16LE(pos + 28);
    const extraFieldLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const relativeOffset = buffer.readUInt32LE(pos + 42);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const name = buffer.toString('utf-8', pos + 46, pos + 46 + fileNameLen);
    const dataStart = relativeOffset + 30 + fileNameLen + extraFieldLen;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
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
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
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
    const paraContent = paraMatch[1];
    const isHeading = /pStyle[^"]*"Heading\d"/i.test(paraContent);
    const isBold = /<w:b([ >\/])/i.test(paraContent);
    const textMatches = paraContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    let paraText = '';
    for (const t of textMatches) {
      const inner = t.match(/>([^<]*)</);
      if (inner && inner[1] !== undefined) paraText += decodeXmlEntities(inner[1]);
    }
    if (isHeading && paraText.trim()) {
      const levelMatch = paraContent.match(/Heading(\d)/i);
      const level = levelMatch ? parseInt(levelMatch[1]) : 1;
      markdown += '\n' + '#'.repeat(Math.min(level, 6)) + ' ' + paraText.trim() + '\n\n';
    } else if (paraText.trim()) {
      markdown += isBold ? '**' + paraText.trim() + '** ' : paraText + ' ';
    }
  }
  return markdown.trim() || '[No text content extracted]';
}

export async function convertXlsxToMarkdown(buffer: Buffer): Promise<string> {
  const entries = await parseZip(buffer);
  let markdown = '# Excel 工作簿\n\n';
  const ssBuffer = entries.get('xl/sharedStrings.xml');
  const stringCache = new Map<number, string>();
  if (ssBuffer) {
    const ssXml = ssBuffer.toString('utf-8');
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    let siMatch;
    let idx = 0;
    while ((siMatch = siRegex.exec(ssXml)) !== null) {
      const textParts = siMatch[1].match(/<t[^>]*>([^<]*)<\/t>/g) || [];
      let text = '';
      for (const t of textParts) {
        const m = t.match(/>([^<]*)</);
        if (m && m[1] !== undefined) text += m[1];
      }
      stringCache.set(idx++, decodeXmlEntities(text));
    }
  }
  const wbBuffer = entries.get('xl/workbook.xml');
  if (!wbBuffer) return '[Error: workbook.xml not found]';
  const wbXml = wbBuffer.toString('utf-8');
  const sheetRegex = /<sheet [^>]*name="([^"]*)"[^>]*r:id="rId(\d+)"/g;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(wbXml)) !== null) {
    const sheetName = sheetMatch[1];
    const ridNum = sheetMatch[2];
    const sheetIdx = parseInt(ridNum);
    const sheetFile = 'xl/worksheets/sheet' + sheetIdx + '.xml';
    const sheetBuf = entries.get(sheetFile);
    if (!sheetBuf) continue;
    const sheetXml = sheetBuf.toString('utf-8');
    markdown += '## Sheet: ' + sheetName + '\n\n';
    markdown += '| Cell | Value |\n|------|-------|\n';
    const cellRegex = /<c[^>]*r="([A-Z]+)(\d+)"[^>]*>([\s\S]*?)<\/c>/g;
    let cellMatch;
    const rows = new Map<number, Array<{ col: number; value: string }>>();
    while ((cellMatch = cellRegex.exec(sheetXml)) !== null) {
      const colStr = cellMatch[1];
      const rowNum = parseInt(cellMatch[2]);
      const cellContent = cellMatch[3];
      const colNum = colToNumber(colStr);
      let value = '';
      const vMatch = cellContent.match(/<v>([^<]*)<\/v>/);
      if (vMatch && vMatch[1] !== undefined) {
        value = stringCache.get(parseInt(vMatch[1])) || vMatch[1];
      } else {
        const tMatch = cellContent.match(/<t[^>]*>([^<]*)<\/t>/);
        if (tMatch && tMatch[1] !== undefined) value = decodeXmlEntities(tMatch[1]);
      }
      if (!rows.has(rowNum)) rows.set(rowNum, []);
      rows.get(rowNum)!.push({ col: colNum, value: escapeMarkdownPipe(value) });
    }
    const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, cells] of sortedRows) {
      const rowStrs = new Array(maxColInRow(cells) + 1).fill('');
      for (const c of cells) rowStrs[c.col] = c.value;
      markdown += '| ' + rowStrs.join(' | ') + ' |\n';
    }
    markdown += '\n';
  }
  return markdown;
}

function colToNumber(colStr: string): number {
  var num = 0;
  for (var ch of colStr) num = num * 26 + (ch.charCodeAt(0) - 65);
  return num;
}

function maxColInRow(cells: Array<{ col: number }>) {
  var max = 0;
  for (var c of cells) max = Math.max(max, c.col);
  return max;
}

﻿export async function convertPptxToMarkdown(buffer: Buffer): Promise<string> {
  const entries = await parseZip(buffer);
  let markdown = '# PowerPoint\n\n';
  const presBuffer = entries.get('ppt/presentation.xml');
  if (!presBuffer) return '[Error: presentation.xml not found]';
  const presXml = presBuffer.toString('utf-8');
  const sldRegex = /<(?:p:)?sldId[^>]*r:id="rId(\d+)"/g;
  let sldMatch;
  var slideIdx = 0;
  while ((sldMatch = sldRegex.exec(presXml)) !== null) {
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

export async function convertOfficeFile(fileName: string, buffer: Buffer): Promise<ConversionResult> {
  const ext = path.extname(fileName).toLowerCase().slice(1);
  if (['doc', 'xls', 'ppt'].includes(ext)) {
    return {
      contentType: 'unsupported',
      markdown: `[Unsupported format: .${ext}]\n\nThis is an old binary Office format (OLE Compound Document).\nPlease save the file as .docx / .xlsx / .pptx and re-upload.`
    };
  }
  switch (ext) {
    case 'docx':
    case 'doc':
      return { contentType: 'document', markdown: await convertDocxToMarkdown(buffer) };
    case 'xlsx':
    case 'xls':
      return { contentType: 'spreadsheet', markdown: await convertXlsxToMarkdown(buffer) };
    case 'pptx':
    case 'ppt':
      return { contentType: 'presentation', markdown: await convertPptxToMarkdown(buffer) };
    default:
      return { contentType: 'unsupported', markdown: '' };
  }
}
