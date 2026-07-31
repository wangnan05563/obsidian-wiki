# -*- coding: utf-8 -*-
"""
验证 Query.vue 高级设置下拉菜单修复效果
==========================================
修复背景：el-dropdown 的 outside-click 检测机制即使设了 :hide-on-click="false"
         和 @pointerdown.stop 仍会在某些场景关闭菜单。
修复方案：el-dropdown -> el-popover + trigger="manual" + :visible 完全手动控制可见性。

关键验证点：点击 popover 内的 checkbox 后，popover 必须保持打开，
           且 .middlewares-count / .output-modes-count 文本应随选中数变化。

实现注意：
- popover 内容被 teleport 到 body，Playwright 的可见性判断可能不准，
  故用 page.evaluate 直接读 getBoundingClientRect 判断真实可见性。
- 用 domcontentloaded + wait_for_timeout 给足渲染时间，避免 networkidle 超时。
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173/wiki/"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SHOT_DIR = os.path.join(SCRIPT_DIR, "popover_fix_shots")
os.makedirs(SHOT_DIR, exist_ok=True)

# 设为 False 可肉眼观察；True 更稳定适合无人值守
HEADLESS = True


def shot(page, name):
    path = os.path.join(SHOT_DIR, name + ".png")
    page.screenshot(path=path, full_page=True)
    print(f"  [截图] {path}")
    return path


def popover_state(page, label):
    """读取 teleport 到 body 的 .multi-select-popover 真实 DOM 状态。"""
    info = page.evaluate(
        r"""() => {
            const el = document.querySelector('.multi-select-popover');
            if (!el) return {exists:false, visible:false, w:0, h:0, checkboxes:0, display:null, visibility:null};
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const checks = el.querySelectorAll('.el-checkbox').length;
            const vis = (r.width > 0 && r.height > 0
                         && style.visibility !== 'hidden'
                         && style.display !== 'none');
            return {
                exists: true,
                visible: vis,
                w: Math.round(r.width),
                h: Math.round(r.height),
                checkboxes: checks,
                display: style.display,
                visibility: style.visibility
            };
        }"""
    )
    print(f"  [{label}] popover: exists={info['exists']} visible={info['visible']} "
          f"w={info['w']} h={info['h']} checkboxes={info['checkboxes']} "
          f"display={info['display']} visibility={info['visibility']}")
    return info


def count_text(page, sel, label):
    txt = page.evaluate(
        "s => (document.querySelector(s) || {}).textContent || ''", sel
    )
    print(f"  [{label}] {sel} = {txt!r}")
    return txt


def main():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        try:
            # ===== 步骤1: 访问首页 =====
            print("== 步骤1: 访问首页 ==")
            page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)
            shot(page, "01_home")

            # ===== 步骤2: 登录 =====
            print("== 步骤2: 登录 admin/admin123 ==")
            page.fill("input[type='text']", "admin")
            page.fill("input[type='password']", "admin123")
            page.click(".login-btn")
            page.wait_for_timeout(2500)
            shot(page, "02_after_login")
            print("  当前URL:", page.url)

            # ===== 步骤3-4: 点击"知识问答" =====
            print("== 步骤3-4: 点击导航栏'知识问答' ==")
            try:
                page.get_by_text("知识问答", exact=True).first.click(timeout=8000)
            except Exception:
                page.locator(".tab-btn").filter(has_text="知识问答").first.click(timeout=8000)
            page.wait_for_timeout(2000)
            shot(page, "03_query_page")
            print("  当前URL:", page.url)

            # ===== 步骤6: 展开高级设置 =====
            print("== 步骤6: 点击齿轮展开高级设置 ==")
            page.click(".advanced-toggle")
            page.wait_for_timeout(800)
            advanced_visible = page.evaluate(
                r"""() => {
                    const el = document.querySelector('.advanced-panel');
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }"""
            )
            print(f"  .advanced-panel visible = {advanced_visible}")
            if not advanced_visible:
                print("  [重试] 面板未展开，再次点击 .advanced-toggle")
                page.click(".advanced-toggle")
                page.wait_for_timeout(800)
                advanced_visible = page.evaluate(
                    r"""() => { const el=document.querySelector('.advanced-panel');
                        if(!el) return false; const r=el.getBoundingClientRect();
                        return r.width>0 && r.height>0; }"""
                )
                print(f"  .advanced-panel visible(重试) = {advanced_visible}")
            shot(page, "04_advanced_open")

            # ============ 中间件 popover ============
            print("\n== 步骤8: 点击 .middlewares-trigger 打开中间件 popover ==")
            page.click(".middlewares-trigger")
            page.wait_for_timeout(600)
            st = popover_state(page, "中间件-popover初始")
            shot(page, "05_mw_popover_open")
            if not st["visible"]:
                results.append(("中间件 popover 打开", False, f"visible={st['visible']}"))
                print("  [失败] 中间件 popover 未出现")
            else:
                results.append(("中间件 popover 打开", True, f"checkboxes={st['checkboxes']}"))
                print(f"  checkbox 数量 = {st['checkboxes']}（预期 5）")

            # 步骤10: 点击第1个 checkbox
            print("\n== 步骤10: 点击第1个 checkbox ==")
            before_count = count_text(page, ".middlewares-count", "点击前")
            checks = page.locator(".multi-select-popover .el-checkbox")
            checks.nth(0).click()
            page.wait_for_timeout(600)
            shot(page, "06_after_click_mw1")
            st1 = popover_state(page, "点击第1个后")
            after_count = count_text(page, ".middlewares-count", "点击后")
            mw_keep_open = st1["visible"]
            print(f"  >>> 菜单保持打开 = {mw_keep_open}")
            print(f"  >>> count 变化 = {before_count!r} -> {after_count!r}")
            if not mw_keep_open:
                results.append(("中间件点击后菜单保持", False,
                                f"点击前 visible=True，点击后 visible={st1['visible']}（菜单被关闭）"))
            else:
                results.append(("中间件点击后菜单保持", True,
                                f"{before_count}->{after_count}"))

            # 步骤13: 点击第2个 checkbox
            print("\n== 步骤13: 点击第2个 checkbox ==")
            before2 = after_count
            checks.nth(1).click()
            page.wait_for_timeout(600)
            shot(page, "07_after_click_mw2")
            st2 = popover_state(page, "点击第2个后")
            after2 = count_text(page, ".middlewares-count", "点击第2个后")
            print(f"  >>> 菜单保持打开 = {st2['visible']}")
            print(f"  >>> count 变化 = {before2!r} -> {after2!r}")
            results.append(("中间件第2次点击保持", st2["visible"],
                            f"{before2}->{after2}"))

            # ============ 输出模式 popover ============
            print("\n== 步骤16: 验证输出模式 .output-modes-trigger ==")
            # 切换到输出模式：直接点 output-modes-trigger，toggleOutputModes 会自动关闭中间件 popover
            page.click(".output-modes-trigger")
            page.wait_for_timeout(600)
            ost = popover_state(page, "输出模式-popover初始")
            shot(page, "08_om_popover_open")
            results.append(("输出模式 popover 打开", ost["visible"],
                            f"checkboxes={ost['checkboxes']}"))

            obefore = count_text(page, ".output-modes-count", "输出模式点击前")
            page.locator(".multi-select-popover .el-checkbox").nth(0).click()
            page.wait_for_timeout(600)
            shot(page, "09_after_click_om1")
            ost2 = popover_state(page, "输出模式点击后")
            oafter = count_text(page, ".output-modes-count", "输出模式点击后")
            print(f"  >>> 菜单保持打开 = {ost2['visible']}")
            print(f"  >>> count 变化 = {obefore!r} -> {oafter!r}")
            results.append(("输出模式点击后菜单保持", ost2["visible"],
                            f"{obefore}->{oafter}"))

        except Exception as e:
            import traceback
            traceback.print_exc()
            results.append(("执行异常", False, str(e)))
            try:
                shot(page, "99_error")
            except Exception:
                pass
        finally:
            print("\n========== 验证汇总 ==========")
            all_ok = True
            for name, ok, detail in results:
                mark = "PASS" if ok else "FAIL"
                if not ok:
                    all_ok = False
                print(f"  [{mark}] {name}  {detail}")
            print("==============================")
            print("结论：修复成功" if all_ok else "结论：修复失败")
            browser.close()
            sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
