// T02882：引导卡片视口收敛——目标元素高于视口时，footer 按钮必须仍落在视口内可点。
// ------------------------------------------------------------------
// 缺陷形状：卡片 top 恒为「目标框下沿 + 12」，目标很高（占满整屏的卡片）时整张
//   引导卡被推到视口之外，步进/完成按钮鼠标永远够不着，只能点遮罩跳过。
// jsdom 不做真实布局，这里沿用 ModelSelector.test.ts 的 mockRect 打桩口径：
//   给目标元素打「高 2000px」的 rect，卡片高度走 measureCard 的 240 兜底常量，
//   断言落在卡片内联样式（cardStyle 的直接产物）与 footer 按钮的可点性上，
//   不靠截图。elementFromPoint 按「谁的打桩矩形含该点就返回谁」实现，
//   使「按钮中心命中按钮本身」的断言真实咬合 clamp 值——clamp 被去掉即红。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import { nextTick } from 'vue';
import path from 'node:path';

import { useGuideStore } from '../src/stores/guide';
import { GUIDE_DEFINITIONS, type GuideStep } from '../src/guides';
import GuideOverlay from '../src/components/GuideOverlay.vue';

const FAKE_VIEW = 'test-viewport-view';

function stubRect(el: Element, rect: Partial<DOMRect>): void {
  (el as HTMLElement).getBoundingClientRect = vi.fn(
    () =>
      ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect,
  );
}

const realInnerHeight = window.innerHeight;
const realInnerWidth = window.innerWidth;
const realFromPoint = document.elementFromPoint.bind(document);

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }
  await nextTick();
}

/** 挂遮罩 + 注入单步引导 + 打目标 rect（须在 start 前打桩），返回 { guide, wrapper } */
async function mountWithStep(step: GuideStep, rect: Partial<DOMRect>) {
  setActivePinia(createPinia());
  GUIDE_DEFINITIONS[FAKE_VIEW] = { view: FAKE_VIEW, title: '视口收敛测试', steps: [step] };
  const target = document.createElement('div');
  target.className = step.target.replace(/^\./, '');
  document.body.appendChild(target);
  stubRect(target, rect);

  const wrapper = mount(GuideOverlay, {
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  });
  const guide = useGuideStore();
  guide.start(FAKE_VIEW);
  await settle();
  return { guide, wrapper };
}

afterEach(() => {
  delete GUIDE_DEFINITIONS[FAKE_VIEW];
  document.querySelectorAll('.tall-target, .low-target').forEach((n) => n.remove());
  document.querySelectorAll('.guide-overlay, .guide-card').forEach((n) => n.remove());
  Object.defineProperty(window, 'innerHeight', { value: realInnerHeight, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: realInnerWidth, configurable: true });
  document.elementFromPoint = realFromPoint;
  vi.restoreAllMocks();
});

describe('T02882 引导卡片视口收敛', () => {
  it('目标高于视口：卡片贴视口下沿收敛，footer 按钮矩形全在视口内且 elementFromPoint 命中', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });

    const { wrapper } = await mountWithStep(
      { target: '.tall-target', title: '高目标', description: '占满整屏的目标', placement: 'top' },
      { top: 0, left: 100, width: 400, height: 2000 },
    );
    await settle();

    const card = document.querySelector<HTMLElement>('.guide-card');
    expect(card, '引导卡应已渲染').toBeTruthy();
    // 768 - 240(兜底卡高) - 12(EDGE)：不 clamp 时 top 会是 0+2000+12=2012
    expect(card!.style.top).toBe('516px');

    // footer 按钮：按卡片位置推算真实落点（卡高 240，footer 靠卡片底部）
    const cardTop = parseFloat(card!.style.top);
    const btns = Array.from(card!.querySelectorAll<HTMLElement>('.guide-card-foot .el-button'));
    expect(btns.length, 'footer 至少有步进/完成按钮').toBeGreaterThan(0);
    const rects = new Map<Element, DOMRect>();
    btns.forEach((btn, i) => {
      // 每个按钮错开 x 区间，elementFromPoint 命中判定才互不串扰
      const r = {
        top: cardTop + 200,
        bottom: cardTop + 232,
        left: 20 + i * 80,
        right: 84 + i * 80,
        width: 64,
        height: 32,
      } as DOMRect;
      stubRect(btn, r);
      rects.set(btn, r);
      expect(r.bottom, `按钮「${btn.textContent?.trim()}」必须整体在视口内`).toBeLessThanOrEqual(768);
    });
    // 命中断言：按钮中心点 elementFromPoint 必须是按钮本身（clamp 失效时该点在视口外/被遮罩挡住）
    document.elementFromPoint = vi.fn((x: number, y: number) => {
      for (const [el, r] of rects) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
      }
      return null;
    }) as unknown as typeof document.elementFromPoint;
    for (const btn of btns) {
      const r = rects.get(btn)!;
      expect(document.elementFromPoint(r.left + 32, r.top + 16)).toBe(btn);
    }
    wrapper.unmount();
  });

  it('目标靠近视口底部：卡片翻转到目标上沿，left 越界时 clamp 进视口', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });

    const { wrapper } = await mountWithStep(
      { target: '.low-target', title: '低位目标', description: '贴近视口底部', placement: 'top' },
      // left 1400 越过 1024 视口：below=662 放不下（662+240>756），above=600-240-12=348 放得下
      { top: 600, left: 1400, width: 400, height: 50 },
    );
    await settle();

    const card = document.querySelector<HTMLElement>('.guide-card');
    expect(card, '引导卡应已渲染').toBeTruthy();
    expect(card!.style.top, '应翻转到目标上沿').toBe('348px');
    expect(card!.style.left, 'left 应 clamp 进 [EDGE, 视口-卡宽-EDGE]').toBe('732px');
    wrapper.unmount();
  });

  it('两侧都放不下：贴视口下沿收敛（不翻转到负 top）', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });

    const { wrapper } = await mountWithStep(
      { target: '.tall-target', title: '中位高目标', description: '上下都不够放', placement: 'top' },
      // below=732 放不下；above=200-252<0 也放不下 → 只能贴下沿 clamp 到 516
      { top: 200, left: 100, width: 400, height: 520 },
    );
    await settle();

    const card = document.querySelector<HTMLElement>('.guide-card');
    expect(card!.style.top).toBe('516px');
    wrapper.unmount();
  });

  it('CSS 兜底：卡片自身可滚（max-height + overflow-y），极矮视口 footer 不被推出', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(path.resolve(__dirname, '../src/components/GuideOverlay.vue'), 'utf8');
    expect(src).toContain('max-height: calc(100vh - 24px)');
    expect(src).toContain('overflow-y: auto');
  });
});
