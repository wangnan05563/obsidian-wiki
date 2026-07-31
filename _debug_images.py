# -*- coding: utf-8 -*-
"""调试脚本：捕获页面所有 404 资源加载错误"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page()

    failed_requests = []
    all_requests = []

    def on_response(resp):
        all_requests.append((resp.status, resp.url))
        if resp.status >= 400:
            failed_requests.append((resp.status, resp.url))

    pg.on("response", on_response)

    pg.goto('http://localhost:5173', wait_until='networkidle', timeout=30000)
    pg.wait_for_timeout(3000)

    print("=== Failed requests (4xx/5xx) ===")
    for status, url in failed_requests:
        print(f"  [{status}] {url}")

    print(f"\n=== Total requests: {len(all_requests)}, Failed: {len(failed_requests)} ===")

    # 登录后再检查 dashboard
    pg.locator("input[type='text']").first.fill("admin")
    pg.locator("input[type='password']").first.fill("admin123")
    pg.locator(".login-btn").first.click()
    pg.wait_for_timeout(3000)

    print("\n=== After login - Failed requests ===")
    failed_after = []
    pg.on("response", lambda r: failed_after.append((r.status, r.url)) if r.status >= 400 else None)

    # 访问各页面
    for label in ["仪表盘", "投递资料", "知识浏览", "知识问答", "图谱", "体检", "配置", "帮助文档", "关于"]:
        btn = pg.locator(f'.tab-btn:has-text("{label}")')
        if btn.count() > 0 and not btn.first.is_disabled():
            btn.first.click()
            pg.wait_for_timeout(1500)

    # 去重
    unique_failed = list(set(failed_after))
    for status, url in unique_failed:
        print(f"  [{status}] {url}")

    print(f"\n=== Total failed after login: {len(unique_failed)} ===")

    pg.screenshot(path="debug_dashboard.png")
    b.close()
