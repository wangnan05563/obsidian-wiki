// ole2-extract.ts
// Zero-dependency text extraction for legacy Microsoft Office OLE2 Compound Files
// (.doc / .xls / .ppt — Word / Excel / PowerPoint 97-2003).
//
// These are OLE Compound Document (CFB) binaries. The previous code returned an
// "unsupported format" placeholder for them, so the downstream LLM received no
// real content and emitted 0 `write_file` calls → 0 generated pages even though
// the compile progress reported "N/N 篇文档 100%".
//
// This module parses the CFB container, reads every stream, and pulls out the
// printable text (stored primarily as UTF-16LE, with ASCII / Latin-1 also
// decodable as UTF-16LE). It is intentionally dependency-free so it can ship in
// the backend without dragging in pdfjs-dist / tesseract.js.
//
// Header field offsets follow the Microsoft Compound File Binary (MS-CFB)
// specification. Verified against the user's 中国票据业务系统接口规范 .doc/.xls files:
//   firstDir = 48  → value 1  (directory starts at sector 1 = file offset 1024)
//   miniCutoff = 56 → value 4096
//   firstMiniFat = 60 → value 2
//   numMiniFat = 64 → value 1
//   firstDifat = 68 → value 0xFFFFFFFE (ENDOFCHAIN, no external DIFAT)
//   difatStart = 72 (109 entries × 4 bytes)
// A few non-conformant writers exist, so we keep a short candidate list and
// score each by *content quality* (Root Entry presence + extracted text length)
// rather than raw stream count — that way a garbage layout can never out-score
// a real one.

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0x00000000;
const MIN_RUN = 4; // minimal printable run length to keep (filters binary noise)

interface CfbStream {
  name: string;
  data: Buffer;
}

interface DirEntry {
  name: string;
  objType: number; // 1=storage, 2=stream, 5=root
  startSector: number;
  streamSize: number;
}

interface CfbOffsets {
  firstDir: number;
  miniCutoff: number;
  firstMiniFat: number;
  numMiniFat: number;
  firstDifat: number;
  difatStart: number;
}

// Standard MS-CFB layout first; two neighbours kept only as fallbacks for
// unusual writers. parseCfb() scores each by extracted content and keeps the
// best, so the standard layout (which yields a real "Root Entry") always wins.
const OFFSET_STANDARD: CfbOffsets = {
  firstDir: 48,
  miniCutoff: 56,
  firstMiniFat: 60,
  numMiniFat: 64,
  firstDifat: 68,
  difatStart: 72,
};

const OFFSET_CANDIDATES: CfbOffsets[] = [
  OFFSET_STANDARD,
  { firstDir: 46, miniCutoff: 54, firstMiniFat: 58, numMiniFat: 62, firstDifat: 66, difatStart: 70 },
  { firstDir: 50, miniCutoff: 58, firstMiniFat: 62, numMiniFat: 66, firstDifat: 70, difatStart: 74 },
];

function isPrintable(cp: number): boolean {
  if (cp < 0x20) return false;
  if (cp <= 0x7e) return true; // ASCII printable
  if (cp >= 0xa0 && cp <= 0xff) return true; // Latin-1 printable
  if (cp >= 0x3000 && cp <= 0x303f) return true; // CJK symbols & punctuation
  if (cp >= 0x4e00 && cp <= 0x9fff) return true; // CJK unified (core / common)
  if (cp >= 0xff00 && cp <= 0xffef) return true; // fullwidth forms
  // Deliberately EXCLUDE CJK Ext-A (0x3400-0x4dbf), Compatibility (0xf900-0xfaff)
  // and general punctuation (0x2000-0x206f): binary control bytes in Word/Excel
  // frequently decode to those rare codepoints by chance, and keeping them floods
  // the output with garbage. Real Chinese prose lives in the core block above.
  return false;
}

// A "strong" codepoint is one that is almost never produced by coincidental
// binary decoding: digits, ASCII letters, core CJK, CJK punctuation, fullwidth.
function isStrong(cp: number): boolean {
  if (cp >= 0x30 && cp <= 0x39) return true;
  if (cp >= 0x41 && cp <= 0x5a) return true;
  if (cp >= 0x61 && cp <= 0x7a) return true;
  if (cp >= 0x3000 && cp <= 0x303f) return true;
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;
  if (cp >= 0xff00 && cp <= 0xffef) return true;
  return false;
}

function extractUtf16leRuns(buf: Buffer): string[] {
  const runs: string[] = [];
  let cur = '';
  let strong = 0;
  try {
    for (const ch of buf.toString('utf16le')) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isPrintable(cp)) {
        cur += ch;
        if (isStrong(cp)) strong++;
      } else {
        // Accept a run only if it is long enough AND dominated by strong chars,
        // otherwise it is almost certainly binary noise.
        if (cur.length >= MIN_RUN && strong / cur.length >= 0.3) runs.push(cur);
        cur = '';
        strong = 0;
      }
    }
  } catch {
    /* ignore decode errors */
  }
  if (cur.length >= MIN_RUN && strong / cur.length >= 0.3) runs.push(cur);
  return runs;
}

export function extractTextFromBuffer(buf: Buffer): string {
  const runs = extractUtf16leRuns(buf);
  if (runs.length === 0) return '';
  let text = runs.join('\n');
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/\s+/g, (m) => (m.includes('\n') ? ' ' : m)))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

interface CfbParseResult {
  streams: CfbStream[];
  rootFound: boolean;
}

function parseCfbWithOffsets(buffer: Buffer, sectorShift: number, off: CfbOffsets): CfbParseResult {
  const streams: CfbStream[] = [];
  const sectSize = 1 << sectorShift;
  const miniSectSize = 1 << buffer.readUInt16LE(32);
  const firstDirSector = buffer.readUInt32LE(off.firstDir);
  const miniCutoff = buffer.readUInt32LE(off.miniCutoff);
  const firstMiniFatSector = buffer.readUInt32LE(off.firstMiniFat);
  const numMiniFatSectors = buffer.readUInt32LE(off.numMiniFat);
  const firstDifatSector = buffer.readUInt32LE(off.firstDifat);

  const sectorOffset = (s: number) => (s + 1) * sectSize;

  // ---- Build FAT from DIFAT ----
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) difat.push(buffer.readUInt32LE(off.difatStart + i * 4));
  let chain = firstDifatSector;
  let guard = 0;
  while (chain !== ENDOFCHAIN && chain >= 0 && guard < 10000) {
    const coff = sectorOffset(chain);
    if (coff + sectSize > buffer.length) break;
    const count = sectSize / 4;
    for (let i = 0; i < count - 1; i++) difat.push(buffer.readUInt32LE(coff + i * 4));
    chain = buffer.readUInt32LE(coff + (count - 1) * 4);
    guard++;
  }
  // Drop *trailing* unused DIFAT slots (FREESECT / ENDOFCHAIN / special markers)
  // so a valid leading sector-0 reference (WPS-style) survives while unused tail
  // entries don't inject bogus FAT sectors. See parseCfbWithOffsets FAT build.
  const isTrailingUnused = (x: number) =>
    x < 0 || x === ENDOFCHAIN || x === 0xfffffffd || x === 0xfffffffc || x === FREESECT;
  while (difat.length > 0 && isTrailingUnused(difat[difat.length - 1])) difat.pop();

  const fat: number[] = [];
  const fatSeen = new Set<number>();
  for (const fid of difat) {
    // Skip special markers, but NOT a sector-0 reference: some writers (e.g. WPS)
    // record the first FAT sector as 0, which maps to file offset 512 via
    // sectorOffset(0). Freeing/truncating only *trailing* unused entries (done
    // above) keeps such a leading 0 while discarding unused tail slots.
    if (fid < 0 || fid === ENDOFCHAIN || fid === 0xfffffffd || fid === 0xfffffffc) continue;
    if (fatSeen.has(fid)) continue;
    fatSeen.add(fid);
    const coff = sectorOffset(fid);
    if (coff < 0 || coff + sectSize > buffer.length) continue;
    for (let i = 0; i < sectSize; i += 4) fat.push(buffer.readUInt32LE(coff + i));
  }
  if (fat.length === 0) return { streams, rootFound: false };

  const chainSectors = (start: number): number[] => {
    const ids: number[] = [];
    let s = start;
    let g = 0;
    while (s !== ENDOFCHAIN && s >= 0 && g < 200000) {
      ids.push(s);
      if (s >= fat.length) break;
      s = fat[s];
      g++;
    }
    return ids;
  };

  const readChain = (start: number, size: number): Buffer => {
    const ids = chainSectors(start);
    const out = Buffer.alloc(size);
    let written = 0;
    for (const sid of ids) {
      const coff = sectorOffset(sid);
      if (coff + sectSize > buffer.length) break;
      const chunk = buffer.subarray(coff, coff + sectSize);
      const take = Math.min(chunk.length, size - written);
      if (take <= 0) break;
      chunk.subarray(0, take).copy(out, written);
      written += take;
    }
    return out;
  };

  // ---- Directory ----
  const dirSectors = chainSectors(firstDirSector);
  const entries: DirEntry[] = [];
  const seen = new Set<number>();
  for (const ds of dirSectors) {
    if (seen.has(ds)) continue;
    seen.add(ds);
    const coff = sectorOffset(ds);
    if (coff < 0 || coff + sectSize > buffer.length) continue;
    const count = sectSize / 128;
    for (let i = 0; i < count; i++) {
      const eoff = coff + i * 128;
      // Name field is 64 bytes; NameLength is an inclusive count that includes
      // the NUL terminator. Clamp to the field size so a corrupt length can't
      // read past the entry.
      const nameLen = Math.min(buffer.readUInt16LE(eoff + 64), 64);
      if (nameLen <= 2) continue;
      const name = buffer.toString('utf16le', eoff, eoff + nameLen - 2);
      const objType = buffer.readUInt8(eoff + 66);
      const startSector = buffer.readUInt32LE(eoff + 116);
      const low = buffer.readUInt32LE(eoff + 120);
      const high = buffer.readUInt32LE(eoff + 124);
      const streamSize = low + high * 0x100000000;
      entries.push({ name, objType, startSector, streamSize });
    }
  }
  if (entries.length === 0) return { streams, rootFound: false };

  // ---- Mini stream (root storage) ----
  const root = entries.find((e) => e.objType === 5);
  let miniStreamContent: Buffer | null = null;
  const miniFat: number[] = [];
  if (root && firstMiniFatSector >= 0 && numMiniFatSectors > 0) {
    const miniFatSectors = chainSectors(firstMiniFatSector);
    for (const ms of miniFatSectors) {
      const coff = sectorOffset(ms);
      if (coff + sectSize > buffer.length) break;
      for (let i = 0; i < sectSize; i += 4) miniFat.push(buffer.readUInt32LE(coff + i));
    }
    if (root.streamSize > 0)
      miniStreamContent = readChain(root.startSector, Math.min(root.streamSize, buffer.length * 2));
  }

  const readMiniStream = (startMiniSector: number, size: number): Buffer => {
    if (!miniStreamContent || miniFat.length === 0) return Buffer.alloc(0);
    const ids: number[] = [];
    let s = startMiniSector;
    let g = 0;
    while (s !== ENDOFCHAIN && s >= 0 && g < 200000) {
      ids.push(s);
      if (s >= miniFat.length) break;
      s = miniFat[s];
      g++;
    }
    const out = Buffer.alloc(size);
    let written = 0;
    for (const mid of ids) {
      const srcOff = mid * miniSectSize;
      const chunk = miniStreamContent.subarray(srcOff, srcOff + miniSectSize);
      const take = Math.min(chunk.length, size - written);
      if (take <= 0) break;
      chunk.subarray(0, take).copy(out, written);
      written += take;
    }
    return out;
  };

  // ---- Materialize stream content ----
  for (const e of entries) {
    // A stream can never be larger than the file; this also filters garbage
    // directory entries produced when an offset candidate mismatches.
    if (e.objType !== 2 || e.streamSize <= 0 || e.streamSize > buffer.length * 2) continue;
    const size = Math.min(e.streamSize, buffer.length * 2);
    const data =
      size < miniCutoff && miniStreamContent ? readMiniStream(e.startSector, size) : readChain(e.startSector, size);
    if (data && data.length > 0) streams.push({ name: e.name, data });
  }

  const rootFound = entries.some((e) => e.objType === 5 && /root entry/i.test(e.name));
  return { streams, rootFound };
}

/**
 * Parse a legacy Office (OLE2/CFB) buffer into its constituent streams.
 * Returns an empty array for non-CFB buffers.
 */
export interface CfbEntryInfo {
  name: string;
  objType: number;
  startSector: number;
  streamSize: number;
}

export function _debugCfbEntries(buffer: Buffer): CfbEntryInfo[] {
  if (buffer.length < 512) return [];
  if (buffer.readUInt32LE(0) !== 0xe011cfd0 || buffer.readUInt32LE(4) !== 0xe11ab1a1) return [];
  const sectorShift = buffer.readUInt16LE(30);
  if (sectorShift < 8 || sectorShift > 16) return [];
  const off = { firstDir: 48, miniCutoff: 56, firstMiniFat: 60, numMiniFat: 64, firstDifat: 68, difatStart: 72 };
  const sectSize = 1 << sectorShift;
  const firstDirSector = buffer.readUInt32LE(off.firstDir);
  const sectorOffset = (s: number) => (s + 1) * sectSize;
  // minimal FAT build (standard offsets)
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) difat.push(buffer.readUInt32LE(off.difatStart + i * 4));
  let chain = buffer.readUInt32LE(off.firstDifat);
  let guard = 0;
  while (chain !== 0xfffffffe && chain >= 0 && guard < 10000) {
    const coff = sectorOffset(chain);
    if (coff + sectSize > buffer.length) break;
    const count = sectSize / 4;
    for (let i = 0; i < count - 1; i++) difat.push(buffer.readUInt32LE(coff + i * 4));
    chain = buffer.readUInt32LE(coff + (count - 1) * 4);
    guard++;
  }
  const fat: number[] = [];
  for (const fid of difat) {
    if (fid < 0 || fid === 0xfffffffe || fid === 0xfffffffd || fid === 0xfffffffc || fid === 0) continue;
    const coff = sectorOffset(fid);
    if (coff < 0 || coff + sectSize > buffer.length) continue;
    for (let i = 0; i < sectSize; i += 4) fat.push(buffer.readUInt32LE(coff + i));
  }
  const chainSectors = (start: number): number[] => {
    const ids: number[] = [];
    let s = start;
    let g = 0;
    while (s !== 0xfffffffe && s >= 0 && g < 200000) {
      ids.push(s);
      if (s >= fat.length) break;
      s = fat[s];
      g++;
    }
    return ids;
  };
  const entries: CfbEntryInfo[] = [];
  for (const ds of chainSectors(firstDirSector)) {
    const coff = sectorOffset(ds);
    if (coff < 0 || coff + sectSize > buffer.length) continue;
    const count = sectSize / 128;
    for (let i = 0; i < count; i++) {
      const eoff = coff + i * 128;
      const nameLen = Math.min(buffer.readUInt16LE(eoff + 64), 64);
      if (nameLen <= 2) continue;
      const name = buffer.toString('utf16le', eoff, eoff + nameLen - 2);
      const objType = buffer.readUInt8(eoff + 66);
      const startSector = buffer.readUInt32LE(eoff + 116);
      const low = buffer.readUInt32LE(eoff + 120);
      const high = buffer.readUInt32LE(eoff + 124);
      const streamSize = low + high * 0x100000000;
      entries.push({ name, objType, startSector, streamSize });
    }
  }
  return entries;
}

export function parseCfb(buffer: Buffer): CfbStream[] {
  if (buffer.length < 512) return [];
  if (buffer.readUInt32LE(0) !== 0xe011cfd0 || buffer.readUInt32LE(4) !== 0xe11ab1a1) return [];

  const sectorShift = buffer.readUInt16LE(30);
  if (sectorShift < 8 || sectorShift > 16) return [];

  let best: CfbStream[] = [];
  let bestScore = -1;
  for (const off of OFFSET_CANDIDATES) {
    const { streams, rootFound } = parseCfbWithOffsets(buffer, sectorShift, off);
    // Score: a genuine Root Entry is the strongest signal of a correct parse;
    // for layouts without one we still prefer the candidate that yields the
    // most real text. This guarantees a conformant file beats any garbage.
    let textLen = 0;
    for (const s of streams) textLen += extractTextFromBuffer(s.data).length;
    const score = (rootFound ? 1_000_000 : 0) + textLen;
    if (score > bestScore) {
      bestScore = score;
      best = streams;
    }
    // Short-circuit: a correct standard parse already wins.
    if (rootFound && textLen > 1000) break;
  }
  return best;
}

/**
 * Extract clean text from a Word 97-2003 (.doc) `WordDocument` stream by walking
 * its piece table (CLX). Each piece records whether it is stored as UTF-16 (2
 * bytes/CP, used for CJK text) or as single-byte ANSI (1 byte/CP, used for
 * ASCII). This is far cleaner than naive UTF-16LE run scanning, which mistakes
 * binary control bytes for CJK codepoints. Returns null if the FIB/CLX cannot
 * be parsed, so the caller can fall back to run scanning.
 */
export /**
 * Locate the piece table (Pcdt) inside a WordDocument stream. The Pcdt begins
 * with marker byte 0x02 followed by a 4-byte PLC length (lcb = 12*n + 4); the
 * PLC holds n+1 character positions (CPs, strictly increasing) plus n 8-byte
 * PCDs. We scan for that signature and validate it, which makes extraction
 * independent of the FIB layout (Word 97 vs 2000+ place fcClx at different
 * offsets, so a fixed read fails on Word 97 docs — nFib 193 here).
 */
function findClx(word: Buffer): { plcStart: number; n: number } | null {
  let best: { plcStart: number; n: number; valid: number } | null = null;
  for (let off = 0; off + 5 < word.length; off++) {
    if (word[off] !== 2) continue; // Pcdt marker
    const lcb = word.readUInt32LE(off + 1);
    if (lcb <= 0 || lcb > word.length) continue;
    if ((lcb - 4) % 12 !== 0) continue;
    const n = (lcb - 4) / 12;
    if (n < 1 || n > 500000) continue;
    const plcStart = off + 5;
    if (plcStart + lcb > word.length) continue;
    let ok = true;
    let prev = -1;
    let maxCp = 0;
    for (let i = 0; i <= n; i++) {
      const cp = word.readUInt32LE(plcStart + i * 4);
      if (cp < prev) {
        ok = false;
        break;
      }
      prev = cp;
      if (cp > maxCp) maxCp = cp;
    }
    if (!ok || maxCp <= 0 || maxCp > 20_000_000) continue;
    // Validate that most PCDs reference in-bounds offsets.
    const pcdBase = plcStart + (n + 1) * 4;
    let valid = 0;
    for (let i = 0; i < n; i++) {
      const cpEnd = word.readUInt32LE(plcStart + (i + 1) * 4);
      const lenCp = cpEnd - word.readUInt32LE(plcStart + i * 4);
      if (lenCp <= 0) continue;
      const fc = word.readUInt32LE(pcdBase + i * 8);
      const offset = fc & 0x3fffffff;
      const need = fc & 0x40000000 ? lenCp : lenCp * 2;
      if (offset + need <= word.length) valid++;
    }
    if (valid < Math.max(1, Math.floor(n * 0.5))) continue;
    if (!best || valid > best.valid) best = { plcStart, n, valid };
  }
  return best ? { plcStart: best.plcStart, n: best.n } : null;
}

export function extractWordText(word: Buffer): string | null {
  if (word.length < 0x40) return null;
  const clx = findClx(word);
  if (!clx) return null;
  const { plcStart, n } = clx;
  const cps: number[] = [];
  for (let i = 0; i <= n; i++) cps.push(word.readUInt32LE(plcStart + i * 4));
  const pcdBase = plcStart + (n + 1) * 4;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const lenCp = cps[i + 1] - cps[i];
    if (lenCp <= 0) continue;
    const pcdOff = pcdBase + i * 8;
    const fc = word.readUInt32LE(pcdOff);
    const fCompressed = (fc & 0x40000000) !== 0;
    const offset = fc & 0x3fffffff;
    let piece: string;
    if (fCompressed) {
      const raw = word.subarray(offset, offset + lenCp);
      piece = raw.toString('latin1'); // ASCII subset; CJK lives in UTF-16 pieces
    } else {
      const raw = word.subarray(offset, offset + lenCp * 2);
      piece = raw.toString('utf16le');
    }
    parts.push(piece);
  }
  let text = parts.join('');
  // Map CP control characters: paragraph (0x0D) → newline, tab (0x09) → tab, drop the rest.
  text = text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\u0009/g, '\t').replace(/\r/g, '\n');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * Extract plain text from a legacy Office (OLE2) buffer.
 * For Word documents, use the piece table; otherwise fall back to generic
 * UTF-16LE run scanning across all streams.
 */
export function extractOle2Text(buffer: Buffer): string {
  const streams = parseCfb(buffer);
  if (streams.length === 0) return '';

  // Word 97-2003: clean text from the piece table.
  const word = streams.find((s) => /^WordDocument$/i.test(s.name));
  if (word) {
    const wt = extractWordText(word.data);
    if (wt && wt.length >= 50) {
      const merged = wt.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (merged) return merged;
    }
  }

  // Fallback: generic UTF-16LE run extraction (.xls / .ppt / .doc fallback).
  const parts: string[] = [];
  for (const s of streams) {
    const t = extractTextFromBuffer(s.data);
    if (t) parts.push(t);
  }
  const merged = parts.join('\n\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return merged;
}
