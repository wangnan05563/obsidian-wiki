"""Capture browser console + page errors during an ask, to find why persist fails."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def main():
    logs = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

        page.goto(BASE + "/")
        page.wait_for_timeout(1800)
        page.locator("input").nth(0).fill("admin")
        page.locator("input[type=password]").first.fill("admin123")
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)
        page.get_by_text("智能问答", exact=True).first.click()
        page.wait_for_timeout(2500)

        # inspect vault/auth state via DOM-eval of the running modules is hard;
        # instead capture what happens on ask
        page.locator("textarea").first.fill("CONSOLE测试 什么是AI")
        page.keyboard.press("Control+Enter")
        page.wait_for_timeout(9000)

        b.close()

    print("=== CONSOLE / ERRORS ===")
    for l in logs[-60:]:
        print(l)


if __name__ == "__main__":
    main()
