// ole2-extract.ts 单元测试：零依赖 OLE2/CFB 解析器的纯逻辑与合成二进制容器行为。
//
// 为什么用合成 CFB 而非真实 .doc 样本：真实 Office 文件体积大且入库会污染仓库；
//   MS-CFB 布局是规范化的（header 字段偏移见源码注释），按规范合成的容器能精确
//   驱动 FAT 链 / MiniFAT / mini stream / 目录扇区 / Word 片表（Pcdt）各分支，
//   且完全确定性（无 IO、无时钟）。
// 覆盖重点：
//   - extractTextFromBuffer：UTF-16LE 可见 run 过滤（长度/强字符占比双阈值）、空白归一
//   - parseCfb：魔数/长度/sectorShift 守卫、正常解析、mini stream 读取、非法目录项跳过
//   - extractWordText：片表定位（marker/lcb/CP 校验/PCD 越界）、压缩与未压缩片段、控制字符清洗
//   - extractOle2Text：Word 片表优先、无 WordDocument 时回退 run 扫描
//   - _debugCfbEntries：调试入口的守卫与目录列举
import { describe, it, expect } from 'vitest';
import {
  extractTextFromBuffer,
  parseCfb,
  extractWordText,
  extractOle2Text,
  _debugCfbEntries,
} from '../src/utils/ole2-extract.js';

const SECT = 512;
const END = 0xfffffffe; // ENDOFCHAIN
const FREE = 0xffffffff;
const FATSAT = 0xfffffffd;

/** 128 字节 MS-CFB 目录项（本解析器只读 name/nameLen/objType/startSector/size 字段） */
function dirEntry(name: string, objType: number, startSector: number, size: number): Buffer {
  const e = Buffer.alloc(128);
  const nameBuf = Buffer.from(name, 'utf16le');
  nameBuf.copy(e, 0);
  e.writeUInt16LE(nameBuf.length + 2, 64); // NameLength 含 NUL 终止符
  e.writeUInt8(objType, 66);
  e.writeUInt8(1, 67); // 树颜色：黑
  e.writeUInt32LE(FREE, 68);
  e.writeUInt32LE(FREE, 72);
  e.writeUInt32LE(FREE, 76);
  e.writeUInt32LE(startSector >>> 0, 116);
  e.writeUInt32LE(size >>> 0, 120);
  e.writeUInt32LE(Math.floor(size / 0x100000000), 124);
  return e;
}

interface CfbBuildOpts {
  /** 大流（≥4096 字节，按 FAT 链存储） */
  bigStreams?: Array<{ name: string; data: Buffer }>;
  /** 小流（<4096 字节，存进 Root Entry mini stream 容器，走 MiniFAT 链） */
  miniStreams?: Array<{ name: string; data: Buffer }>;
  /** 额外写入目录扇区的原始目录项（用于构造越界/存储对象等非法项） */
  extraEntries?: Buffer[];
  /** 是否追加外部 DIFAT 扇区（前 127 项写 0、链尾 ENDOFCHAIN） */
  withDifatSector?: boolean;
}

/** 按 MS-CFB 规范合成一个可被 parseCfb 解析的最小容器 */
function buildCfb(opts: CfbBuildOpts): Buffer {
  const bigs = opts.bigStreams ?? [];
  const minis = opts.miniStreams ?? [];

  // ---- 扇区布局：sector0=FAT，随后目录、大流、mini 容器、MiniFAT、(DIFAT) ----
  const entryCount = 1 + bigs.length + minis.length + (opts.extraEntries?.length ?? 0);
  const dirCount = Math.max(1, Math.ceil(entryCount / 4));

  let next = 1; // sector 0 = FAT
  const dirStart = next; next += dirCount;

  const bigChainStarts: number[] = [];
  for (const s of bigs) {
    const n = Math.ceil(s.data.length / SECT);
    bigChainStarts.push(next);
    next += n;
  }

  // mini 容器：各小流依次按 64 字节 mini 扇区拼接
  const miniStarts: number[] = [];
  let miniSectorCursor = 0;
  const containerParts: Buffer[] = [];
  for (const s of minis) {
    miniStarts.push(miniSectorCursor);
    const padded = Math.ceil(s.data.length / 64) * 64;
    const part = Buffer.alloc(padded);
    s.data.copy(part, 0);
    containerParts.push(part);
    miniSectorCursor += padded / 64;
  }
  const containerBytes = containerParts.reduce((a, b) => a + b.length, 0);
  const containerBuf = Buffer.concat(containerParts);
  const containerSectors = Math.ceil(containerBytes / SECT);
  const containerStart = next; next += containerSectors;
  const miniFatSector = next; next += 1;
  const difatSector = opts.withDifatSector ? next : END;
  if (opts.withDifatSector) next += 1;
  const totalSectors = next; // 含 sector0(FAT)

  const buf = Buffer.alloc((totalSectors + 1) * SECT);

  // ---- header ----
  buf.writeUInt32LE(0xe011cfd0, 0);
  buf.writeUInt32LE(0xe11ab1a1, 4);
  buf.writeUInt16LE(9, 30); // sectorShift → 512
  buf.writeUInt16LE(6, 32); // miniSectorShift → 64
  buf.writeUInt32LE(dirStart, 48);
  buf.writeUInt32LE(4096, 56); // miniCutoff
  buf.writeUInt32LE(miniFatSector, 60);
  buf.writeUInt32LE(1, 64); // numMiniFat 扇区
  buf.writeUInt32LE(difatSector, 68);
  // 未用 DIFAT 槽按真实文件写 0xFFFFFFFF（非 FREESECT(0)/ENDOFCHAIN，不参与尾部裁剪），
  // 保留首个表项 0（FAT 在 sector0，WPS 风格前导 0 引用）
  for (let i = 0; i < 109; i++) buf.writeUInt32LE(i === 0 ? 0 : FREE, 72 + i * 4);

  // ---- FAT ----
  const fatOff = (n: number) => (n + 1) * SECT;
  const fat = new Array(totalSectors).fill(FREE);
  fat[0] = FATSAT;
  for (let i = 0; i < dirCount; i++) fat[dirStart + i] = i + 1 < dirCount ? dirStart + i + 1 : END;
  bigs.forEach((s, idx) => {
    const start = bigChainStarts[idx];
    const n = Math.ceil(s.data.length / SECT);
    for (let i = 0; i < n; i++) fat[start + i] = i + 1 < n ? start + i + 1 : END;
  });
  for (let i = 0; i < containerSectors; i++)
    fat[containerStart + i] = i + 1 < containerSectors ? containerStart + i + 1 : END;
  fat[miniFatSector] = END;
  if (opts.withDifatSector) fat[difatSector] = END;
  for (let i = 0; i < fat.length; i++) buf.writeUInt32LE(fat[i] >>> 0, fatOff(0) + i * 4);

  // ---- 目录 ----
  const entries: Buffer[] = [];
  entries.push(dirEntry('Root Entry', 5, containerStart, containerBytes));
  bigs.forEach((s, idx) => entries.push(dirEntry(s.name, 2, bigChainStarts[idx], s.data.length)));
  minis.forEach((s, idx) => entries.push(dirEntry(s.name, 2, miniStarts[idx], s.data.length)));
  if (opts.extraEntries) entries.push(...opts.extraEntries);
  entries.forEach((e, i) => e.copy(buf, fatOff(dirStart) + i * 128));

  // ---- 大流内容 ----
  bigs.forEach((s, idx) => s.data.copy(buf, fatOff(bigChainStarts[idx])));
  // ---- mini 容器内容 ----
  if (containerBytes > 0) containerBuf.copy(buf, fatOff(containerStart));
  // ---- MiniFAT ----
  const mfOff = fatOff(miniFatSector);
  for (let i = 0; i < 128; i++) buf.writeUInt32LE(FREE, mfOff + i * 4);
  minis.forEach((s, idx) => {
    const start = miniStarts[idx];
    const n = Math.ceil(s.data.length / 64);
    for (let i = 0; i < n; i++) buf.writeUInt32LE(i + 1 < n ? start + i + 1 : END, mfOff + (start + i) * 4);
  });
  // ---- 外部 DIFAT 扇区：前 127 项 0（重复引用 sector0，被 fatSeen 去重），链尾 ENDOFCHAIN ----
  if (opts.withDifatSector) {
    const dOff = fatOff(difatSector);
    for (let i = 0; i < 127; i++) buf.writeUInt32LE(0, dOff + i * 4);
    buf.writeUInt32LE(END, dOff + 127 * 4);
  }
  return buf;
}

/** 合成 Word97 WordDocument 流：Pcdt 片表 + 数据区 */
function buildWordDoc(
  pieces: Array<{ cp: number; text: string; compress: boolean }>,
  opts?: { badOffsets?: boolean; zeroGap?: boolean },
): Buffer {
  const n = pieces.length;
  const cps: number[] = [0];
  for (let i = 0; i < n; i++) {
    const len = opts?.zeroGap && i === 0 ? 0 : pieces[i].cp;
    cps.push(cps[cps.length - 1] + len);
  }
  const plcStart = 5;
  const pcdBase = plcStart + (n + 1) * 4;
  const dataBase = pcdBase + n * 8;

  const dataParts: Array<{ buf: Buffer; offset: number }> = [];
  let cursor = dataBase;
  for (const p of pieces) {
    const raw = p.compress ? Buffer.from(p.text, 'latin1') : Buffer.from(p.text, 'utf16le');
    dataParts.push({ buf: raw, offset: cursor });
    cursor += raw.length;
  }
  const total = cursor;
  const buf = Buffer.alloc(Math.max(total, 0x40));
  buf[0] = 2; // Pcdt marker
  buf.writeUInt32LE(12 * n + 4, 1);
  for (let i = 0; i <= n; i++) buf.writeUInt32LE(cps[i], plcStart + i * 4);
  pieces.forEach((p, i) => {
    const offset = opts?.badOffsets ? dataParts[i].offset + 0x300000 : dataParts[i].offset;
    const fc = offset | (p.compress ? 0x40000000 : 0);
    buf.writeUInt32LE(fc >>> 0, pcdBase + i * 8);
    buf.writeUInt32LE(0, pcdBase + i * 8 + 4); // prm
  });
  for (const d of dataParts) d.buf.copy(buf, d.offset);
  return buf;
}

describe('extractTextFromBuffer（UTF-16LE 可见 run 提取）', () => {
  it('空 buffer → 空串', () => {
    expect(extractTextFromBuffer(Buffer.alloc(0))).toBe('');
  });

  it('纯二进制噪声（无可打印 run）→ 空串', () => {
    const noise = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    expect(extractTextFromBuffer(noise)).toBe('');
  });

  it('长度不足 MIN_RUN(4) 的 run 被过滤：3 字中文提取不到', () => {
    const buf = Buffer.from('你好吗', 'utf16le');
    expect(extractTextFromBuffer(buf)).toBe('');
  });

  it('恰好 4 个强字符的 run 保留', () => {
    const buf = Buffer.from('测试文档', 'utf16le');
    expect(extractTextFromBuffer(buf)).toBe('测试文档');
  });

  it('强字符占比 <0.3 的 run 判为噪声：纯 Latin-1 扩展字符被丢弃', () => {
    // 0xE0-0xFF 可打印（isPrintable）但非强字符（isStrong）→ strong/len=0 <0.3
    const s = '\u00e0'.repeat(10);
    expect(extractTextFromBuffer(Buffer.from(s, 'utf16le'))).toBe('');
  });

  it('强字符占比 ≥0.3 的混合 run 保留（4 拉丁字母 + 2 弱字符）', () => {
    const s = 'abcd\u00e9\u00e8';
    expect(extractTextFromBuffer(Buffer.from(s, 'utf16le'))).toBe(s);
  });

  it('多个 run 换行拼接，行尾空白被清理', () => {
    const run1 = Buffer.from('第一段文字   ', 'utf16le');
    const sep = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const run2 = Buffer.from('第二段文字', 'utf16le');
    const out = extractTextFromBuffer(Buffer.concat([run1, sep, run2]));
    expect(out).toBe('第一段文字\n第二段文字');
  });

  it('全角空格（\u3000，属 \s 且可打印）不截断 run', () => {
    const out = extractTextFromBuffer(Buffer.from('票据\u3000业务系统', 'utf16le'));
    expect(out.replace(/\s+/g, '')).toBe('票据业务系统');
  });

  it('ASCII 文本按 UTF-16LE 交错零字节形态可提取（真实 .doc 中 ASCII 存储形态）', () => {
    const s = 'HelloDoc';
    expect(extractTextFromBuffer(Buffer.from(s, 'utf16le'))).toBe(s);
  });
});

describe('parseCfb 守卫分支', () => {
  it('小于 512 字节 → []', () => {
    expect(parseCfb(Buffer.alloc(100))).toEqual([]);
  });

  it('魔数不匹配 → []', () => {
    const buf = Buffer.alloc(2048);
    buf.writeUInt32LE(0x12345678, 0);
    expect(parseCfb(buf)).toEqual([]);
  });

  it('sectorShift 越界（<8 或 >16）→ []', () => {
    const buf = buildCfb({});
    buf.writeUInt16LE(7, 30);
    expect(parseCfb(buf)).toEqual([]);
    const buf2 = buildCfb({});
    buf2.writeUInt16LE(17, 30);
    expect(parseCfb(buf2)).toEqual([]);
  });

  it('魔数正确但 DIFAT 全 FREESECT(0) → 尾部裁剪后 FAT 为空 → []', () => {
    const buf = Buffer.alloc(2048);
    buf.writeUInt32LE(0xe011cfd0, 0);
    buf.writeUInt32LE(0xe11ab1a1, 4);
    buf.writeUInt16LE(9, 30);
    for (let i = 0; i < 109; i++) buf.writeUInt32LE(0, 72 + i * 4);
    expect(parseCfb(buf)).toEqual([]);
  });

  it('目录扇区越界（firstDir 指向文件外）→ 无目录项 → []', () => {
    const buf = buildCfb({ bigStreams: [{ name: 'Data', data: Buffer.from('内容'.repeat(2000), 'utf16le') }] });
    buf.writeUInt32LE(999999, 48);
    expect(parseCfb(buf)).toEqual([]);
  });
});

describe('parseCfb / extractOle2Text（合成 CFB 容器）', () => {
  const cjk = '中国票据业务系统接口规范文档内容一二三';
  const bigText = Buffer.from(cjk.repeat(300), 'utf16le'); // ≥4096，走 FAT 大流

  it('大流（≥miniCutoff）按 FAT 链读取，内容 round-trip', () => {
    const streams = parseCfb(buildCfb({ bigStreams: [{ name: 'Data', data: bigText }] }));
    expect(streams.map((s) => s.name)).toContain('Data');
    const data = streams.find((s) => s.name === 'Data')!;
    expect(extractTextFromBuffer(data.data)).toContain('中国票据业务系统接口规范');
  });

  it('小流（<miniCutoff）走 MiniFAT/mini stream 容器读取', () => {
    const small = Buffer.from('小型流内容测试数据', 'utf16le');
    const streams = parseCfb(buildCfb({ miniStreams: [{ name: 'Small', data: small }] }));
    const s = streams.find((x) => x.name === 'Small')!;
    expect(s).toBeDefined();
    expect(s.data.subarray(0, small.length)).toEqual(small);
  });

  it('混合布局：大流 + 多个小流（含跨多 mini 扇区）全部解析', () => {
    const buf = buildCfb({
      bigStreams: [{ name: 'Big1', data: bigText }],
      miniStreams: [
        { name: 'Mini1', data: Buffer.from('第一个小流数据', 'utf16le') },
        { name: 'Mini2', data: Buffer.from('第二个小流数据跨多个mini扇区'.repeat(4), 'utf16le') },
      ],
    });
    const names = parseCfb(buf).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['Big1', 'Mini1', 'Mini2']));
  });

  it('外部 DIFAT 扇区链被读取且不破坏解析', () => {
    const buf = buildCfb({
      bigStreams: [{ name: 'Big1', data: bigText }],
      withDifatSector: true,
    });
    expect(parseCfb(buf).map((s) => s.name)).toContain('Big1');
  });

  it('非法目录项被跳过：存储对象/0 大小/超文件长度', () => {
    const buf = buildCfb({
      bigStreams: [{ name: 'Good', data: bigText }],
      extraEntries: [
        dirEntry('StorageObj', 1, 5, 100), // objType=1 非流
        dirEntry('ZeroSize', 2, 5, 0), // size<=0
        dirEntry('TooBig', 2, 5, 99 * 1024 * 1024), // 超过 buffer.length*2
      ],
    });
    const names = parseCfb(buf).map((s) => s.name);
    expect(names).toContain('Good');
    expect(names).not.toContain('StorageObj');
    expect(names).not.toContain('ZeroSize');
    expect(names).not.toContain('TooBig');
  });

  it('extractOle2Text：非 CFB buffer → 空串', () => {
    expect(extractOle2Text(Buffer.from('not a compound file at all'))).toBe('');
  });

  it('extractOle2Text：无 WordDocument 流 → 回退 run 扫描合并各流文本', () => {
    const buf = buildCfb({
      bigStreams: [{ name: 'Workbook', data: bigText }],
      miniStreams: [{ name: 'Summary', data: Buffer.from('摘要信息小流内容', 'utf16le') }],
    });
    const text = extractOle2Text(buf);
    expect(text).toContain('中国票据业务系统接口规范');
    expect(text).toContain('摘要信息小流内容');
  });

  it('extractOle2Text：WordDocument 有片表 → 走片表干净文本', () => {
    const word = buildWordDoc([
      { cp: 30, text: '第一章票据业务总则与适用范围说明文档', compress: false },
      { cp: 60, text: 'ARTICLE 1234567890 ABCDEFGHIJKLMNOPQRST', compress: true },
    ]);
    const buf = buildCfb({ miniStreams: [{ name: 'WordDocument', data: word }] });
    const text = extractOle2Text(buf);
    expect(text).toContain('第一章票据业务总则与适用范围说明文档');
    expect(text).toContain('ARTICLE 1234567890 ABCDEFGHIJKLMNOPQRST');
  });

  it('extractOle2Text：WordDocument 无片表 → 回退 run 扫描不抛错', () => {
    const word = Buffer.from('A'.repeat(200), 'latin1'); // 无 Pcdt 签名
    const buf = buildCfb({ miniStreams: [{ name: 'WordDocument', data: word }] });
    expect(() => extractOle2Text(buf)).not.toThrow();
    expect(typeof extractOle2Text(buf)).toBe('string');
  });

  it('extractOle2Text：片表文本 <50 字符 → 视为失败回退 run 扫描', () => {
    const word = buildWordDoc([{ cp: 8, text: '短标题内容', compress: false }]);
    const buf = buildCfb({ miniStreams: [{ name: 'WordDocument', data: word }] });
    expect(typeof extractOle2Text(buf)).toBe('string');
  });
});

describe('extractWordText（Word97 片表提取）', () => {
  it('长度 <0x40 → null', () => {
    expect(extractWordText(Buffer.alloc(16))).toBeNull();
  });

  it('无 Pcdt 签名 → null', () => {
    expect(extractWordText(Buffer.from('A'.repeat(256), 'latin1'))).toBeNull();
  });

  it('marker 正确但 lcb 超界 → null', () => {
    const buf = Buffer.alloc(0x50);
    buf.fill(0x41);
    buf[0] = 2;
    buf.writeUInt32LE(0x7ffffff0, 1);
    expect(extractWordText(buf)).toBeNull();
  });

  it('lcb 不满足 (lcb-4)%12==0 → null', () => {
    const buf = Buffer.alloc(0x50);
    buf.fill(0x41);
    buf[0] = 2;
    buf.writeUInt32LE(10, 1);
    expect(extractWordText(buf)).toBeNull();
  });

  it('CP 序列非单调 → null', () => {
    const buf = Buffer.alloc(0x80);
    buf.fill(0x41);
    buf[0] = 2;
    buf.writeUInt32LE(12 * 2 + 4, 1); // n=2
    buf.writeUInt32LE(100, 5);
    buf.writeUInt32LE(50, 9); // 递减 → 非法
    buf.writeUInt32LE(200, 13);
    expect(extractWordText(buf)).toBeNull();
  });

  it('PCD 偏移全部越界（有效数低于阈值）→ null', () => {
    const word = buildWordDoc(
      [
        { cp: 10, text: '0123456789', compress: true },
        { cp: 10, text: 'abcdefghij', compress: true },
      ],
      { badOffsets: true },
    );
    expect(extractWordText(word)).toBeNull();
  });

  it('未压缩片段按 UTF-16LE、压缩片段按 latin1 解码并拼接', () => {
    const word = buildWordDoc([
      { cp: 7, text: '中文片断一二三', compress: false },
      { cp: 11, text: 'Hello world', compress: true },
    ]);
    expect(extractWordText(word)).toBe('中文片断一二三Hello world');
  });

  it('零长度片段被跳过', () => {
    const word = buildWordDoc(
      [
        { cp: 7, text: '中文片断一二三', compress: false },
        { cp: 11, text: 'Hello world', compress: true },
      ],
      { zeroGap: true },
    );
    expect(extractWordText(word)).toBe('Hello world');
  });

  it('控制字符清洗：0x0D/0x01 删除、0x0A 保留、连续空格/制表折叠为一个空格', () => {
    const ascii = 'line one\rline two\t\ttabbed\nnext';
    const word = buildWordDoc([
      { cp: ascii.length, text: ascii, compress: true },
      { cp: 6, text: '第二\n行内容', compress: false },
    ]);
    const text = extractWordText(word)!;
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\u0001');
    expect(text).toContain('line one');
    expect(text).toContain('line two tabbed');
    expect(text).toContain('\n');
  });

  it('多片段文本中 3+ 连续换行折叠为 2 个', () => {
    // 未压缩（UTF-16LE）片段：中文 + 4 个连续 \n
    const text = '头部\n\n\n\n尾部尾部尾部尾部';
    const word = buildWordDoc([{ cp: text.length, text, compress: false }]);
    const out = extractWordText(word)!;
    expect(out).toBe('头部\n\n尾部尾部尾部尾部');
  });
});

describe('_debugCfbEntries', () => {
  it('短 buffer / 坏魔数 / 坏 sectorShift → []', () => {
    expect(_debugCfbEntries(Buffer.alloc(200))).toEqual([]);
    const bad = Buffer.alloc(1024);
    expect(_debugCfbEntries(bad)).toEqual([]);
    const buf = buildCfb({});
    buf.writeUInt16LE(3, 30);
    expect(_debugCfbEntries(buf)).toEqual([]);
  });

  it('合法容器：列出 Root Entry 与全部流目录项（含非法 size 项，仅列举不读取）', () => {
    const buf = buildCfb({
      bigStreams: [{ name: 'Stream1', data: Buffer.from('x'.repeat(4200), 'utf16le') }],
      miniStreams: [{ name: 'Stream2', data: Buffer.from('小流', 'utf16le') }],
    });
    const entries = _debugCfbEntries(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain('Root Entry');
    expect(names).toContain('Stream1');
    expect(names).toContain('Stream2');
    const root = entries.find((e) => e.name === 'Root Entry')!;
    expect(root.objType).toBe(5);
    const s1 = entries.find((e) => e.name === 'Stream1')!;
    expect(s1.objType).toBe(2);
    expect(s1.streamSize).toBe(8400);
  });

  it('目录扇区越界时跳过不抛错', () => {
    const buf = buildCfb({ bigStreams: [{ name: 'S', data: Buffer.from('y'.repeat(4200), 'utf16le') }] });
    buf.writeUInt32LE(999999, 48);
    expect(_debugCfbEntries(buf)).toEqual([]);
  });

  it('FAT 位于非 0 扇区（WPS 之外的常规布局）：调试 FAT 构建读取该扇区并列出目录', () => {
    // 手工最小布局：header(512B) + sector0 空 + sector1=FAT + sector2=目录
    const buf = Buffer.alloc(4 * SECT);
    buf.writeUInt32LE(0xe011cfd0, 0);
    buf.writeUInt32LE(0xe11ab1a1, 4);
    buf.writeUInt16LE(9, 30); // sectorShift
    buf.writeUInt32LE(2, 48); // firstDir = sector2
    buf.writeUInt32LE(END, 68); // firstDifat = ENDOFCHAIN（无外部 DIFAT）
    for (let i = 0; i < 109; i++) buf.writeUInt32LE(i === 0 ? 1 : FREE, 72 + i * 4); // DIFAT[0]=sector1
    // FAT 在 sector1（文件偏移 1024）：sector2 → ENDOFCHAIN，其余 FREE
    for (let i = 0; i < SECT / 4; i++) buf.writeUInt32LE(FREE, 2 * SECT + i * 4);
    buf.writeUInt32LE(END, 2 * SECT + 2 * 4);
    // 目录在 sector2（文件偏移 1536）
    dirEntry('Root Entry', 5, END, 0).copy(buf, 3 * SECT);
    dirEntry('Stream1', 2, END, 123).copy(buf, 3 * SECT + 128);
    const entries = _debugCfbEntries(buf);
    expect(entries.map((e) => e.name)).toEqual(['Root Entry', 'Stream1']);
    expect(entries[1]).toMatchObject({ objType: 2, streamSize: 123 });
  });
});
