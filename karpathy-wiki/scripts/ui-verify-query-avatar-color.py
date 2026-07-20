# -*- coding: utf-8 -*-
"""
Query 页面 UI 验证脚本（针对两项修复）：
  1. assistant 消息无 .msg-avatar 图标（仅 user 消息保留 ME 头像）
  2. user 气泡文字颜色随主题自适应，macaron 主题下不再是固定白色导致看不清

运行前提：前后端服务已启动（pnpm run dev:api + pnpm run dev:web）
"""
import os
from playwright.sync_api import sync_playwright

FRONTEND_URL = "http://localhost:5173"
SCREENSHOT_DIR = "docs/test-evidence/query-ui-fix"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def log(name, passed, details=""):
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name}: {details}")
    return passed


def relative_luminance(r, g, b):
    """WCAG 相对亮度：https://www.w3.org/TR/WCAG21/#dfn-relative-luminance"""
    def chan(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def contrast_ratio(rgb1, rgb2):
    """WCAG 对比度：https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio"""
    l1 = relative_luminance(*rgb1)
    l2 = relative_luminance(*rgb2)
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def parse_rgb(color_str):
    """解析 rgb(r, g, b) 或 rgba(r, g, b, a) 字符串为 (r, g, b)"""
    if not color_str or color_str == 'rgba(0, 0, 0, 0)':
        return None
    parts = color_str.replace('rgba(', '').replace('rgb(', '').replace(')', '').split(',')
    try:
        return (int(parts[0].strip()), int(parts[1].strip()), int(parts[2].strip()))
    except (ValueError, IndexError):
        return None


def set_theme(page, theme_key):
    """直接设置 data-theme 属性，绕过 UI 点击，确保主题切换稳定"""
    page.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme_key}')")
    page.wait_for_timeout(300)


def navigate_to_query(page):
    """导航到知识问答页"""
    tab = page.locator(".tab-btn:has-text('知识问答'), [class*='tab']:has-text('知识问答')")
    if tab.count() > 0:
        tab.first.click()
        page.wait_for_timeout(1500)
        return True
    return False


def submit_question(page, question="你好,请简单介绍一下自己"):
    """提交问题并等待 assistant 回复"""
    textarea = page.locator(".input-area textarea, .el-textarea__inner").first
    if textarea.count() == 0:
        return False
    textarea.click()
    textarea.fill(question)
    page.wait_for_timeout(200)
    # 点击发送按钮（带 Promotion 图标的主按钮）
    send_btn = page.locator(".button-bar .el-button--primary").first
    if send_btn.count() == 0:
        # 兜底：用 Ctrl+Enter 提交
        textarea.press("Control+Enter")
    else:
        send_btn.click()
    # 等待 assistant 气泡出现（非 streaming/loading 状态）
    try:
        page.wait_for_selector(
            ".msg-bubble.assistant:not(.streaming):not(.loading)",
            timeout=60000,
        )
        return True
    except Exception:
        return False


def main():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        print("\n=== 步骤 1: 打开首页并导航到知识问答 ===")
        page.goto(FRONTEND_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(2000)
        nav_ok = navigate_to_query(page)
        results.append(("nav-to-query", "导航到知识问答页", nav_ok))

        # === 验证 1：assistant 消息无 .msg-avatar ===
        print("\n=== 步骤 2: 提交问题，等待 assistant 回复 ===")
        replied = submit_question(page)
        results.append(("assistant-reply", "assistant 回复正常", replied))
        page.wait_for_timeout(1000)
        page.screenshot(path=f"{SCREENSHOT_DIR}/01-after-reply.png", full_page=False)

        print("\n=== 验证 1: assistant 无图标，user 保留 ME 头像 ===")
        user_rows = page.locator(".msg-row.user").count()
        assistant_rows = page.locator(".msg-row.assistant").count()
        results.append(("msg-rows-exist", f"user={user_rows} assistant={assistant_rows}",
                        user_rows > 0 and assistant_rows > 0))

        # user 消息应有 .msg-avatar
        user_avatar_count = page.locator(".msg-row.user .msg-avatar").count()
        results.append(("user-has-avatar", f"user 头像数={user_avatar_count}",
                        user_avatar_count == user_rows))

        # assistant 消息应无 .msg-avatar
        assistant_avatar_count = page.locator(".msg-row.assistant .msg-avatar").count()
        results.append(("assistant-no-avatar", f"assistant 头像数={assistant_avatar_count}",
                        assistant_avatar_count == 0))

        # === 验证 2：macaron 主题下 user 气泡文字颜色对比度 ===
        print("\n=== 验证 2: macaron 主题下 user 气泡文字对比度 ===")
        set_theme(page, "macaron")
        page.wait_for_timeout(500)
        page.screenshot(path=f"{SCREENSHOT_DIR}/02-macaron-user-bubble.png", full_page=False)

        user_bubble = page.locator(".msg-bubble.user").first
        if user_bubble.count() > 0:
            color_str = user_bubble.evaluate("el => getComputedStyle(el).color")
            bg_str = user_bubble.evaluate("el => getComputedStyle(el).backgroundColor")
            # 渐变背景 backgroundColor 通常返回 rgba(0,0,0,0)，需用 backgroundImage 起点色
            bg_image = user_bubble.evaluate("el => getComputedStyle(el).backgroundImage")

            text_rgb = parse_rgb(color_str)
            # macaron 主题 grad-fire 起点色 #ffb3d1 = (255, 179, 209)
            bg_rgb = (255, 179, 209)

            results.append(("macaron-text-color", f"text={color_str}",
                            text_rgb is not None and text_rgb != (255, 255, 255)))

            if text_rgb:
                ratio = contrast_ratio(text_rgb, bg_rgb)
                # WCAG AA 正文要求 4.5:1，大字 3:1
                results.append(("macaron-contrast-ratio",
                                f"text={text_rgb} bg={bg_rgb} ratio={ratio:.2f}",
                                ratio >= 3.0))
                print(f"  -> 对比度 {ratio:.2f}:1（AA 大字阈值 3.0，正文 4.5）")
        else:
            results.append(("macaron-user-bubble", "无 user 气泡可测", False))

        # 默认主题（creative）下也验证一次：文字应为浅色，对比度达标
        print("\n=== 验证 3: 默认 creative 主题下 user 气泡文字对比度 ===")
        set_theme(page, "creative")
        page.wait_for_timeout(500)
        page.screenshot(path=f"{SCREENSHOT_DIR}/03-creative-user-bubble.png", full_page=False)

        user_bubble = page.locator(".msg-bubble.user").first
        if user_bubble.count() > 0:
            color_str = user_bubble.evaluate("el => getComputedStyle(el).color")
            text_rgb = parse_rgb(color_str)
            # creative 主题 grad-fire 起点色 #ff006e = (255, 0, 110)
            bg_rgb = (255, 0, 110)
            results.append(("creative-text-color", f"text={color_str}",
                            text_rgb is not None))
            if text_rgb:
                ratio = contrast_ratio(text_rgb, bg_rgb)
                results.append(("creative-contrast-ratio",
                                f"text={text_rgb} bg={bg_rgb} ratio={ratio:.2f}",
                                ratio >= 3.0))
                print(f"  -> 对比度 {ratio:.2f}:1")

        browser.close()

    # 汇总
    print("\n" + "=" * 60)
    passed = sum(1 for _, _, ok in results if ok)
    total = len(results)
    print(f"汇总: {passed}/{total} 通过")
    print("=" * 60)
    for name, detail, ok in results:
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}: {detail}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
