"""Diagnostic: capture authStore.user.id and which ownerId gets written,
in the REAL browser, to explain why isolation leaks despite strict filter."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def login(page, username, password):
    page.goto(BASE + "/")
    page.wait_for_timeout(1800)
    if page.locator("text=请登录以继续").count() > 0:
        page.locator("input").nth(0).fill(username)
        page.locator("input[type=password]").first.fill(password)
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)


def get_auth_id(page):
    return page.evaluate(
        """() => {
          // pinia store is on window? try to find via __pinia
          const pinia = window.__pinia || (window.app && window.app.config && window.app.config.globalProperties && window.app.config.globalProperties.$pinia);
          if (!pinia) return 'NO_PINIA';
          const auth = pinia._s && pinia._s.get('auth');
          return auth && auth.user ? (auth.user.id || 'NO_ID') : 'USER_NULL';
        }"""
    )


def go_qa(page):
    page.get_by_text("智能问答", exact=True).first.click()
    page.wait_for_timeout(2000)


def ask(page, q):
    page.locator("textarea").first.fill(q)
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(6000)


def dump_db(page):
    return page.evaluate(
        """() => new Promise((resolve) => {
          const open = indexedDB.open('karpathy-wiki-chat', 4);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('conversations', 'readonly');
            const req = tx.objectStore('conversations').getAll();
            req.onsuccess = () => resolve((req.result||[]).map(r => ({t:(r.title||'').slice(0,16), owner: r.ownerId||'UNDEF', enc:r._enc===1})));
            req.onerror = () => resolve(['ERR']);
          };
          open.onerror = () => resolve(['OPEN_ERR']);
        })"""
    )


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        login(page, "admin", "admin123")
        out["admin_auth_id"] = get_auth_id(page)
        go_qa(page)
        ask(page, "DIAG admin 问题")
        out["admin_db_after_ask"] = dump_db(page)
        out["admin_auth_id_after"] = get_auth_id(page)
        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
