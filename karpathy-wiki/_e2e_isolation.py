"""Ground-truth E2E against the running wiki app on :3000.

Drives the REAL app in Chromium (real Web Crypto + real IndexedDB), switching
between the pre-seeded 'admin' and 'user' accounts in the SAME browser context
(= same per-origin IndexedDB, exactly the reported multi-account scenario).

After each account creates a conversation we DUMP the real IndexedDB
'karpathy-wiki-chat' / 'conversations' store (ownerId + title) AND read the
sidebar (.conversation-list) the user actually sees. This tells us:
  - whether records get distinct ownerId, or all undefined / all identical
  - whether the sidebar list leaks the other account's conversations
"""
import json
import sys
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


def logout(page):
    # click the user chip (shows username), then logout option
    try:
        page.locator(".user-chip, [class*=user-menu], header").first.click(timeout=3000)
        page.wait_for_timeout(600)
    except Exception:
        pass
    for label in ["退出登录", "退出", "登出", "Logout"]:
        try:
            page.get_by_text(label, exact=False).first.click(timeout=2500)
            page.wait_for_timeout(2000)
            return
        except Exception:
            continue


def go_qa(page):
    page.get_by_text("智能问答", exact=True).first.click()
    page.wait_for_timeout(2000)


def ask(page, question):
    page.locator("textarea").first.fill(question)
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(6000)  # wait for answer + persist


def dump_db(page):
    return page.evaluate(
        """() => new Promise((resolve) => {
          const open = indexedDB.open('karpathy-wiki-chat', 4);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('conversations', 'readonly');
            const req = tx.objectStore('conversations').getAll();
            req.onsuccess = () => {
              const rows = (req.result || []).map(r => ({
                title: (r.title || '').slice(0, 24),
                ownerId: r.ownerId === undefined ? 'UNDEFINED' : (r.ownerId || 'NULL'),
                enc: (r._enc === 1)
              }));
              resolve(rows);
            };
            req.onerror = () => resolve(['ERR']);
          };
          open.onerror = () => resolve(['OPEN_ERR']);
        })"""
    )


def sidebar_titles(page):
    page.wait_for_timeout(1500)
    items = page.locator(".conversation-list .conversation-item, .conversation-list [class*=item]").all_inner_texts()
    return [t.strip()[:24] for t in items if t.strip()]


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context()
        page = ctx.new_page()

        # ===== ADMIN creates a conversation =====
        login(page, "admin", "admin123")
        go_qa(page)
        ask(page, "ADMIN专用测试问题 神经网络是什么")
        out["admin_db"] = dump_db(page)
        out["admin_sidebar"] = sidebar_titles(page)
        logout(page)

        # ===== USER creates a conversation (same browser/IndexedDB) =====
        login(page, "user", "user123")
        go_qa(page)
        ask(page, "USER专用测试问题 梯度下降是什么")
        out["user_db"] = dump_db(page)
        out["user_sidebar"] = sidebar_titles(page)
        logout(page)

        # ===== ADMIN logs back in: should see ONLY admin's =====
        login(page, "admin", "admin123")
        go_qa(page)
        out["admin_relaunch_sidebar"] = sidebar_titles(page)
        logout(page)

        # ===== USER logs back in: should see ONLY user's =====
        login(page, "user", "user123")
        go_qa(page)
        out["user_relaunch_sidebar"] = sidebar_titles(page)

        b.close()

    print(json.dumps(out, ensure_ascii=False, indent=2))

    # assertions on the relaunch sidebars
    a_back = " ".join(out.get("admin_relaunch_sidebar", []))
    u_back = " ".join(out.get("user_relaunch_sidebar", []))
    leak_a = "USER专用" in a_back
    leak_u = "ADMIN专用" in u_back
    a_own = "ADMIN专用" in a_back
    u_own = "USER专用" in u_back

    print("\n=== ISOLATION GROUND TRUTH ===")
    print("admin sees own:", a_own, "| user sees own:", u_own)
    print("admin LEAKS user (BUG):", leak_a, "| user LEAKS admin (BUG):", leak_u)
    # also report ownerId distribution in DB
    db_undef = sum(1 for r in out.get("user_db", []) if r.get("ownerId") == "UNDEFINED")
    print("records with ownerId=UNDEFINED in DB (after both wrote):", db_undef)
    if leak_a or leak_u:
        print("RESULT: BUG REPRODUCED")
        sys.exit(2)
    else:
        print("RESULT: ISOLATION OK")


if __name__ == "__main__":
    main()
