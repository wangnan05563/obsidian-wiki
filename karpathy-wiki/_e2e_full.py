"""Refined ground-truth E2E: full DB dump + forced reload per account."""
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


def go_qa(page):
    page.wait_for_timeout(1500)
    page.get_by_text("智能问答", exact=True).first.click()
    page.wait_for_timeout(2500)


def ask(page, q, wait=9000):
    page.locator("textarea").first.fill(q)
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(wait)


def dump_db(page):
    return page.evaluate(
        """() => new Promise((resolve) => {
          const open = indexedDB.open('karpathy-wiki-chat', 4);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('conversations', 'readonly');
            const req = tx.objectStore('conversations').getAll();
            req.onsuccess = () => resolve((req.result||[]).map(r => ({id:(r.id||'').slice(0,8), title:(r.title||'').slice(0,14), owner:(r.ownerId||'UNDEF').slice(0,8), enc:r._enc===1})));
            req.onerror = () => resolve(['ERR']);
          };
          open.onerror = () => resolve(['OPEN_ERR']);
        })"""
    )


def sidebar_titles(page):
    page.wait_for_timeout(1500)
    items = page.locator(".conversation-list [class*=item]").all_inner_texts()
    return [t.strip()[:20] for t in items if t.strip()]


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()

        # ADMIN: fresh reload to force loadConversations
        login(page, "admin", "admin123")
        go_qa(page)
        out["admin_before_ask_sidebar"] = sidebar_titles(page)
        ask(page, "ADMIN_Q1 神经网络定义")
        out["admin_after_ask_db"] = dump_db(page)
        out["admin_after_ask_sidebar"] = sidebar_titles(page)

        # reload as admin again (forces loadConversations with filter)
        page.goto(BASE + "/")
        page.wait_for_timeout(1500)
        page.get_by_text("智能问答", exact=True).first.click()
        page.wait_for_timeout(2500)
        out["admin_reload_sidebar"] = sidebar_titles(page)
        out["admin_reload_db"] = dump_db(page)

        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
