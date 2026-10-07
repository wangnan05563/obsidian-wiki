// pptx-renderer.ts 单元测试（mock pptxgenjs 版）：
// 用受控假实现替换 pptxgenjs，把「布局分发/字号选择/溢出截断/文本内容」变成可直接断言的行为。
// 为什么 mock：pptxgenjs 的真实输出是 zip 二进制，无法细粒度断言每页元素；
//   渲染器与库的契约面很窄（defineLayout/addSlide/addText/addShape/write），假实现足以驱动全部分支。
// 真实库产物的端到端验证见 test/pptx-renderer-real.test.ts。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseMarpSlides,
  renderPptx,
  generatePptxFile,
  type Slide,
} from '../src/workflows/pptx-renderer.js';
import type { VaultService } from '../src/vault/vault-service.js';

interface TextCall { text: string; opts: Record<string, unknown> }
interface ShapeCall { type: string; opts: Record<string, unknown> }
interface SlideRec { background: unknown; shapes: ShapeCall[]; texts: TextCall[] }

const h = vi.hoisted(() => ({
  slideCalls: [] as unknown[],
  instances: [] as unknown[],
  writeResult: Buffer.from('FAKE-PPTX-BYTES'),
}));

vi.mock('pptxgenjs', () => {
  return {
    default: class FakePptx {
      layout = '';
      author = '';
      title = '';
      constructor() {
        (h.instances as Array<Record<string, unknown>>).push(this);
      }
      defineLayout(opts: unknown) {
        (this as Record<string, unknown>).__layout = opts;
      }
      addSlide() {
        const rec: SlideRec = { background: undefined, shapes: [], texts: [] };
        (h.slideCalls as SlideRec[]).push(rec);
        return {
          set background(v: unknown) { rec.background = v; },
          get background() { return rec.background; },
          addShape: (type: string, opts: Record<string, unknown>) => {
            rec.shapes.push({ type, opts });
          },
          addText: (text: string, opts: Record<string, unknown>) => {
            rec.texts.push({ text: String(text), opts });
          },
        };
      }
      async write() {
        (this as Record<string, unknown>).__writeCalled = true;
        return h.writeResult;
      }
    },
  };
});

function lastInstance(): Record<string, unknown> {
  return (h.instances as Array<Record<string, unknown>>)[h.instances.length - 1];
}
function slides(): SlideRec[] {
  return h.slideCalls as SlideRec[];
}

beforeEach(() => {
  h.slideCalls.length = 0;
  h.instances.length = 0;
});

describe('parseMarpSlides', () => {
  it('剥离 frontmatter 后解析标题页', () => {
    const out = parseMarpSlides('---\nmarp: true\ntitle: x\n---\n# 封面标题');
    expect(out).toEqual([{ title: '封面标题', items: [] }]);
  });

  it('CRLF frontmatter 同样被剥离', () => {
    const out = parseMarpSlides('---\r\nmarp: true\r\n---\r\n# CRLF 封面\r\n- 要点一');
    expect(out[0].title).toBe('CRLF 封面');
    expect(out[0].items).toEqual([{ kind: 'bullet', level: 0, text: '要点一' }]);
  });

  it('独立行 --- 分页，末尾空块被跳过', () => {
    const md = '# A\n\n---\n\n## B\n- x\n\n---\n\n# C';
    const out = parseMarpSlides(md);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ title: 'B', items: [{ kind: 'bullet', level: 0, text: 'x' }] });
    expect(out[2]).toEqual({ title: 'C', items: [] });
  });

  it('编号列表去编号存为顶层 bullet（支持 "1." 与 "1)"）', () => {
    const out = parseMarpSlides('## 目录\n1. 第一章\n2) 第二章');
    expect(out[0].items).toEqual([
      { kind: 'bullet', level: 0, text: '第一章' },
      { kind: 'bullet', level: 0, text: '第二章' },
    ]);
  });

  it('2+ 空格缩进的 -/* 子点 level=1，顶层 level=0', () => {
    const out = parseMarpSlides('## T\n- 顶层\n  - 子点\n    * 更深子点');
    expect(out[0].items).toEqual([
      { kind: 'bullet', level: 0, text: '顶层' },
      { kind: 'bullet', level: 1, text: '子点' },
      { kind: 'bullet', level: 1, text: '更深子点' },
    ]);
  });

  it('仅首个标题作为 title，后续标题降级为 plain 项', () => {
    const out = parseMarpSlides('# 主标题\n## 次标题\n正文说明行');
    expect(out[0].title).toBe('主标题');
    expect(out[0].items).toEqual([
      { kind: 'plain', level: 0, text: '## 次标题' },
      { kind: 'plain', level: 0, text: '正文说明行' },
    ]);
  });

  it('空 markdown / 纯空白 → []', () => {
    expect(parseMarpSlides('')).toEqual([]);
    expect(parseMarpSlides('   \n \t \n')).toEqual([]);
  });
});

describe('renderPptx 实例配置与分发', () => {
  it('defineLayout 16:9 + layout/author/title，空标题回退默认', async () => {
    const s: Slide[] = [{ title: 'T', items: [] }];
    await renderPptx(s, '我的演示');
    const inst = lastInstance();
    expect((inst as { __layout?: unknown }).__layout).toEqual({
      name: 'KARPATHY_WIDE', width: 13.333, height: 7.5,
    });
    expect(inst.layout).toBe('KARPATHY_WIDE');
    expect(inst.author).toBe('Karpathy Wiki');
    expect(inst.title).toBe('我的演示');

    await renderPptx(s, '');
    expect(lastInstance().title).toBe('知识库幻灯片');
  });

  it('write 以 nodebuffer 输出且返回其结果', async () => {
    const buf = await renderPptx([{ title: 'A', items: [] }], 'T');
    expect(buf).toBe(h.writeResult);
    expect(lastInstance().__writeCalled).toBe(true);
  });

  it('零页输入 → 补一页占位封面（title 回退）', async () => {
    await renderPptx([], '标题兜底');
    expect(slides()).toHaveLength(1);
    const cover = slides()[0];
    expect(cover.texts[0]).toMatchObject({ text: '标题兜底' });
    expect(cover.texts[1].text).toBe(''); // 无 items 时副标题为空串
  });

  it('首页恒为封面：含目录关键词也不走目录布局', async () => {
    await renderPptx([{ title: '目录', items: [{ kind: 'bullet', level: 0, text: 'a' }] }], 'x');
    const cover = slides()[0];
    // 封面：标题 fontSize 40，副标题 fontSize 20，无编号文本
    expect(cover.texts.find((t) => t.opts.fontSize === 40)?.text).toBe('目录');
    expect(cover.texts.find((t) => t.opts.fontSize === 20)?.text).toBe('a');
    expect(cover.texts.some((t) => t.text.startsWith('1.'))).toBe(false);
  });

  it('封面取第一个 item 作副标题', async () => {
    await renderPptx([
      { title: '大标题', items: [{ kind: 'plain', level: 0, text: '副标题一' }, { kind: 'plain', level: 0, text: '副标题二' }] },
    ], 'x');
    expect(slides()[0].texts.find((t) => t.opts.fontSize === 20)?.text).toBe('副标题一');
  });
});

describe('renderPptx 目录页（isAgendaTitle）', () => {
  const md = (title: string) => `# 封面\n副标题\n---\n## ${title}\n1. 甲\n- 乙\n说明文字`;

  it('目录关键词（目录/大纲/AGENDA）走目录布局：编号文本 + 左侧全高色条', async () => {
    await renderPptx(parseMarpSlides(md('目录')), 'x');
    const agenda = slides()[1];
    expect(agenda.shapes[0].opts.h).toBe(7.5);
    expect(agenda.texts.map((t) => t.text)).toEqual(['目录', '1.  甲', '2.  乙']);
    // plain「说明文字」不进目录
    expect(agenda.texts.some((t) => t.text === '说明文字')).toBe(false);
  });

  it('AGENDA 标题同样命中', async () => {
    await renderPptx(parseMarpSlides(md('AGENDA')), 'x');
    expect(slides()[1].texts[0]).toMatchObject({ text: 'AGENDA' });
  });
});

describe('renderPptx 结语页（isClosingTitle）', () => {
  it('无 bullet 要点的结语：居中输出最后一行文本', async () => {
    await renderPptx([
      { title: '封面', items: [] },
      { title: '谢谢观看', items: [{ kind: 'plain', level: 0, text: '感谢聆听本知识库分享' }] },
    ], 'x');
    const closing = slides()[1];
    expect(closing.shapes[0].opts.fill).toEqual({ color: '#722ED1' }); // 紫色 accent
    expect(closing.texts.map((t) => t.text)).toEqual(['谢谢观看', '感谢聆听本知识库分享']);
    expect(closing.texts[1].opts.align).toBe('center');
  });

  it('结语要点全空时兜底输出标题本身', async () => {
    await renderPptx([{ title: 'A', items: [] }, { title: 'THE END', items: [] }], 'x');
    const closing = slides()[1];
    expect(closing.texts[1].text).toBe('THE END');
  });

  it('含 bullet 的总结页：圆点列表（code 2022）', async () => {
    await renderPptx([
      { title: 'A', items: [] },
      { title: '总结', items: [{ kind: 'bullet', level: 0, text: '回顾一' }, { kind: 'plain', level: 0, text: '附注' }] },
    ], 'x');
    const closing = slides()[1];
    const bullets = closing.texts.filter((t) => t.opts.bullet);
    expect(bullets.map((t) => t.text)).toEqual(['回顾一']);
    expect(bullets[0].opts.bullet).toEqual({ indent: 6, code: '2022' });
  });
});

describe('renderPptx 内容页（addContentSlide）', () => {
  const mk = (n: number, text = '要点'): Slide[] => [
    { title: '封面', items: [] },
    {
      title: '内容页',
      items: Array.from({ length: n }, (_, i) => ({
        kind: 'bullet' as const, level: 0, text: `${text}${i}`,
      })),
    },
  ];

  it('页码文本为 "页序/总数"', async () => {
    await renderPptx([{ title: 'c', items: [] }, { title: '正文', items: [] }, { title: 'd', items: [] }], 'x');
    const content = slides()[1];
    expect(content.texts.some((t) => t.text === '2 / 3')).toBe(true);
  });

  it('字号按要点数分档：4→18、5→16、8→14', async () => {
    const firstBodyFontSize = async (n: number) => {
      h.slideCalls.length = 0;
      await renderPptx(mk(n), 'x');
      const body = slides()[1].texts.filter((t) => t.opts.bullet);
      return body[0].opts.fontSize;
    };
    expect(await firstBodyFontSize(4)).toBe(18);
    expect(await firstBodyFontSize(5)).toBe(16);
    expect(await firstBodyFontSize(8)).toBe(14);
  });

  it('空要点内容页兜底用标题作首条正文', async () => {
    await renderPptx([{ title: 'c', items: [] }, { title: '仅有标题', items: [] }], 'x');
    const body = slides()[1].texts.filter((t) => t.opts.bullet);
    expect(body[0].text).toBe('仅有标题');
  });

  it('子项右缩进 x=0.9 且用灰色辅助色，顶层 x=0.5', async () => {
    await renderPptx([
      { title: 'c', items: [] },
      {
        title: '层级',
        items: [
          { kind: 'bullet', level: 0, text: '顶层项' },
          { kind: 'bullet', level: 1, text: '子项内容' },
        ],
      },
    ], 'x');
    const body = slides()[1].texts.filter((t) => t.opts.bullet);
    expect(body[0].opts.x).toBe(0.5);
    expect(body[1].opts.x).toBe(0.9);
    expect(body[1].opts.color).toBe('#A9B0B8');
    expect(body[1].opts.bullet).toEqual({ indent: 0, code: '2013' });
  });

  it('长文本按 22 字/行估算行高（h = fontSize*1.45*lines/72）', async () => {
    const long = '长'.repeat(45); // ceil(45/22)=3 行
    await renderPptx([{ title: 'c', items: [] }, { title: 't', items: [{ kind: 'bullet', level: 0, text: long }] }], 'x');
    const body = slides()[1].texts.filter((t) => t.opts.bullet);
    expect(body[0].opts.h).toBeCloseTo((18 * 1.45 * 3) / 72, 10);
  });

  it('溢出保护：大量要点触发行截断，且始终保留页码行', async () => {
    await renderPptx(mk(60, '条目'), 'x');
    const s = slides()[1];
    const body = s.texts.filter((t) => t.opts.bullet);
    expect(body.length).toBeLessThan(60);
    expect(body.length).toBeGreaterThan(5);
    expect(s.texts[s.texts.length - 1].text).toBe('2 / 2');
  });

  it('内容页含顶部色条（横条 + 左侧竖条）', async () => {
    await renderPptx([{ title: 'c', items: [] }, { title: 't', items: [] }], 'x');
    const shapes = slides()[1].shapes;
    expect(shapes).toHaveLength(2);
    expect(shapes[0].opts).toMatchObject({ w: 13.333, h: 1.0, fill: { color: '#E8F0FF' } });
    expect(shapes[1].opts).toMatchObject({ w: 0.12, h: 1.0, fill: { color: '#165DFF' } });
  });
});

describe('generatePptxFile', () => {
  it('解析→渲染→写入 vault，归档路径与下载 URL 匹配契约', async () => {
    const writeFile = vi.fn(async () => undefined);
    const vault = { writeFile } as unknown as VaultService;
    const res = await generatePptxFile(vault, '# 封面\n要点\n---\n## 页面\n- a', '演示标题');

    expect(res.archivePath).toMatch(/^queries\/media\/ppt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pptx$/);
    const filename = res.archivePath.split('/').pop()!;
    expect(res.url).toBe(`/api/media/file/${filename}`);
    expect(writeFile).toHaveBeenCalledWith(res.archivePath, h.writeResult);
    expect(slides()).toHaveLength(2); // 封面 + 内容页均渲染
  });

  it('vault 写失败时向上抛错（失败策略由调用方决定）', async () => {
    const vault = { writeFile: vi.fn(async () => { throw new Error('disk full'); }) } as unknown as VaultService;
    await expect(generatePptxFile(vault, '# 只有一页', 'T')).rejects.toThrow('disk full');
  });
});
