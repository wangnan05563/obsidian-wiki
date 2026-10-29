import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// 投递原始文档留存（T03611）：用户通过 /api/compile 或 /api/compile/batch 上传的
// 原始二进制（PDF/Word/图片等）在投递时留一份到 data/uploads/，供本人后续下载追溯。
// 为什么独立于 vault：vault 只存编译后的 Markdown 页面/raw 存档，二进制原件进 vault 会
//   被目录树/页面列表/清理策略当作知识资产处理；uploads 是纯运行时附件，与 conversations 同级。
// 存储布局（一个投递一个目录，互不覆盖）：
//   data/uploads/<uuid>/blob      原始字节
//   data/uploads/<uuid>/meta.json 元数据（见 UploadRecord）
// 为什么用 uuid 目录 + 固定 blob 文件名：上传名可能是 meta.json、含中文/全角字符，
//   直接当文件名既可能冲突也扩大路径穿越面；展示名只存在 meta 里，落盘名恒定。

export const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const META_FILE = 'meta.json';
const BLOB_FILE = 'blob';

// 常见投递格式 → Content-Type。仅用于上传未带可靠 MIME 或下载时缺省兜底。
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
};

export interface UploadRecord {
  id: string;
  /** 展示/下载用文件名（剥目录 + 去控制字符，保留中文/全角括号/空格） */
  originalName: string;
  size: number;
  sha256: string;
  mimeType: string;
  /** ISO 时间串 */
  uploadedAt: string;
  /** auth 启用时为用户 id；单租户（auth 关闭）为 null */
  ownerId: string | null;
  ownerName: string | null;
  /** file = 单文件投递；batch = 文件夹批量投递中的一个文件 */
  source: 'file' | 'batch';
}

export interface SaveUploadInput {
  name: string;
  buffer: Buffer;
  mimeType?: string;
  ownerId: string | null;
  ownerName: string | null;
  source: 'file' | 'batch';
}

// 展示/下载名清洗：只剥目录与不可见控制字符，保留中文、全角括号与空格——
// 用户的原始文件名是「原始文档」的一部分，下载时应尽量还原。
// 落盘名恒定是 blob（见目录布局），因此这里不需要文件系统白名单；header 注入由
// utils/attachment.ts 的 buildAttachmentHeader 统一处理。
export function sanitizeDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim(); // NOSONAR - S6324 - 故意匹配控制字符用于文件名净化
  const clipped = cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
  return clipped && clipped !== '.' && clipped !== '..' ? clipped : 'unnamed';
}

export function resolveMimeType(name: string, provided?: string): string {
  // 浏览器对未知类型常报 application/octet-stream，此时按扩展名兜底。
  if (provided && provided !== 'application/octet-stream') return provided;
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export class UploadStore {
  constructor(private readonly rootDir: string) {
    fsSync.mkdirSync(rootDir, { recursive: true });
  }

  /** 保存一份原始文档；写 meta 失败时清理半成品目录，避免列表出现无元数据的空壳。 */
  async save(input: SaveUploadInput): Promise<UploadRecord> {
    const id = crypto.randomUUID();
    const dir = path.join(this.rootDir, id);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(path.join(dir, BLOB_FILE), input.buffer);
      const record: UploadRecord = {
        id,
        originalName: sanitizeDisplayName(input.name),
        size: input.buffer.length,
        sha256: crypto.createHash('sha256').update(input.buffer).digest('hex'),
        mimeType: resolveMimeType(input.name, input.mimeType),
        uploadedAt: new Date().toISOString(),
        ownerId: input.ownerId,
        ownerName: input.ownerName,
        source: input.source,
      };
      await fs.writeFile(path.join(dir, META_FILE), JSON.stringify(record, null, 2), 'utf8');
      return record;
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async get(id: string): Promise<UploadRecord | null> {
    if (!UPLOAD_ID_RE.test(id)) return null;
    return this.readMeta(id);
  }

  blobPath(id: string): string {
    return path.join(this.rootDir, id, BLOB_FILE);
  }

  // ownerId 为 null 表示不隔离（单租户）；auth 启用时调用方传当前用户 id。
  async list(ownerId: string | null, limit: number): Promise<UploadRecord[]> {
    let entries;
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = entries.filter((e) => e.isDirectory() && UPLOAD_ID_RE.test(e.name)).map((e) => e.name);
    const records = await Promise.all(ids.map((id) => this.readMeta(id)));
    return records
      .filter((r): r is UploadRecord => r !== null)
      .filter((r) => ownerId === null || r.ownerId === ownerId)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
      .slice(0, limit);
  }

  private async readMeta(id: string): Promise<UploadRecord | null> {
    try {
      const raw = await fs.readFile(path.join(this.rootDir, id, META_FILE), 'utf8');
      return JSON.parse(raw) as UploadRecord;
    } catch {
      // 目录缺 meta（写入中断/手工删除）按不存在处理，不让单个坏条目拖垮列表
      return null;
    }
  }
}
