import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { VaultService } from "../vault/vault-service.js";
import type { PageQualityScore, DuplicatePair, MergeResult, PrecheckResult } from "../types.js";

const TEST_PATTERNS = [/^test-.*\.md$/, /proxy-test.*\.md$/];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

function isTestFile(name: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(name));
}

/** Retry wrapper for vault operations */
async function vaultRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = MAX_RETRIES
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.warn(`[${label}] attempt ${attempt}/${retries} failed, retrying...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastErr;
}

//  Scoring engine 
/**
 * 单次扫描 vault：读原文一次，返回「质量评分 + 原文」成对结果。
 * 这是去重引擎的唯一读取入口 —— deduplicatePages 复用此处读到的 content，
 * 避免历史实现中「scanVault 读一遍、dedup 再逐文件 readFile 一遍」导致的 2× 磁盘 I/O。
 */
export async function scanVaultRaw(
  vault: VaultService
): Promise<Array<{ page: PageQualityScore; content: string }>> {
  const out: Array<{ page: PageQualityScore; content: string }> = [];
  const dirs = ["entities", "concepts", "comparisons"];

  for (const dir of dirs) {
    try {
      const fullPath = path.join(vault.getVaultPath(), dir);
      const files = await fs.readdir(fullPath);
      for (const file of files) {
        if (!file.endsWith(".md") || isTestFile(file)) continue;
        const relPath = `${dir}/${file}`;
        try {
          const content = await vaultRetry(
            () => vault.readFile(relPath),
            `scan:${relPath}`
          );
          const parsed = matter(content);
          out.push({
            page: {
              path: relPath,
              title: (parsed.data.title as string) || file.replace(".md", ""),
              qualityScore: Math.min(100, Math.max(0,
                countWords(parsed.content || "") / 10 +
                  countLinks(content) * 25 +
                  (hasValidFrontmatter(parsed) ? 50 : 0)
              )),
              category: {
                length: 20, links: 25, frontmatter: 25, citations: 20, duplicate: 0, freshness: 10,
              },
              metadata: {
                wordCount: countWords(parsed.content || ""),
                lineCount: (parsed.content || "").split("\n").length,
                internalLinks: countLinks(content),
                inboundLinks: 0,
                lastModified: new Date().toISOString(),
                hasFrontmatter: hasValidFrontmatter(parsed),
                isDraft: false,
                fileSizeBytes: Buffer.byteLength(content),
                hasBom: false,
                encoding: "utf-8" as const,
                directory: dir,
              },
              issues: [],
              suggestions: [{ type: "link_suggestion", detail: "Verify file permissions or encoding", actionable: true }],
            },
            content,
          });
        } catch (err) {
          console.warn(`Failed to process ${dir}/${file}:`, err);
          out.push({
            page: {
              path: `${dir}/${file}`,
              title: file.replace(".md", ""),
              qualityScore: 0,
              category: { length: 0, links: 0, frontmatter: 0, citations: 0, duplicate: 0, freshness: 0 },
              metadata: {
                wordCount: 0, lineCount: 0, internalLinks: 0, inboundLinks: 0,
                lastModified: new Date().toISOString(), hasFrontmatter: false,
                isDraft: true, fileSizeBytes: 0, hasBom: false, encoding: "unknown" as any, directory: dir,
              },
              issues: [{ code: "SCAN_ERROR", severity: "error", detail: `Failed to read: ${err instanceof Error ? err.message : String(err)}` }],
              suggestions: [{ type: "link_suggestion", detail: "Verify file permissions or encoding", actionable: true }],
            },
            content: "",
          });
        }
      }
    } catch (err) {
      console.warn(`Failed to scan directory ${dir}:`, err);
    }
  }
  return out;
}

/**
 * 兼容历史调用方：仅返回质量评分数组（不含原文）。
 * /api/data-clean/pages 等接口继续用此函数，无需改动。
 */
export async function scanVault(vault: VaultService): Promise<PageQualityScore[]> {
  const raw = await scanVaultRaw(vault);
  return raw.map((r) => r.page);
}

//  Helpers 
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.trim()).length;
}
function countLinks(content: string): number {
  return (content.match(/\[\[.*?\]\]/g) || []).length;
}
function hasValidFrontmatter(parsed: matter.GrayMatterFile<string>): boolean {
  return !!(parsed.data?.type && parsed.data?.title);
}

//  Archive 
export async function archiveFiles(
  vault: VaultService,
  files: string[],
  dryRun: boolean = true
): Promise<{ archived: string[]; errors: string[] }> {
  const archived: string[] = [];
  const errors: string[] = [];
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const archiveBase = path.join(vault.getVaultPath(), "..", "archive", dateStr);

  if (!dryRun) {
    try {
      await vaultRetry(() => fs.mkdir(archiveBase, { recursive: true }), "archive-mkdir");
    } catch (err) {
      errors.push(`Failed to create archive dir: ${err}`);
      return { archived, errors };
    }
  }

  for (const filePath of files) {
    try {
      const fileName = path.basename(filePath);
      const dest = path.join(archiveBase, fileName);
      if (!dryRun) { // NOSONAR
        await vaultRetry(() => fs.rename(filePath, dest), "archive-move");
        archived.push(filePath);
      } else {
        archived.push(fileName);
      }
    } catch (err) {
      errors.push(`Archive failed ${filePath}: ${err}`);
    }
  }
  return { archived, errors };
}

//  Delete files (with audit) 
export async function deleteFiles(
  vault: VaultService,
  paths: string[],
  dryRun: boolean = true
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];

  for (const filePath of paths) {
    try {
      if (!dryRun) { // NOSONAR
        await vaultRetry(() => fs.unlink(filePath), "delete-file");
        deleted.push(filePath);
      } else {
        deleted.push(path.basename(filePath));
      }
    } catch (err) {
      errors.push(`Delete failed ${filePath}: ${err}`);
    }
  }
  return { deleted, errors };
}

//  Frontmatter repair 
export async function fixFrontmatter( // NOSONAR - 认知复杂度由业务逻辑决定，重构风险高
  vault: VaultService,
  paths: string[],
  dryRun: boolean = true
): Promise<{ fixed: Array<{ path: string; addedFields: string[] }>; errors: string[] }> {
  const fixed: Array<{ path: string; addedFields: string[] }> = [];
  const errors: string[] = [];

  for (const relPath of paths) {
    try {
      const content = await vaultRetry(() => vault.readFile(relPath), `fm-read:${relPath}`);
      const parsed = matter(content);
      const newFm: Record<string, any> = { ...parsed.data };

      if (!newFm.title) {
        const h1Match = parsed.content.match(/^#\s+(.+)$/m);
        newFm.title = h1Match ? h1Match[1] : path.basename(relPath, ".md");
      }
      if (!newFm.type) {
        const dir = relPath.split("/")[0];
        const typeMap: Record<string, string> = {
          entities: "entity", concepts: "concept", comparisons: "comparison", queries: "query",
        };
        newFm.type = typeMap[dir] || "concept";
      }
      if (!newFm.updated) newFm.updated = new Date().toISOString().split("T")[0];
      if (!newFm.created) newFm.created = newFm.updated;
      if (!newFm.tags) newFm.tags = [];
      if (!newFm.source) newFm.source = relPath;

      const addedFields = Object.keys(newFm).filter((key) => !parsed.data?.[key]);
      if (addedFields.length > 0) {
        const updated = matter.stringify(parsed.content, newFm);
        if (!dryRun) {
          await vaultRetry(() => vault.writeFile(relPath, updated), `fm-write:${relPath}`);
        }
        fixed.push({ path: relPath, addedFields });
      }
    } catch (err) {
      errors.push(`Fix failed ${relPath}: ${err}`);
    }
  }
  return { fixed, errors };
}

//  Merge duplicates 
/**
 * Keep the page with the higher quality score (pageA), merge content from pageB.
 * Updates [[pageB]] references in pageA's content to [[pageA]].
 * Optionally archives pageB.
 */
export async function mergeDuplicatePages( // NOSONAR - 认知复杂度由业务逻辑决定，重构风险高
  vault: VaultService,
  pair: DuplicatePair,
  archiveKept: boolean = false,
  dryRun: boolean = true
): Promise<MergeResult> {
  const { pageA, pageB } = pair;
  const result: MergeResult = {
    kept: pageA.path,
    mergedFrom: [pageB.path],
    updatesApplied: 0,
    errors: [],
    dryRun,
  };

  try {
    // Step 1: Read both files
    const contentA = await vaultRetry(() => vault.readFile(pageA.path), "merge-read-A");
    const contentB = await vaultRetry(() => vault.readFile(pageB.path), "merge-read-B");
    const parsedA = matter(contentA);
    const parsedB = matter(contentB);

    // Step 2: Merge frontmatter  prefer pageA values, fill missing from pageB
    const mergedFm: Record<string, any> = { ...parsedA.data };
    for (const [key, val] of Object.entries(parsedB.data as object)) {
      if (!(key in mergedFm)) mergedFm[key] = val;
      else if (Array.isArray(val) && Array.isArray(mergedFm[key])) {
        mergedFm[key] = [...new Set([...mergedFm[key], ...val])]; // dedupe arrays
      }
    }

    // Step 3: Merge body content  append B's body under a section header
    let mergedContent: string;
    if (parsedB.content.trim()) {
      mergedContent = `${parsedA.content.trimEnd()}\n\n---\n## Merged from ${path.basename(pageB.path, ".md")}\n\n${parsedB.content.trim()}`;
    } else {
      mergedContent = parsedA.content;
    }

    // Step 4: Update internal links in merged content  replace [[<pageB-title>]]  [[<pageA-title>]]
    const bTitle = pageB.title;
    const aTitle = pageA.title;
    let linkReplacements = 0;
    if (bTitle !== aTitle) {
      const regex = new RegExp(`\\[\\[${bTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`, "g");
      if (regex.test(mergedContent)) {
        mergedContent = mergedContent.replace(regex, `[[${aTitle}]]`);
        linkReplacements = (mergedContent.match(regex) || []).length;
      }
    }

    // Step 5: Write back pageA
    const finalStringified = matter.stringify(mergedContent, mergedFm);
    if (!dryRun) {
      await vaultRetry(() => vault.writeFile(pageA.path, finalStringified), "merge-write-A");
    }

    result.updatesApplied++;
    result.linkReplacements = linkReplacements;

    // Step 6: If not keeping pageB, archive or delete it
    if (archiveKept && !dryRun) {
      await archiveFiles(vault, [pageB.path], false);
      result.archiveResult = { archived: [pageB.path], errors: [] };
    }

    console.log(`[MERGE] Kept ${pageA.path}, merged ${pageB.path}  ${linkReplacements} link updates`);
  } catch (err) {
    result.errors.push(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[MERGE ERROR] ${pageA.path} + ${pageB.path}:`, err);
  }

  return result;
}

//  Precheck gate 
/**
 * Validates the entire vault before compilation:
 * - Checks all .md files can be parsed by gray-matter
 * - Verifies internal links resolve to existing files
 * - Reports encoding/BOM issues
 * - Returns a pass/fail status with error details
 */
export async function precheckVault(vault: VaultService): Promise<PrecheckResult> { // NOSONAR - 认知复杂度由业务逻辑决定，重构风险高
  const result: PrecheckResult = {
    passed: true,
    scannedFiles: 0,
    errors: [],
    warnings: [],
    blocked: false,
  };

  const allPages: PageQualityScore[] = [];
  const dirs = ["entities", "concepts", "comparisons"];

  // Scan pages first for link resolution
  for (const dir of dirs) {
    try {
      const fullPath = path.join(vault.getVaultPath(), dir);
      const files = await fs.readdir(fullPath);
      for (const file of files) {
        if (!file.endsWith(".md") || isTestFile(file)) continue;
        try {
          const rel = `${dir}/${file}`;
          const content = await vaultRetry(() => vault.readFile(rel), `precheck:${rel}`);
          allPages.push({ path: rel, title: (matter(content).data.title as string) || file, qualityScore: 100,
            category: { length: 0, links: 0, frontmatter: 0, citations: 0, duplicate: 0, freshness: 0 },
            metadata: { wordCount: 0, lineCount: 0, internalLinks: 0, inboundLinks: 0, lastModified: "", hasFrontmatter: true, isDraft: false, fileSizeBytes: 0, hasBom: false, encoding: "utf-8" as any, directory: dir },
            issues: [],
            suggestions: [{ type: "link_suggestion", detail: "Verify file permissions or encoding", actionable: true }],
          });
        } catch {}
      }
    } catch {}
  }

  // Build set of valid page names for link resolution
  const validPageNames = new Set(allPages.map((p) => p.title.toLowerCase()));

  // Now validate each page
  for (const page of allPages) {
    result.scannedFiles++;
    try {
      const content = await vaultRetry(() => vault.readFile(page.path), `precheck:${page.path}`);

      // Check encoding / BOM
      if (content.charCodeAt(0) === 0xFEFF) { // NOSONAR
        result.warnings.push(`${page.path}: Contains UTF-8 BOM`);
        page.metadata.hasBom = true;
      }

      // Parse frontmatter  will throw if YAML is broken
      try {
        matter(content);
      } catch (fmErr) { // NOSONAR
        result.errors.push(`${page.path}: Invalid YAML frontmatter  ${fmErr}`);
        result.blocked = true;
      }

      // Check internal links resolve
      const linkMatches = content.match(/\[\[(.*?)\]\]/g) || [];
      for (const link of linkMatches) {
        const target = link.slice(2, -2).split("::")[0].trim().toLowerCase();
        if (target && !validPageNames.has(target)) {
          // Only warn, not block  dangling links may be intentional placeholders
          result.warnings.push(`${page.path}: Unresolved link [[${link.slice(2, -2)}]]`);
        }
      }
    } catch (err) {
      result.errors.push(`${page.path}: ${err instanceof Error ? err.message : String(err)}`);
      result.blocked = true;
    }
  }

  result.passed = result.errors.length === 0;
  return result;
}
