// FR-21 引用角标解析单测（T01769 测试计划第 1 项：合法/非法 [n]）。
// 覆盖：合法槽位替换、非法编号保留、无槽位短路、两位数边界、事件委托槽位解析。
import { describe, expect, it } from 'vitest';
import { replaceCitationMarks, resolveCiteSlot } from '../src/utils/citation';

describe('replaceCitationMarks（FR-21 角标替换）', () => {
  it('合法槽位 [1] 替换为可点击角标，data-n 与文案为槽位号', () => {
    const out = replaceCitationMarks('如 <p>RAG 定义[1] 所述</p>', 3);
    expect(out).toContain('<sup class="cite-ref" data-n="1"');
    expect(out).toContain('>1</sup>');
    // 原文本其余部分不受影响
    expect(out).toContain('如 <p>RAG 定义');
  });

  it('多个角标一次全部替换', () => {
    const out = replaceCitationMarks('a[1] b[2]', 2);
    expect(out.match(/cite-ref/g)).toHaveLength(2);
    expect(out).toContain('data-n="1"');
    expect(out).toContain('data-n="2"');
  });

  it('非法编号（超出槽位数）保留原文，防 LLM 编造编号误导跳转', () => {
    const out = replaceCitationMarks('引用[4]与[9]', 3);
    expect(out).toBe('引用[4]与[9]');
    expect(out).not.toContain('cite-ref');
  });

  it('边界值：n=maxSlot 合法、n=maxSlot+1 非法', () => {
    const hit = replaceCitationMarks('边界[3]', 3);
    expect(hit).toContain('cite-ref');
    const miss = replaceCitationMarks('越界[4]', 3);
    expect(miss).toBe('越界[4]');
  });

  it('n=0 与负号形式不替换（槽位从 1 起）', () => {
    expect(replaceCitationMarks('零[0]', 3)).toBe('零[0]');
    expect(replaceCitationMarks('负[-1]', 3)).toBe('负[-1]');
  });

  it('三位数编号不替换（限 1~2 位）', () => {
    expect(replaceCitationMarks('大号[100]', 200)).toBe('大号[100]');
  });

  it('maxSlot=0（无引用）整体短路，原样返回', () => {
    const html = '没有任何引用[1]';
    expect(replaceCitationMarks(html, 0)).toBe(html);
  });

  it('已含 cite-ref 的 HTML 不受二次替换影响（幂等）', () => {
    const once = replaceCitationMarks('x[1]', 1);
    const twice = replaceCitationMarks(once, 1);
    expect(twice).toBe(once);
  });
});

describe('resolveCiteSlot（事件委托槽位解析）', () => {
  /** 构造仿浏览器 DOM 片段（closest/data-N 为运行时行为，jsdom 等价） */
  function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  }

  it('点击角标本身：解析出 data-n 槽位号', () => {
    const host = mount('<sup class="cite-ref" data-n="2">2</sup>');
    const sup = host.querySelector('sup')!;
    expect(resolveCiteSlot(sup, 3)).toBe(2);
  });

  it('点击角标内部子节点：closest 向上命中角标', () => {
    const host = mount('<sup class="cite-ref" data-n="1"><b>1</b></sup>');
    const inner = host.querySelector('b')!;
    expect(resolveCiteSlot(inner, 3)).toBe(1);
  });

  it('点击非角标区域：返回 null', () => {
    const host = mount('<p>普通文本</p>');
    expect(resolveCiteSlot(host.querySelector('p'), 3)).toBeNull();
  });

  it('data-n 越界（超 maxSlot）：拒绝上抛，返回 null', () => {
    const host = mount('<sup class="cite-ref" data-n="9">9</sup>');
    expect(resolveCiteSlot(host.querySelector('sup'), 3)).toBeNull();
  });

  it('target 为空/非元素：安全返回 null', () => {
    expect(resolveCiteSlot(null, 3)).toBeNull();
  });
});
