from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.goto("http://localhost:3000/")
    page.wait_for_timeout(1800)
    page.locator("input").nth(0).fill("admin")
    page.locator("input[type=password]").first.fill("admin123")
    page.get_by_text("登 录", exact=True).click()
    page.wait_for_timeout(2500)

    # click the user area
    page.locator(".nav-user").first.click()
    page.wait_for_timeout(1000)
    # what text options now appear?
    opts = page.evaluate(
        """() => Array.from(document.querySelectorAll('*')).filter(e => e.children.length === 0 && /退出|登出|切换|个人|设置/.test(e.textContent)).map(e => e.textContent.trim())"""
    )
    print("after click nav-user, logout-like texts:", opts)

    # try clicking 退出 if present
    clicked = False
    for lbl in ["退出登录", "退出", "登出"]:
        try:
            page.get_by_text(lbl, exact=False).first.click(timeout=2500)
            clicked = True
            print("clicked:", lbl)
            break
        except Exception:
            continue
    page.wait_for_timeout(2000)
    print("clicked something:", clicked)
    # is login form visible now?
    print("login form visible:", page.locator("text=请登录以继续").count() > 0)
    b.close()
