"""Definitive multi-account isolation via the LIVE auth store (bypass missing UI logout).
Drives real code: login admin -> ask -> login user (direct store call) -> ask ->
reload each -> read conversations.conversations straight from Pinia.
Verifies the real filterByOwner with real auth.user.id switching."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def get_pinia(page):
    return page.evaluate(
        """() => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          return appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
        }"""
    )


def read(page):
    return page.evaluate(
        """() => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
          const auth = pinia._s.get('auth');
          const conv = pinia._s.get('conversations');
          return {
            uname: auth.user ? auth.user.username : 'NULL',
            uid: auth.user ? auth.user.id.slice(0,8) : 'NULL',
            convs: conv.conversations.map(c => ({t:(c.title||'').slice(0,14), o:(c.ownerId||'UNDEF').slice(0,8)}))
          };
        }"""
    )


def direct_login(page, username, password):
    return page.evaluate(
        """async ([u,p]) => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
          const auth = pinia._s.get('auth');
          const ok = await auth.login({username:u, password:p});
          return {ok, uname: auth.user ? auth.user.username : 'NULL'};
        }""",
        [username, password],
    )


def go_qa(page):
    page.goto(BASE + "/")
    page.wait_for_timeout(1500)
    try:
        page.get_by_text("智能问答", exact=True).first.click(timeout=5000)
    except Exception:
        pass
    page.wait_for_timeout(2500)


def ask(page, q, wait=22000):
    page.locator("textarea").first.fill(q)
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(wait)


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.goto(BASE + "/")
        page.wait_for_timeout(1800)
        # login admin via UI
        page.locator("input").nth(0).fill("admin")
        page.locator("input[type=password]").first.fill("admin123")
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)
        go_qa(page)
        ask(page, "ADMIN_REAL 什么是Transformer")
        page.wait_for_timeout(2000)
        out["admin_after_ask"] = read(page)

        # switch to user via direct store login (bypass UI logout)
        r = direct_login(page, "user", "user123")
        out["switch_to_user"] = r
        page.wait_for_timeout(2000)
        out["after_switch_auth"] = read(page)
        go_qa(page)
        ask(page, "USER_REAL 什么是注意力机制")
        page.wait_for_timeout(2000)
        out["user_after_ask"] = read(page)

        # reload as user (forces loadConversations+filter with user id)
        page.goto(BASE + "/")
        page.wait_for_timeout(1500)
        # after reload, must login again (token persisted? try direct login)
        r2 = direct_login(page, "user", "user123")
        page.wait_for_timeout(2000)
        go_qa(page)
        out["user_reload"] = read(page)

        # reload as admin
        page.goto(BASE + "/")
        page.wait_for_timeout(1500)
        direct_login(page, "admin", "admin123")
        page.wait_for_timeout(2000)
        go_qa(page)
        out["admin_reload"] = read(page)

        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
