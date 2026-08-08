"""Definitive isolation test: navigate to Q&A (mounts conversations store),
then drive REAL store methods directly. Switches accounts via real auth store.
Runs against the LIVE served build (http://localhost:3000)."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def goto_qa(page):
    page.goto(BASE + "/")
    page.wait_for_timeout(1500)
    try:
        page.get_by_text("智能问答", exact=True).first.click(timeout=5000)
    except Exception:
        pass
    page.wait_for_timeout(2500)


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
            convs: conv ? conv.conversations.map(c => ({t:(c.title||'').slice(0,14), o:(c.ownerId||'UNDEF').slice(0,8)})) : 'NO_CONV_STORE'
          };
        }"""
    )


def ui_login(page, username, password):
    page.goto(BASE + "/")
    page.wait_for_timeout(1800)
    if page.locator("text=请登录以继续").count() > 0:
        page.locator("input").nth(0).fill(username)
        page.locator("input[type=password]").first.fill(password)
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)


def direct_login(page, username, password):
    return page.evaluate(
        """async ([u,p]) => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
          const auth = pinia._s.get('auth');
          const ok = await auth.login({username:u, password:p});
          return {ok, uname: auth.user ? auth.user.username : 'NULL', uid: auth.user ? auth.user.id.slice(0,8):'NULL'};
        }""",
        [username, password],
    )


def direct_persist(page, marker):
    return page.evaluate(
        """async (marker) => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
          const conv = pinia._s.get('conversations');
          const msg = { id: crypto.randomUUID(), role:'user', content: marker+' 测试问题', refs:[], createdAt: new Date().toISOString() };
          await conv.persistConversation([msg]);
          return true;
        }""",
        marker,
    )


def direct_load(page):
    return page.evaluate(
        """async () => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
          const conv = pinia._s.get('conversations');
          await conv.loadConversations();
          return conv.conversations.map(c => ({t:(c.title||'').slice(0,14), o:(c.ownerId||'UNDEF').slice(0,8)}));
        }"""
    )


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()

        # ADMIN: login + go to Q&A (mounts conversations store)
        ui_login(page, "admin", "admin123")
        goto_qa(page)
        out["admin_before"] = read(page)
        direct_persist(page, "ADMIN")
        page.wait_for_timeout(1000)
        out["admin_after_persist"] = read(page)

        # Switch to USER (real auth store login), stay on Q&A
        out["switch_user"] = direct_login(page, "user", "user123")
        page.wait_for_timeout(1000)
        out["user_after_switch_load"] = direct_load(page)
        out["user_read"] = read(page)

        # USER persists its own
        direct_persist(page, "USER")
        page.wait_for_timeout(1000)
        out["user_after_persist"] = read(page)

        # Switch back to ADMIN
        out["switch_admin"] = direct_login(page, "admin", "admin123")
        page.wait_for_timeout(1000)
        out["admin_after_switch_load"] = direct_load(page)

        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
