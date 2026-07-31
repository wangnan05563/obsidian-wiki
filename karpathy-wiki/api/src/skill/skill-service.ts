import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import matter from 'gray-matter';
import type { SkillMeta, SkillDetail, SkillImportResult } from '../types.js';
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
// 为什么移除 fileURLToPath + import.meta.url：SEA 模式下 __filename 指向构建时 bundle.cjs，
// 用户机器不存在，派生的 SKILL_SRC_DIR 不可用，导致技能存储路径解析失败
import { getDataDir } from '../utils/runtime.js';

// 技能存储根目录：karpathy-wiki/data/skills/（开发模式）或 exe/data/skills/（SEA 模式）
// 为什么用 getDataDir：runtime.ts 统一解析 data 目录，与 CWD 解耦
const SKILLS_ROOT = path.resolve(getDataDir(), 'skills');

// 技能 ID 白名单正则：仅允许小写字母、数字、连字符、下划线
// 为什么需要：防止路径穿越攻击（如 "../etc/passwd" 作为 skillId），CODING-005 输入白名单
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

// 允许的文件扩展名（ZIP 归档主格式 + Markdown 辅格式）
// 为什么双格式：.skill 是约定俗成的 ZIP 归档扩展名，.md 支持单文件技能快速导入
const ALLOWED_EXTENSIONS = new Set(['.skill', '.md']);

// 单文件大小上限：10MB（与 multipart fileSize 联动）
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// ZIP 内允许的文件扩展名白名单（防止恶意可执行文件注入）
// 为什么需要白名单：ZIP 可包含任意文件，需限制为技能资源常见类型
const ALLOWED_ZIP_FILE_EXTENSIONS = new Set([
  '.md', '.json', '.yaml', '.yml', '.txt', '.html', '.css',
  '.js', '.ts', '.py', '.sh', '.bat', '.ps1',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
]);

// SKILL.md 文件名候选（大小写兼容）
const SKILL_MD_CANDIDATES = ['SKILL.md', 'skill.md', 'Skill.md'];

// 确保技能存储根目录存在
async function ensureSkillsRoot(): Promise<void> {
  await fs.mkdir(SKILLS_ROOT, { recursive: true });
}

// 从上传文件名派生技能 ID（白名单清洗）
// 为什么不用原始文件名直接作目录名：文件名可能含中文/空格/特殊字符，导致路径解析问题
// 清洗策略：取主名（去扩展名）→ 转小写 → 替换非法字符为连字符 → 校验白名单
function deriveSkillId(filename: string): string {
  const basename = path.basename(filename).replace(/\.(skill|md)$/i, '');
  // 转小写 + 替换非白名单字符为连字符
  const cleaned = basename
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 校验是否符合 ID 白名单（首字符必须是字母或数字）
  if (!SKILL_ID_PATTERN.test(cleaned)) {
    // 清洗后仍不合法时用时间戳兜底，避免导入失败
    return `skill-${Date.now()}`;
  }
  return cleaned;
}

// 防止路径穿越：校验解压后的文件路径不逃离目标目录
// 为什么需要：ZIP 文件可包含 "../../../etc/passwd" 等恶意路径，解压时会写入目标目录之外
function isPathSafe(targetDir: string, filePath: string): boolean {
  const resolved = path.resolve(targetDir, filePath);
  const normalized = path.normalize(resolved);
  const targetNormalized = path.normalize(targetDir);
  // 解析后的路径必须以目标目录为前缀（防止 ../ 逃逸）
  return normalized === targetNormalized || normalized.startsWith(targetNormalized + path.sep);
}

// 校验 ZIP 内文件扩展名是否在白名单内
function isZipFileExtensionAllowed(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  // 无扩展名的文件（如 README）允许通过
  if (!ext) return true;
  return ALLOWED_ZIP_FILE_EXTENSIONS.has(ext);
}

// 从 SKILL.md 内容解析技能名称和描述
// 优先级：frontmatter.name/description > 首个标题 > 文件名
function parseSkillMetadata(content: string, fallbackName: string): { name: string; description: string; entryFile: string } {
  let name = fallbackName;
  let description = '';

  try {
    const parsed = matter(content);
    if (parsed.data.name && typeof parsed.data.name === 'string') {
      name = parsed.data.name;
    }
    if (parsed.data.description && typeof parsed.data.description === 'string') {
      description = parsed.data.description;
    }
    // frontmatter 无 description 时从正文首段提取（去除空行和标题）
    if (!description) {
      const body = parsed.content.trim();
      const lines = body.split('\n');
      // 跳过标题行（# 开头）和空行，取第一个内容段
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
          description = trimmed.slice(0, 200);
          break;
        }
      }
    }
  } catch {
    // gray-matter 解析失败时用纯文本提取首段
    const lines = content.trim().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        description = trimmed.slice(0, 200);
        break;
      }
    }
  }

  return { name, description, entryFile: 'SKILL.md' };
}

// 计算目录占用字节数（递归遍历所有文件）
async function calculateDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await calculateDirSize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        totalSize += stat.size;
      }
    }
  } catch {
    // 目录不存在或读取失败时返回 0
  }
  return totalSize;
}

// 递归列出目录下所有文件的相对路径（相对于 dirPath）
async function listFilesRecursive(dirPath: string, basePath: string = ''): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;
      if (entry.isDirectory()) {
        const subFiles = await listFilesRecursive(path.join(dirPath, entry.name), relativePath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch {
    // 目录不存在或读取失败时返回空列表
  }
  return files;
}

// 导入 ZIP 格式技能（.skill 文件）
// 解压策略：
//   1. 校验 ZIP 内所有文件路径安全（无路径穿越）+ 扩展名白名单
//   2. 查找 SKILL.md 入口文件（大小写兼容）
//   3. 解压到 data/skills/{skillId}/
//   4. 解析 SKILL.md 提取元数据
async function importZipSkill(
  fileBuffer: Buffer,
  skillId: string,
  fallbackName: string,
): Promise<{ meta: SkillMeta; warnings: string[] }> {
  const warnings: string[] = [];
  const targetDir = path.resolve(SKILLS_ROOT, skillId);

  // 清理已存在的同名技能目录（覆盖导入）
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  let zip: AdmZip;
  try {
    zip = new AdmZip(fileBuffer);
  } catch {
    throw new Error('ZIP 文件解析失败，请检查文件是否损坏');
  }

  const entries = zip.getEntries();
  let skillMdEntry: AdmZip.IZipEntry | null = null;

  // 第一遍：校验所有条目路径安全 + 扩展名白名单
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // 路径穿越校验
    if (!isPathSafe(targetDir, entry.entryName)) {
      throw new Error(`安全校验失败：ZIP 内文件 "${entry.entryName}" 路径非法（疑似路径穿越攻击）`);
    }

    // 扩展名白名单校验
    if (!isZipFileExtensionAllowed(entry.entryName)) {
      warnings.push(`跳过非法扩展名文件：${entry.entryName}`);
      continue;
    }

    // 查找 SKILL.md 入口文件（大小写兼容）
    if (SKILL_MD_CANDIDATES.includes(entry.entryName) || SKILL_MD_CANDIDATES.includes(path.basename(entry.entryName))) {
      if (!skillMdEntry) {
        skillMdEntry = entry;
      }
    }
  }

  if (!skillMdEntry) {
    // 清理空目录后抛错
    await fs.rm(targetDir, { recursive: true, force: true });
    throw new Error('ZIP 内未找到 SKILL.md 入口文件（支持 SKILL.md / skill.md / Skill.md）');
  }

  // 第二遍：解压合法文件到目标目录
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isZipFileExtensionAllowed(entry.entryName)) continue;
    if (!isPathSafe(targetDir, entry.entryName)) continue;

    const targetPath = path.resolve(targetDir, entry.entryName);
    // 确保父目录存在
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    // 解压文件内容（getData 返回 Buffer）
    await fs.writeFile(targetPath, entry.getData());
  }

  // 解析 SKILL.md 提取元数据
  const skillMdPath = path.resolve(targetDir, skillMdEntry.entryName);
  const skillMdContent = await fs.readFile(skillMdPath, 'utf8');
  const { name, description, entryFile } = parseSkillMetadata(skillMdContent, fallbackName);

  const size = await calculateDirSize(targetDir);
  const meta: SkillMeta = {
    id: skillId,
    name,
    description,
    format: 'zip',
    importedAt: new Date().toISOString(),
    size,
    entryFile,
  };

  return { meta, warnings };
}

// 导入 Markdown 格式技能（.md 单文件）
// 策略：将 .md 文件重命名为 SKILL.md 并放入 data/skills/{skillId}/
async function importMarkdownSkill(
  fileBuffer: Buffer,
  skillId: string,
  fallbackName: string,
): Promise<{ meta: SkillMeta; warnings: string[] }> {
  const warnings: string[] = [];
  const targetDir = path.resolve(SKILLS_ROOT, skillId);

  // 清理已存在的同名技能目录（覆盖导入）
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  const content = fileBuffer.toString('utf8');
  const { name, description, entryFile } = parseSkillMetadata(content, fallbackName);

  // 写入 SKILL.md
  const skillMdPath = path.resolve(targetDir, entryFile);
  await fs.writeFile(skillMdPath, content, 'utf8');

  const size = await calculateDirSize(targetDir);
  const meta: SkillMeta = {
    id: skillId,
    name,
    description,
    format: 'md',
    importedAt: new Date().toISOString(),
    size,
    entryFile,
  };

  return { meta, warnings };
}

// 技能导入入口：根据文件扩展名分发到 ZIP 或 Markdown 导入流程
// 返回 SkillImportResult，含技能元数据和警告列表
export async function importSkill(
  fileBuffer: Buffer,
  originalFilename: string,
): Promise<SkillImportResult> {
  await ensureSkillsRoot();

  // 校验文件大小
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`文件大小超过限制（最大 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB）`);
  }

  // 校验文件扩展名
  const ext = path.extname(originalFilename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`不支持的文件扩展名 "${ext}"，仅支持 .skill（ZIP 归档）或 .md（纯 Markdown）`);
  }

  const skillId = deriveSkillId(originalFilename);
  // 处理同名技能冲突：若 skillId 已存在，追加数字后缀
  let finalSkillId = skillId;
  let suffix = 1;
  while (fsSync.existsSync(path.resolve(SKILLS_ROOT, finalSkillId))) {
    finalSkillId = `${skillId}-${suffix++}`;
  }

  const fallbackName = path.basename(originalFilename).replace(/\.(skill|md)$/i, '');

  let result: { meta: SkillMeta; warnings: string[] };
  if (ext === '.skill') {
    result = await importZipSkill(fileBuffer, finalSkillId, fallbackName);
  } else {
    result = await importMarkdownSkill(fileBuffer, finalSkillId, fallbackName);
  }

  return {
    ok: true,
    skill: result.meta,
    warnings: result.warnings,
  };
}

// 列出所有已导入技能的元数据
// 为什么不用缓存：技能导入是低频操作，每次扫描目录开销可接受，避免缓存失效问题
export async function listSkills(): Promise<SkillMeta[]> {
  await ensureSkillsRoot();
  const skills: SkillMeta[] = [];

  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillId = entry.name;
    // 校验目录名是否符合 ID 白名单（跳过非法目录，如临时目录）
    if (!SKILL_ID_PATTERN.test(skillId)) continue;

    const skillDir = path.resolve(SKILLS_ROOT, skillId);
    try {
      // 查找入口文件
      let entryFile = '';
      for (const candidate of SKILL_MD_CANDIDATES) {
        if (fsSync.existsSync(path.resolve(skillDir, candidate))) {
          entryFile = candidate;
          break;
        }
      }
      if (!entryFile) continue;

      const content = await fs.readFile(path.resolve(skillDir, entryFile), 'utf8');
      const { name, description } = parseSkillMetadata(content, skillId);
      const stat = await fs.stat(skillDir);
      const size = await calculateDirSize(skillDir);

      // 推断格式：目录下只有 SKILL.md 一个文件视为 md 格式，否则 zip
      const allFiles = await listFilesRecursive(skillDir);
      const format: 'zip' | 'md' = allFiles.length <= 1 ? 'md' : 'zip';

      skills.push({
        id: skillId,
        name,
        description,
        format,
        importedAt: stat.mtime.toISOString(),
        size,
        entryFile,
      });
    } catch {
      // 单个技能读取失败时跳过，不阻断列表
    }
  }

  return skills;
}

// 获取技能详情（含全文内容和文件列表）
export async function getSkillDetail(skillId: string): Promise<SkillDetail | null> {
  // 路径穿越防护：校验 skillId 符合白名单
  if (!SKILL_ID_PATTERN.test(skillId)) {
    return null;
  }

  const skillDir = path.resolve(SKILLS_ROOT, skillId);
  if (!fsSync.existsSync(skillDir)) {
    return null;
  }

  // 查找入口文件
  let entryFile = '';
  for (const candidate of SKILL_MD_CANDIDATES) {
    if (fsSync.existsSync(path.resolve(skillDir, candidate))) {
      entryFile = candidate;
      break;
    }
  }
  if (!entryFile) {
    return null;
  }

  const content = await fs.readFile(path.resolve(skillDir, entryFile), 'utf8');
  const { name, description } = parseSkillMetadata(content, skillId);
  const stat = await fs.stat(skillDir);
  const size = await calculateDirSize(skillDir);
  const files = await listFilesRecursive(skillDir);

  // 推断格式
  const format: 'zip' | 'md' = files.length <= 1 ? 'md' : 'zip';

  return {
    id: skillId,
    name,
    description,
    format,
    importedAt: stat.mtime.toISOString(),
    size,
    entryFile,
    content,
    files,
  };
}

// 删除技能
// 为什么需要：用户导入错误的技能后可删除重新导入
export async function deleteSkill(skillId: string): Promise<boolean> {
  // 路径穿越防护：校验 skillId 符合白名单
  if (!SKILL_ID_PATTERN.test(skillId)) {
    return false;
  }

  const skillDir = path.resolve(SKILLS_ROOT, skillId);
  if (!fsSync.existsSync(skillDir)) {
    return false;
  }

  // Windows 上 fs.rm/rmSync 偶发不删除目录但不抛异常（文件句柄占用），
  // 使用 child_process 执行 rd 命令（Windows 原生删除），确保可靠删除
  // 为什么用 execFileSync 而非 execSync：避免字符串拼接命令注入风险（BR-051-2）
  const { execFileSync } = await import('node:child_process');
  try {
    // /s 递归删除子目录，/q 静默模式，路径作为独立参数传递
    execFileSync('rd', ['/s', '/q', skillDir], { stdio: 'pipe' });
  } catch (e) {
    console.error('[skill] rd command failed:', e instanceof Error ? e.message : String(e));
    // rd 失败时回退到 rmSync 重试
    try {
      fsSync.rmSync(skillDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      fsSync.rmSync(skillDir, { recursive: true, force: true });
    }
  }
  return !fsSync.existsSync(skillDir);
}
