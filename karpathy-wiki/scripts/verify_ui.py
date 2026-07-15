"""Playwright UI 验证：测试 3 个 UI 需求
1. 顶部菜单收起后完全隐藏（浮动按钮出现）
2. Query 页面全屏自适应
3. textarea 下方不留白
"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto("http://localhost:5173/", wait_until="networkidle")
    time.sleep(1)

    # 切换到 Query 页面
    page.get_by_role("button", name="知识问答").click()
    time.sleep(0.5)
    page.screenshot(path="query_initial.png", full_page=False)

    # 检查 1：textarea 高度
    ta = page.locator(".input-area .el-textarea__inner")
    box = ta.bounding_box()
    print(f"[需求3] textarea 高度 = {box['height']:.1f}px (期望 < 40px)")

    # 检查 2：input-area 整体高度
    ia = page.locator(".input-area").bounding_box()
    print(f"[需求3] .input-area 高度 = {ia['height']:.1f}px (期望 < 90px)")

    # 检查 2：query-card 高度
    qc = page.locator(".query-card").bounding_box()
    print(f"[需求2] .query-card 高度 = {qc['height']:.1f}px (期望 ~860px 接近视口)")

    # 检查 2：query-page 高度
    qp = page.locator(".query-page").bounding_box()
    print(f"[需求2] .query-page 高度 = {qp['height']:.1f}px (期望 ~860px)")

    # 检查 1：顶部菜单是否可见
    nav = page.locator(".nav").count()
    print(f"[需求1] 顶部菜单元素数 = {nav} (展开时=1)")

    # 点击折叠按钮
    page.locator(".nav-toggle").click()
    time.sleep(0.5)
    page.screenshot(path="query_nav_collapsed.png", full_page=False)

    nav_after = page.locator(".nav").count()
    fab_after = page.locator(".nav-toggle-fab").count()
    print(f"[需求1] 折叠后 nav 元素数 = {nav_after} (期望 0)")
    print(f"[需求1] 折叠后 fab 元素数 = {fab_after} (期望 1)")

    # 折叠后 query-card 应该占据更大空间
    qc2 = page.locator(".query-card").bounding_box()
    print(f"[需求2] 折叠后 .query-card 高度 = {qc2['height']:.1f}px")

    # 折叠后 textarea 区域重新测量
    ta2 = page.locator(".input-area .el-textarea__inner").bounding_box()
    print(f"[需求3] 折叠后 textarea 高度 = {ta2['height']:.1f}px")

    browser.close()
    print("\n=== 截图保存 ===")
    print("query_initial.png        - Query 页面 nav 展开")
    print("query_nav_collapsed.png  - Query 页面 nav 折叠")
