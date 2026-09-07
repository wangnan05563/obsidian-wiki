import { convertOfficeFile } from '../karpathy-wiki/api/src/utils/office-convert.ts';
import fs from 'node:fs/promises';

const base = 'E:/000-交付经理/02培训/2026新人培训包/02票交所接口/中国票据业务系统接口规范V1.4';
const samples: Array<[string, string]> = [
  ['doc', base + '/附件1：中国票据业务系统接口规范V1.4/1.中国票据业务系统直连接口规范（概述分册）.doc'],
  ['xls', base + '/附件1：中国票据业务系统接口规范V1.4/概述分册附件/附录2：基础数据清单.xls'],
  ['xlsx', base + '/附件1：中国票据业务系统接口规范V1.4/概述分册附件/附录1：报文清单.xlsx'],
  ['txt', base + '/报文校验文件（Schema）/readme.txt'],
];
for (const [label, p] of samples) {
  const buf = await fs.readFile(p);
  const r = await convertOfficeFile(p.split('/').pop()!, buf);
  console.log('=== ' + label + ' (' + buf.length + ' bytes) ===');
  console.log('contentType:', r.contentType);
  console.log('markdown[:200]:', JSON.stringify(r.markdown.slice(0, 200)));
  console.log('markdown length:', r.markdown.length);
  console.log();
}
