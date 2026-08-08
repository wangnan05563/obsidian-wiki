"""Read the live Pinia store directly via the Vue app instance."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.goto(BASE + "/")
        page.wait_for_timeout(1800)
        page.locator("input").nth(0).fill("admin")
        page.locator("input[type=password]").first.fill("admin123")
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)
        page.get_by_text("智能问答", exact=True).first.click()
        page.wait_for_timeout(2500)

        # Read pinia stores live
        snap = page.evaluate(
            """() => {
              const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
              const vueApp = appEl && (appEl.__vue_app__);
              const pinia = vueApp && vueApp.config && vueApp.config.globalProperties && vueApp.config.globalProperties.$pinia;
              if (!pinia) return {err:'no pinia', keys: vueApp?Object.keys(vueApp):null};
              const auth = pinia._s.get('auth');
              const conv = pinia._s.get('conversations');
              return {
                authUserId: auth && auth.user ? auth.user.id : 'NULL',
                authUserName: auth && auth.user ? auth.user.username : 'NULL',
                isLoggedIn: auth && auth.isLoggedIn,
                convCount: conv ? conv.conversations.length : 'NO_CONV',
                convTitles: conv ? conv.conversations.map(c=>({t:(c.title||'').slice(0,14), owner:(c.ownerId||'UNDEF').slice(0,8)})) : []
              };
            }"""
        )
        out["admin_snapshot"] = snap

        # now ask
        page.locator("textarea").first.fill("STORE测试 什么是深度学习")
        page.keyboard.press("Control+Enter")
        page.wait_for_timeout(9000)

        snap2 = page.evaluate(
            """() => {
              const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
              const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
              const auth = pinia._s.get('auth');
              const conv = pinia._s.get('conversations');
              return {
                authUserId: auth && auth.user ? auth.user.id : 'NULL',
                convCount: conv ? conv.conversations.length : 'NO_CONV',
                convTitles: conv ? conv.conversations.map(c=>({t:(c.title||'').slice(0,14), owner:(c.ownerId||'UNDEF').slice(0,8)})) : []
              };
            }"""
        )
        out["admin_after_ask_snapshot"] = snap2
        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
