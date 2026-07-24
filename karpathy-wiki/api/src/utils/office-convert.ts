import { inflateSync } from 'node:zlib';

// Office 文档转 Markdown 工具
// 为什么手写 ZIP/XML 解析而非引入 mammoth/jszip:OOXML 本质是 ZIP+XML,
// 仅需读取文档内文本与表格结构,手写最小解析器避免新增运行时依赖,且便于打包裁剪。

export interface OfficeConvertResult {
  contentType: 'document' | 'spreadsheet' | 'presentation' | 'unsupported';
  markdown: string;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

// 解析 ZIP buffer → 文件条目列表
// 为什么从本地文件头遍历而非中央目录:本地头顺序排列在 buffer 前部,
// 逐个读取直到签名失配即可,实现最简且对 stored/deflate 均适用。
function parseZip(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // 进入中央目录或 EOCD,本地头结束
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const filenameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.slice(nameStart, nameStart + filenameLen).toString('utf-8');
    const dataStart = nameStart + filenameLen + extraLen;
    let data: Buffer;
    if (compression === 0) {
      // stored:数据未压缩,直接切片
      data = buf.slice(dataStart, dataStart + compressedSize);
    } else if (compression === 8) {
      // deflate:真实 Office 文档多用此压缩,用 zlib 解压
      data = inflateSync(buf.slice(dataStart, dataStart + compressedSize));
    } else {
      // 未知压缩方式:无法解读,跳过该条目数据
      data = Buffer.alloc(0);
    }
    entries.push({ name, data });
    offset = dataStart + compressedSize;
  }
  return entries;
}

// 提取 XML 中所有匹配标签的捕获组(避免重复编译正则)
function extractAll(xml: string, regex: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(regex.source, regex.flags);
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// docx → Markdown
// 解析 word/document.xml:每个 <w:p> 为段落,<w:t> 为文本片段,<w:pStyle> 标识标题样式
function parseDocx(entries: ZipEntry[]): OfficeConvertResult {
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) return { contentType: 'document', markdown: '' };
  const xml = doc.data.toString('utf-8');
  const lines: string[] = [];
  const paragraphs = extractAll(xml, /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g);
  for (const para of paragraphs) {
    const texts = extractAll(para, /<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
    let text = texts.join('');
    const styleMatch = para.match(/<w:pStyle\s+w:val="([^"]*)"/);
    if (styleMatch && /heading/i.test(styleMatch[1])) {
      // 标题样式 HeadingN → N 个 #,缺失数字默认一级
      const levelMatch = styleMatch[1].match(/(\d+)/);
      const level = levelMatch ? Math.min(parseInt(levelMatch[1], 10), 6) : 1;
      text = '#'.repeat(level) + ' ' + text;
    }
    if (text.trim()) lines.push(text);
  }
  return { contentType: 'document', markdown: lines.join('\n\n') };
}

// xlsx → Markdown 表格
// 解析 sharedStrings(共享字符串表)+ worksheets(单元格引用共享字符串索引)
function parseXlsx(entries: ZipEntry[]): OfficeConvertResult {
  // 共享字符串:<si><t>文本</t></si>
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const sharedStrings: string[] = [];
  if (ssEntry) {
    const ssXml = ssEntry.data.toString('utf-8');
    for (const si of extractAll(ssXml, /<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const tMatch = si.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      sharedStrings.push(tMatch ? tMatch[1] : '');
    }
  }
  // 工作表名:从 workbook.xml 读取,保持原始顺序
  const wbEntry = entries.find((e) => e.name === 'xl/workbook.xml');
  const sheetNames: string[] = [];
  if (wbEntry) {
    const wbXml = wbEntry.data.toString('utf-8');
    const sheetRe = /<sheet\b[^>]*name="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = sheetRe.exec(wbXml)) !== null) sheetNames.push(m[1]);
  }
  // 工作表数据:按文件名排序保证 slide1/sheet1 顺序稳定
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const parts: string[] = ['# Excel 工作簿'];
  sheetEntries.forEach((sheetEntry, idx) => {
    const sheetName = sheetNames[idx] || `Sheet${idx + 1}`;
    parts.push(`## Sheet: ${sheetName}`);
    const sheetXml = sheetEntry.data.toString('utf-8');
    const rows: string[][] = [];
    for (const rowContent of extractAll(sheetXml, /<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      const cRe = /<c\b[^>]*>([\s\S]*?)<\/c>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(rowContent)) !== null) {
        // t="s" 表示值为共享字符串索引,其余按字面量处理
        const tAttr = /<c\b[^>]*\bt="([^"]*)"/.exec(cm[0].slice(0, cm[0].indexOf('>') + 1));
        const vMatch = cm[1].match(/<v>([\s\S]*?)<\/v>/);
        let value = '';
        if (vMatch) {
          value = tAttr && tAttr[1] === 's' ? sharedStrings[parseInt(vMatch[1], 10)] || '' : vMatch[1];
        }
        cells.push(value);
      }
      rows.push(cells);
    }
    if (rows.length > 0) {
      const header = rows[0];
      parts.push('| ' + header.join(' | ') + ' |');
      parts.push('| ' + header.map(() => '---').join(' | ') + ' |');
      for (let i = 1; i < rows.length; i++) {
        parts.push('| ' + rows[i].join(' | ') + ' |');
      }
    }
  });
  return { contentType: 'spreadsheet', markdown: parts.join('\n') };
}

// pptx → Markdown 列表
// 解析 ppt/slides/slideN.xml:每个 <a:t> 文本作为列表项
function parsePptx(entries: ZipEntry[]): OfficeConvertResult {
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const parts: string[] = ['# PowerPoint'];
  for (const slideEntry of slideEntries) {
    const xml = slideEntry.data.toString('utf-8');
    for (const t of extractAll(xml, /<a:t>([\s\S]*?)<\/a:t>/g)) {
      if (t.trim()) parts.push('- ' + t);
    }
  }
  return { contentType: 'presentation', markdown: parts.join('\n') };
}

// 主入口:按扩展名分流,旧版二进制格式(.doc/.xls/.ppt)无法用 OOXML 解析器处理,返回友好提示
export function convertOfficeFile(filename: string, buffer: Buffer): OfficeConvertResult {
  const extMatch = filename.toLowerCase().match(/\.(\w+)$/);
  const ext = extMatch ? extMatch[1] : '';
  if (ext === 'docx') return parseDocx(parseZip(buffer));
  if (ext === 'xlsx') return parseXlsx(parseZip(buffer));
  if (ext === 'pptx') return parsePptx(parseZip(buffer));
  // 旧版二进制格式与未知扩展名:提示用户另存为 OOXML 格式
  let markdown = `不支持的格式: .${ext}`;
  if (ext === 'doc') markdown += ',请另存为 .docx 后重试';
  else if (ext === 'xls') markdown += ',请另存为 .xlsx 后重试';
  else if (ext === 'ppt') markdown += ',请另存为 .pptx 后重试';
  return { contentType: 'unsupported', markdown };
}
