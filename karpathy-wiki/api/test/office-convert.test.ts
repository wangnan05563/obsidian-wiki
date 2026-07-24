import { describe, it, expect } from 'vitest';
import { convertOfficeFile } from '../src/utils/office-convert.js';

// ===========================================================================
// 辅助：构建最小有效 ZIP buffer（无压缩，供测试用）
// ===========================================================================
function buildZip(files: Record<string, string>): Buffer {
  var localParts: Buffer[] = [];
  var cdRecords: Buffer[] = [];
  var offsets: number[] = [];
  var pos = 0;

  var names = Object.keys(files);
  for (var ni = 0; ni < names.length; ni++) {
    var name = names[ni];
    offsets.push(pos);
    var dataBuf = Buffer.from(files[name], 'utf-8');
    var nameBuf = Buffer.from(name, 'utf-8');
    var hdr = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(0, 8); // compression stored
    hdr.writeUInt16LE(nameBuf.length, 26);
    hdr.writeUInt32LE(dataBuf.length, 18);
    nameBuf.copy(hdr, 30);
    dataBuf.copy(hdr, 30 + nameBuf.length);
    localParts.push(hdr);
    pos += hdr.length;
  }

  for (var ci = 0; ci < names.length; ci++) {
    var n = Buffer.from(names[ci], 'utf-8');
    var d = Buffer.from(files[names[ci]], 'utf-8');
    var cd = Buffer.alloc(46 + n.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(d.length, 20);
    cd.writeUInt32LE(offsets[ci], 42);
    n.copy(cd, 46);
    cdRecords.push(cd);
  }

  var totalEntries = names.length;
  var cdSize = cdRecords.reduce(function(s, c) { return s + c.length; }, 0);
  var cdStart = localParts.reduce(function(s, c) { return s + c.length; }, 0);

  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...cdRecords, eocd]);
}

// ===========================================================================
// docx -> Markdown 测试
// ===========================================================================
describe('docx conversion', () => {
  it('解析包含段落文本的 .docx', async () => {
    var xml = '<?xml version="1.0"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
      '<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>A second line.</w:t></w:r></w:p>' +
      '</w:body></w:document>';

    var zipBuf = buildZip({
      '[Content_Types].xml': '<Types></Types>',
      'word/document.xml': xml
    });

    var result = await convertOfficeFile('test.docx', zipBuf);
    expect(result.contentType).toBe('document');
    expect(result.markdown).toContain('Hello World');
    expect(result.markdown).toContain('A second line');
  });

  it('正确识别标题样式 Heading1', async () => {
    var xml = '<?xml version="1.0"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
      '<w:r><w:t>My Title</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Body content.</w:t></w:r></w:p>' +
      '</w:body></w:document>';

    var zipBuf = buildZip({
      '[Content_Types].xml': '<Types></Types>',
      'word/document.xml': xml
    });

    var result = await convertOfficeFile('test.docx', zipBuf);
    expect(result.contentType).toBe('document');
    // Heading1 → h1 (#)
    expect(result.markdown).toContain('# My Title');
  });
});

// ===========================================================================
// xlsx -> Markdown 表格测试
// ===========================================================================
describe('xlsx conversion', () => {
  it('提取共享字符串和单元格值', async () => {
    var sharedStrings = '<?xml version="1.0"?>' +
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><t>Name</t></si>' +
      '<si><t>Age</t></si>' +
      '<si><t>Alice</t></si>' +
      '<si><t>30</t></si>' +
      '</sst>';

    var workbook = '<?xml version="1.0"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>';

    var sheet1 = '<?xml version="1.0"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
      '</sheetData></worksheet>';

    var zipBuf = buildZip({
      '[Content_Types].xml': '<Types></Types>',
      'xl/sharedStrings.xml': sharedStrings,
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': '',
      'xl/worksheets/sheet1.xml': sheet1
    });

    var result = await convertOfficeFile('test.xlsx', zipBuf);
    expect(result.contentType).toBe('spreadsheet');
    expect(result.markdown).toContain('# Excel 工作簿');
    expect(result.markdown).toContain('## Sheet: People');
    expect(result.markdown).toContain('| Name | Age |');
    expect(result.markdown).toContain('Alice');
  });
});

// ===========================================================================
// pptx -> Markdown 幻灯片测试
// ===========================================================================
describe('pptx conversion', () => {
  it('提取幻灯片文本为列表项', async () => {
    var presentation = '<?xml version="1.0"?>' +
      '<presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<sldId r:id="rId1"/>' +
      '</presentation>';

    var slide1 = '<?xml version="1.0"?>' +
      '<p:slide xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:cNvPr id="1" name="Title"/>' +
      '<p:sp>' +
      '<p:txBody><a:p><a:t>Hello Slide</a:t></a:p></p:txBody>' +
      '</p:sp></p:slide>';

    var zipBuf = buildZip({
      '[Content_Types].xml': '<Types></Types>',
      'ppt/presentation.xml': presentation,
      'ppt/slides/slide1.xml': slide1
    });

    var result = await convertOfficeFile('test.pptx', zipBuf);
    expect(result.contentType).toBe('presentation');
    expect(result.markdown).toContain('# PowerPoint');
    expect(result.markdown).toContain('- Hello Slide');
  });
});

// ===========================================================================
// 旧版二进制格式（.doc/.xls/.ppt）应返回友好错误
// ===========================================================================
describe('legacy formats (.doc/.xls/.ppt)', () => {
  it('.doc 返回 unsupported 并提示另存为 .docx', async () => {
    var buf = Buffer.from('fake doc content');
    var result = await convertOfficeFile('resume.doc', buf);
    expect(result.contentType).toBe('unsupported');
    expect(result.markdown).toContain('.doc');
    expect(result.markdown).toContain('.docx');
  });

  it('.xls 返回 unsupported', async () => {
    var buf = Buffer.from('fake xls');
    var result = await convertOfficeFile('data.xls', buf);
    expect(result.contentType).toBe('unsupported');
  });

  it('.ppt 返回 unsupported', async () => {
    var buf = Buffer.from('fake ppt');
    var result = await convertOfficeFile('deck.ppt', buf);
    expect(result.contentType).toBe('unsupported');
  });

  it('未知扩展名返回 unsupported', async () => {
    var buf = Buffer.from('unknown');
    var result = await convertOfficeFile('file.xyz', buf);
    expect(result.contentType).toBe('unsupported');
  });
});
