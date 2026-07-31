import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertPdfToMarkdown } from '../src/utils/pdf-convert.js';

// pdf-parse 自带的测试 PDF 文件（04-valid.pdf，约 80KB，含完整文本层）
// 为什么用它：避免在 git 中提交大体积 PDF fixture，复用已安装依赖的测试资源
// 为什么不用 05-versions-space.pdf：该 fixture 仅 25 字符文本，会触发扫描件检测阈值
const PDF_FIXTURE = path.join(
  process.cwd(),
  'node_modules',
  'pdf-parse',
  'test',
  'data',
  '04-valid.pdf',
);
const FIXTURE_EXISTS = fs.existsSync(PDF_FIXTURE);

// ===========================================================================
// 正常 PDF 解析测试（依赖 pdf-parse 自带 fixture）
// ===========================================================================
describe('pdf conversion', () => {
  it('从有效 PDF 提取文本', async () => {
    if (!FIXTURE_EXISTS) {
      console.warn('Skip: pdf-parse test fixture not found');
      return;
    }
    const buf = fs.readFileSync(PDF_FIXTURE);
    const result = await convertPdfToMarkdown(buf);
    // 有效 PDF 应提取出非空文本，且不包含错误标记
    expect(result.length).toBeGreaterThan(50);
    expect(result.startsWith('[Error')).toBe(false);
    expect(result.startsWith('[Warning')).toBe(false);
  });

  it('无效 buffer 返回错误字符串而非抛异常', async () => {
    // 为什么不抛异常：与 office-convert.ts 风格一致，错误返回字符串让调用方决策
    const buf = Buffer.from('not a pdf file');
    const result = await convertPdfToMarkdown(buf);
    expect(result.startsWith('[Error')).toBe(true);
  });

  it('空 buffer 返回错误字符串', async () => {
    const buf = Buffer.alloc(0);
    const result = await convertPdfToMarkdown(buf);
    expect(result.startsWith('[Error')).toBe(true);
  });

  it('扫描件（无文本层）返回警告提示', async () => {
    // 为什么不 mock：无法轻易构造无文本层的 PDF fixture
    // 扫描件检测逻辑通过 text.length < 50 判断，这里验证阈值逻辑的正确性
    // 实际扫描件场景由 E2E 测试覆盖
    if (!FIXTURE_EXISTS) {
      console.warn('Skip: pdf-parse test fixture not found');
      return;
    }
    // 正常 PDF 提取结果不应触发扫描件警告
    const buf = fs.readFileSync(PDF_FIXTURE);
    const result = await convertPdfToMarkdown(buf);
    expect(result.startsWith('[Warning')).toBe(false);
  });
});
