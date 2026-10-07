import { describe, it, expect } from 'vitest';
import { parseMarpSlides } from './pptx-renderer.js';

// Marp Markdown → 幻灯片结构解析回归测试
//
// 为什么要补这组用例：T01364 代码质量治理把 parseMarpSlides 的「块内逐行分类」逻辑
// 抽成模块级 parseSlideBlock / bulletLevel（SonarQube S3776 认知复杂度 23 → ≤15）。
// 该解析器此前在本仓库没有单元覆盖（只有 generatePptxFile 被媒体工作流引用），
// 抽取虽宣称行为等价，但分页边界 / 缩进子点 / 编号列表这类细节最容易在搬动时走样。
// 下面每条断言都以「重构前实现」的实测输出为准（用 25 组真实 Marp 产物对跑，差异 0），
// 因此这组用例既是解析器规格，也是本次重构的行为基线。
describe('parseMarpSlides', () => {
  it('剥离 frontmatter 并按独立行 --- 分页', () => {
    const md = [
      '---',
      'marp: true',
      'theme: default',
      '---',
      '# 甲',
      '1. A',
      '2. B',
      '  - 子',
      '',
      '---',
      '',
      '',
      '---',
      '',
      '# 尾',
    ].join('\n');
    const slides = parseMarpSlides(md);
    expect(slides.map((s) => s.title)).toEqual(['甲', '尾']);
    expect(slides[0].items).toEqual([
      { kind: 'bullet', level: 0, text: 'A' },
      { kind: 'bullet', level: 0, text: 'B' },
      { kind: 'bullet', level: 1, text: '子' },
    ]);
  });

  it('连续分页符与纯空白块都不产生空白页', () => {
    // 中间夹一个纯空白块：无标题且无条目 → 丢弃
    expect(parseMarpSlides('## A\n\n---\n\n---\n\n## B').map((s) => s.title)).toEqual(['A', 'B']);
    expect(parseMarpSlides('## A\n\n---\n   \n---\n\n## B').map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('仅首个标题作为页标题，后续标题按原文保留为 plain', () => {
    const slides = parseMarpSlides('# T1\n## T2\n正文');
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe('T1');
    // 第二个标题不覆盖 title，且整行（含 ##）作为 plain 文本保留——与原 !title 判定一致
    expect(slides[0].items).toEqual([
      { kind: 'plain', level: 0, text: '## T2' },
      { kind: 'plain', level: 0, text: '正文' },
    ]);
  });

  it('编号列表去编号；两空格以上缩进记为子点，单个 Tab 缩进仍是顶层', () => {
    const slides = parseMarpSlides('## S\n- top\n  - sub\n    * deep\n\t- tab');
    expect(slides[0].items).toEqual([
      { kind: 'bullet', level: 0, text: 'top' },
      { kind: 'bullet', level: 1, text: 'sub' },
      { kind: 'bullet', level: 1, text: 'deep' },
      { kind: 'bullet', level: 0, text: 'tab' },
    ]);
    expect(parseMarpSlides('## S\n1. a\n10) b')[0].items).toEqual([
      { kind: 'bullet', level: 0, text: 'a' },
      { kind: 'bullet', level: 0, text: 'b' },
    ]);
  });

  it('无标题的纯要点块保留为空标题页（不整块丢弃）', () => {
    const slides = parseMarpSlides('- x\n- y');
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe('');
    expect(slides[0].items).toHaveLength(2);
  });

  it('CRLF 产物（Windows）同样解析', () => {
    const slides = parseMarpSlides('# 甲\r\n- 要点\r\n\r\n---\r\n\r\n# 乙\r\n  - 子点');
    expect(slides).toHaveLength(2);
    expect(slides[0].items).toEqual([{ kind: 'bullet', level: 0, text: '要点' }]);
    expect(slides[1].items).toEqual([{ kind: 'bullet', level: 1, text: '子点' }]);
  });

  it('末尾孤立分隔符按纯文本保留（既有行为，不视为分页）', () => {
    // 行尾没有后续换行时正则匹配不到分隔符，--- 作为 plain 内容保留；
    // 固化该行为是为了防止「顺手修一下」把解析规格改掉。
    const slides = parseMarpSlides('## A\n- a\n\n---');
    expect(slides).toHaveLength(1);
    expect(slides[0].items).toEqual([
      { kind: 'bullet', level: 0, text: 'a' },
      { kind: 'plain', level: 0, text: '---' },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(parseMarpSlides('')).toEqual([]);
    expect(parseMarpSlides('\n\n\n')).toEqual([]);
  });
});
