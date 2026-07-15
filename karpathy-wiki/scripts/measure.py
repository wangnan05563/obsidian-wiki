"""测量 nav 溢出 + chat-body 滚动问题"""
from playwright.sync_api import sync_playwright
import time

VIEWPORTS = [(1440, 900), (1280, 800), (1366, 768)]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    for vw, vh in VIEWPORTS:
        page = browser.new_page(viewport={"width": vw, "height": vh})
        page.goto("http://localhost:5173/", wait_until="networkidle")
        time.sleep(0.5)

        # 切到 Query
        page.get_by_role("button", name="知识问答").click()
        time.sleep(0.3)

        print(f"\n========== 视口 {vw}x{vh} ==========")
        nav = page.locator(".nav").bounding_box()
        nav_left = page.locator(".nav-left").bounding_box()
        title = page.locator(".nav-title-wrap").bounding_box()
        nav_tabs = page.locator(".nav-tabs").bounding_box()
        print(f"  .nav         = x={nav['x']:.0f} w={nav['width']:.0f} h={nav['height']:.0f}")
        print(f"  .nav-left    = x={nav_left['x']:.0f} w={nav_left['width']:.0f}")
        print(f"  .nav-title   = x={title['x']:.0f} w={title['width']:.0f}")
        print(f"  .nav-tabs    = x={nav_tabs['x']:.0f} w={nav_tabs['width']:.0f}")

        # nav 内部 padding 边界
        nav_left_inner = nav['x'] + 28
        print(f"  nav 内左 padding 边界 = {nav_left_inner:.0f}, nav-left 起点 {nav_left['x']:.0f}")
        if nav_left['x'] < nav_left_inner - 2:
            print(f"  ❌ nav-left 起点早于 padding 边界，被遮挡")
        if title['x'] + title['width'] > nav['x'] + nav['width'] - 28:
            print(f"  ❌ 标题溢出 nav 右 padding")

        # 模拟长内容测试 chat-body 滚动
        cb = page.locator(".chat-body").bounding_box()
        print(f"  .chat-body 高度 = {cb['height']:.0f}, scrollTop={page.evaluate('document.querySelector(\".chat-body\").scrollTop')}")
        page.close()

    browser.close()

