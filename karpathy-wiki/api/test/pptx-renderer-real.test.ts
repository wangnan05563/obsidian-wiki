// pptx-renderer.ts 端到端验证（真实 pptxgenjs 3.x）：
// 与 mock 版（test/pptx-renderer.test.ts）互补——这里不 mock 任何模块，
// 验证渲染器对 pptxgenjs 真实 API 面的使用是正确的：产出可下载的 .pptx 二进制（ZIP/PK 头）。
// 为什么确定性：pptxgenjs write({outputType:'nodebuffer'}) 纯内存生成，无网络/文件系统依赖。
import { describe, it, expect, vi } from 'vitest';
import { parseMarpSlides, renderPptx, generatePptxFile } from '../src/workflows/pptx-renderer.js';
import type { VaultService } from '../src/vault/vault-service.js';

function expectPptxZip(buf: Buffer): void {
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.length).toBeGreaterThan(1000);
  // OOXML .pptx 是 ZIP 容器：本地文件头 'PK\x03\x04'
  expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

describe('renderPptx（真实 pptxgenjs 产物）', () => {
  it('完整五类页（封面/目录/内容/总结/结语）产出合法 .pptx ZIP', async () => {
    const md = [
      '---',
      'marp: true',
      'paginate: true',
      '---',
      '# 知识库季度回顾',
      'Karpathy AI + Obsidian 实践分享',
      '',
      '---',
      '',
      '## 目录',
      '1. 背景与动机',
      '2. 架构设计',
      '3. 落地效果',
      '',
      '---',
      '',
      '## 架构设计',
      '- Fastify 后端 + Harness 引擎',
      '  - SSE 流式进度',
      '  - compile 串行队列',
      '- Obsidian vault 作为单一数据源',
      '',
      '---',
      '',
      '## 总结',
      '- 生成页面数提升 3 倍',
      '- 知识库检索延迟下降',
      '',
      '---',
      '',
      '## 谢谢观看',
      '欢迎交流讨论',
    ].join('\n');
    const slides = parseMarpSlides(md);
    expect(slides).toHaveLength(5);
    expectPptxZip(await renderPptx(slides, '知识库季度回顾'));
  });

  it('空页数组也产出非空 .pptx（占位封面防御）', async () => {
    expectPptxZip(await renderPptx([], '占位标题'));
  });

  it('大量要点的溢出保护页不崩溃且仍产出合法 ZIP', async () => {
    const big = {
      title: '长列表页',
      items: Array.from({ length: 60 }, (_, i) => ({ kind: 'bullet' as const, level: 0, text: `要点 ${i} —— 一段中等长度的中文描述文本` })),
    };
    expectPptxZip(await renderPptx([{ title: '封面', items: [] }, big], 'T'));
  });
});

describe('generatePptxFile（真实渲染 + mock VaultService）', () => {
  it('渲染产物写入 vault 指定归档路径并返回下载 URL', async () => {
    const writes: Array<{ path: string; buf: Buffer }> = [];
    const vault = {
      writeFile: vi.fn(async (p: string, buf: Buffer) => {
        writes.push({ path: p, buf });
      }),
    } as unknown as VaultService;

    const res = await generatePptxFile(vault, '# 演示\n副标题\n---\n## 内容\n- 要点', '演示');
    const filename = res.archivePath.replace('queries/media/', '');
    expect(res.archivePath).toMatch(new RegExp(`^queries/media/${filename}$`));
    expect(filename).toMatch(/^ppt-[0-9a-f-]{36}\.pptx$/);
    expect(res.url).toBe(`/api/media/file/${filename}`);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(res.archivePath);
    expectPptxZip(writes[0].buf);
  });
});
