// 回归测试：统一弹窗组件 AppModal（T01629 全站弹窗交互收敛）
// 为什么需要：DataClean「差异对比」抽屉、Tunnel 配置向导、Progress 运行日志等宿主需要真实数据
//   才能打开，浏览器 UI 实测无法稳定触达；这里直接对组件本身断言「统一默认值」契约
//   （遮罩不关 / ESC 可关 / 有统一关闭按钮 / 内容区统一类名），两种形态同权。
// 遮罩不关闭、ESC 关闭、X 关闭三项在真实浏览器（About + Query）已实测通过；
// 这里不重复模拟 X 关闭，happy-dom 下 Element Plus 的关闭过渡不可靠，只断言统一关闭入口存在。
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ElementPlus, { ElDialog, ElDrawer } from 'element-plus';
import AppModal from '../src/components/AppModal.vue';

function mountHost(props: Record<string, unknown>) {
  const host = {
    components: { AppModal },
    setup() {
      const open = ref(true);
      return { open, props };
    },
    template: `<AppModal v-model="open" v-bind="props"><div class="probe-body">内容</div></AppModal>`,
  };
  const wrapper = mount(host, { global: { plugins: [ElementPlus] }, attachTo: document.body });
  return { wrapper, vm: wrapper.vm as unknown as { open: boolean } };
}

async function opened(props: Record<string, unknown>) {
  const r = mountHost(props);
  await nextTick();
  await flushPromises();
  return r;
}

describe('AppModal 统一弹窗契约', () => {
  beforeEach(() => {
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('dialog 形态：统一类名 + 统一内容区 + 默认交互值', async () => {
    const { wrapper } = await opened({ title: '标题A', width: '720' });
    const dlg = document.querySelector('.el-overlay .app-modal');
    expect(dlg, '对话框应带 app-modal 类并挂在 body 遮罩下').not.toBeNull();
    expect(dlg!.querySelector('.app-modal-body .probe-body'), '默认插槽应渲染在统一内容区').not.toBeNull();
    const el = wrapper.findComponent(ElDialog);
    expect(el.props('closeOnClickModal'), '点击遮罩默认不关闭（防误关）').toBe(false);
    expect(el.props('closeOnPressEscape'), 'ESC 默认可关闭').toBe(true);
    expect(el.props('alignCenter'), '对话框默认居中').toBe(true);
    expect(el.props('appendToBody'), '对话框默认挂到 body 避免层叠上下文裁剪').toBe(true);
    expect(el.props('showClose'), '默认提供统一右上角关闭按钮').toBe(true);
  });

  it('drawer 形态：统一类名 + 贴右 + 同一组默认交互值', async () => {
    const { wrapper } = await opened({ title: '差异对比：A ↔ B', variant: 'drawer', size: '60%' });
    const drawer = document.querySelector('.el-overlay .app-modal');
    expect(drawer, '抽屉应带 app-modal 统一类名').not.toBeNull();
    expect(drawer!.classList.contains('app-modal-drawer'), '抽屉应带 app-modal-drawer 修饰类').toBe(true);
    expect(drawer!.classList.contains('rtl'), '抽屉应默认贴右（rtl）').toBe(true);
    expect(drawer!.querySelector('.app-modal-body .probe-body'), '默认插槽应渲染在统一内容区').not.toBeNull();
    expect(drawer!.textContent).toContain('差异对比');
    const el = wrapper.findComponent(ElDrawer);
    expect(el.props('closeOnClickModal'), '抽屉同样默认不因遮罩关闭').toBe(false);
    expect(el.props('closeOnPressEscape'), '抽屉 ESC 默认可关闭').toBe(true);
    expect(el.props('direction'), '抽屉默认方向贴右').toBe('rtl');
    expect(el.props('size'), '抽屉宽度按 size 透传').toBe('60%');
  });

  it('两种形态：点击遮罩均不关闭（防误关），并保留统一关闭入口', async () => {
    for (const variant of ['dialog', 'drawer'] as const) {
      const { vm } = await opened({ title: `T-${variant}`, variant });
      const overlay = document.querySelector('.el-overlay')!;
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await nextTick();
      await flushPromises();
      expect(vm.open, `${variant} 点遮罩不应关闭`).toBe(true);

      const closeBtn = document.querySelector(
        variant === 'dialog' ? '.app-modal .el-dialog__headerbtn' : '.app-modal .el-drawer__close-btn'
      ) as HTMLElement;
      expect(closeBtn, `${variant} 应有统一关闭入口`).not.toBeNull();
    }
  });
});
