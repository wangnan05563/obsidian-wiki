import { convertOfficeFile } from './src/utils/office-convert.js';
import * as F from 'fs';
import * as path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Build minimal ZIP helper
function buildZip(files) {
  var localParts = [], cdRecords = [], offsets = [];
  var pos = 0;
  var names = Object.keys(files);
  for (var ni = 0; ni < names.length; ni++) {
    offsets.push(pos);
    var dataBuf = Buffer.from(files[names[ni]], 'utf-8');
    var nameBuf = Buffer.from(names[ni], 'utf-8');
    var hdr = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(0, 8);
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

var passCount = 0, failCount = 0;
function assert(condition, msg) {
  if (condition) { console.log('  ✓', msg); passCount++; }
  else { console.log('  ✗ FAIL:', msg); failCount++; }
}

console.log('=== Running office-convert tests ===\n');

// Test 1: docx basic text
console.log('Test 1: docx basic text extraction');
var xml1 = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello World</w:t></w:r></w:p></w:body></w:document>';
var r1 = await convertOfficeFile('test.docx', buildZip({'[Content_Types].xml': '<Types></Types>', 'word/document.xml': xml1}));
assert(r1.contentType === 'document', 'contentType is document');
assert(r1.markdown.includes('Hello World'), 'contains "Hello World"');

// Test 2: docx with heading
console.log('Test 2: docx heading detection');
var xml2 = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>My Title</w:t></w:r></w:p></w:body></w:document>';
var r2 = await convertOfficeFile('t.docx', buildZip({'[Content_Types].xml': '<Types></Types>', 'word/document.xml': xml2}));
assert(r2.contentType === 'document', 'contentType is document');
assert(r2.markdown.includes('# My Title'), 'heading rendered as h1');

// Test 3: xlsx
console.log('Test 3: xlsx table extraction');
var ss = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>A</t></si><si><t>B</t></si><si><t>1</t></si><si><t>2</t></si></sst>';
var wb = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
var sh = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row></sheetData></worksheet>';
var r3 = await convertOfficeFile('t.xlsx', buildZip({
  '[Content_Types].xml': '<Types></Types>',
  'xl/sharedStrings.xml': ss,
  'xl/workbook.xml': wb,
  'xl/_rels/workbook.xml.rels': '',
  'xl/worksheets/sheet1.xml': sh
}));
assert(r3.contentType === 'spreadsheet', 'contentType is spreadsheet');
assert(r3.markdown.includes('| A | B |'), 'header row present');
assert(r3.markdown.includes('| 1 | 2 |') || r3.markdown.includes('1') && r3.markdown.includes('2'), 'cell values present');

// Test 4: pptx
console.log('Test 4: pptx slide extraction');
var pres = '<?xml version="1.0"?><presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><sldId r:id="rId1"/></presentation>';
var slide = '<?xml version="1.0"?><p:slide xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:txBody><a:p><a:t>Hello Slide</a:t></a:p></p:txBody></p:slide>';
var r4 = await convertOfficeFile('t.pptx', buildZip({
  '[Content_Types].xml': '<Types></Types>',
  'ppt/presentation.xml': pres,
  'ppt/slides/slide1.xml': slide
}));
assert(r4.contentType === 'presentation', 'contentType is presentation');
assert(r4.markdown.includes('Hello Slide'), 'slide text extracted');

// Test 5: legacy formats
console.log('Test 5: legacy format rejection');
var r5a = await convertOfficeFile('resume.doc', Buffer.from('fake'));
assert(r5a.contentType === 'unsupported', '.doc returns unsupported');
assert(r5a.markdown.includes('.doc'), 'error mentions .doc');

var r5b = await convertOfficeFile('data.xls', Buffer.from('fake'));
assert(r5b.contentType === 'unsupported', '.xls returns unsupported');

var r5c = await convertOfficeFile('deck.ppt', Buffer.from('fake'));
assert(r5c.contentType === 'unsupported', '.ppt returns unsupported');

// Test 6: unknown extension
var r6 = await convertOfficeFile('file.xyz', Buffer.from('fake'));
assert(r6.contentType === 'unsupported', '.xyz returns unsupported');

// Summary
console.log('\n=============================');
console.log('Results: ' + passCount + ' passed, ' + failCount + ' failed');
if (failCount === 0) console.log('All tests PASSED!');
else process.exit(1);
