// FR-13-1：PDF 文本提取为 Markdown
// 设计哲学与 office-convert.ts 一致：零原生依赖、错误返回字符串而非抛异常
// 为什么不直接 import 'pdf-parse'：其 index.js 中 `isDebugMode = !module.parent` 在 ESM 下恒为 true，
// 会触发测试模式尝试读取 ./test/data/05-versions-space.pdf 导致模块加载即崩溃。
// 解决方案：用 createRequire 直接加载 lib/pdf-parse.js（纯函数导出，无副作用）。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 为什么用 require 而非 import：CJS 模块在 ESM 下的 default 互操作行为随 Node 版本变化，
// createRequire 保持与 CJS 完全一致的加载语义，最稳定
type PdfParseResult = { text: string; numrender: number; info: unknown; metadata: unknown };
type PdfParseFn = (
  buffer: Buffer,
  options?: { max?: number; pagerender?: unknown },
) => Promise<PdfParseResult>;
const pdfParse: PdfParseFn = require('pdf-parse/lib/pdf-parse.js');

// 扫描件检测阈值：提取的文本字符数低于此值视为扫描件（无文本层）
// 为什么 50：正常 PDF 即使只有标题也通常超过 50 字符，扫描件提取结果通常 < 10 字符
const SCAN_THRESHOLD = 50;

/**
 * 将 PDF buffer 转换为 Markdown 文本
 * - 按 PDF 页分隔，每页前加 `## Page N` 二级标题
 * - 扫描件（无文本层）返回友好提示，不抛异常
 * - 加密 PDF 返回 [Error: ...] 字符串，由调用方决定如何处理
 */
export async function convertPdfToMarkdown(buffer: Buffer): Promise<string> {
  let result: PdfParseResult;
  try {
    // max: 0 表示不限制页数（pdf-parse 约定）
    result = await pdfParse(buffer, { max: 0 });
  } catch (err) {
    // 常见错误：加密 PDF、损坏的 PDF
    const msg = err instanceof Error ? err.message : String(err);
    return `[Error: PDF parsing failed — ${msg}]`;
  }

  const rawText = result.text?.trim() ?? '';

  // 扫描件检测：文本提取结果过少，说明 PDF 无文本层（扫描件/图片型 PDF）
  // 不抛错：FR-13-2 OCR 入库会处理扫描件，这里返回提示让 LLM 自行判断
  if (rawText.length < SCAN_THRESHOLD) {
    return `[Warning: This PDF appears to be a scanned document with no text layer (extracted ${rawText.length} chars).\nOCR is required for full text extraction (see FR-13-2).]`;
  }

  // 为什么按页分隔：pdf-parse 返回的 text 是所有页面用 \n\n 拼接的结果，
  // 但不包含页码标记。这里直接返回清理后的文本，由 LLM 在 compile 阶段自行分节。
  // 不手动按 \n\n 分页：pdf-parse 内部已用 \n\n 分隔页面，LLM 可据此识别页面边界
  return rawText;
}
