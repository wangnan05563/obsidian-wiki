"""DEFINITIVE isolation test: direct store read after reload, long waits, two accounts
switching in the SAME browser (shared IndexedDB). Reads conversations.conversations
straight from the Pinia store — no DOM ambiguity."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def read_store(page):
    return page.evaluate(
        """() => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
          const auth = pinia._s.get('auth');
          const conv = pinia._s.get('conversations');
          return {
            uid: auth && auth.user ? auth.user.id.slice(0,8) : 'NULL',
            convs: conv ? conv.conversations.map(c=>({t:(c.title||'').slice(0,16), o:(c.ownerId||'UNDEF').slice(0,8)})) : []
          };
        }"""
    )


def login(page, username, password):
    page.goto(BASE + "/")
    page.wait_for_timeout(1800)
    if page.locator("text=请登录以继续").count() > 0:
        page.locator("input").nth(0).fill(username)
        page.locator("input[type=password]").first.fill(password)
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)


def go_qa(page):
    page.wait_for_timeout(1200)
    page.get_by_text("智能问答", exact=True).first.click()
    page.wait_for_timeout(2500)


def ask_and_wait(page, q, wait=22000):
    page.locator("textarea").first.fill(q)
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(wait)


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()

        # ADMIN asks
        login(page, "admin", "admin123")
        go_qa(page)
        ask_and_wait(page, "ADMIN_Q 什么是卷积神经网络")
        page.wait_for_timeout(2000)
        out["admin_store_after_ask"] = read_store(page)

        # reload as admin (forces loadConversations+filter)
        page.goto(BASE + "/")
        page.wait_for_timeout(1500)
        page.get_by_text("智能问答", exact=True).first.click()
        page.wait_for_timeout(3000)
        out["admin_store_reload"] = read_store(page)

        # switch to USER (same browser) — logout then login user
        # click user chip to logout
        try:
            page.locator(".user-chip, header .el-dropdown, [class*=avatar]").first.click(timeout=3000)
            page.wait_for_timeout(500)
        except Exception:
            pass
        for lbl in ["退出登录", "退出", "登出"]:
            try:
                page.get_by_text(lbl).first.click(timeout=2500); page.wait_for_timeout(2000); break
            except Exception: continue

        login(page, "user", "user123")
        go_qa(page)
        ask_and_wait(page, "USER_Q 什么是反向传播")
        page.wait_for_timeout(2000)
        out["user_store_after_ask"] = read_store(page)

        # reload as user
        page.goto(BASE + "/")
        page.wait_for_timeout(1500)
        page.get_by_text("智能问答", exact=True).first.click()
        page.wait_for_timeout(3000)
        out["user_store_reload"] = read_store(page)

        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
