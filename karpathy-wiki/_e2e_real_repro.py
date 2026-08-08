"""Real-browser isolation reproduction against the LIVE source (dev :5173).
Drives the real auth + localVault (AES-GCM) + chatDb + conversations store.
Enters the QA view so the Pinia conversations store is mounted, then uses
store methods directly (reliable, no fragile DOM clicks for logout).
Scenario: SAME browser origin, account A creates conv -> logout -> account B logs in.
Reads conversations.conversations straight from the store after loadConversations.
"""
import json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173"
API = BASE + "/wiki/api"

def enter_qa(page):
    # ensure conversations store is mounted by entering the QA view
    page.evaluate("""() => {
      const appEl = document.querySelector('#app');
      const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
      // force instantiate stores via the registered factories
      const stores = ['auth','conversations','query'];
      for (const s of stores) { try { pinia._s.get(s); } catch(e){} }
    }""")
    # click into QA if a 智能问答 button exists
    try:
        page.get_by_text("智能问答", exact=True).first.click(timeout=2500)
        page.wait_for_timeout(2000)
    except Exception:
        pass

def read_state(page):
    return page.evaluate("""() => {
      const appEl = document.querySelector('#app');
      const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth');
      const conv = pinia._s.get('conversations');
      return {
        uid: auth && auth.user ? auth.user.id : null,
        username: auth && auth.user ? auth.user.username : null,
        convs: conv ? conv.conversations.map(c=>({t:c.title, o:c.ownerId||null})) : null,
        localLocked: conv ? conv.localLocked : null
      };
    }""")

def store_login(page, username, password):
    return page.evaluate("""async ([u,p]) => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth');
      const conv = pinia._s.get('conversations');
      const ok = await auth.login({username:u, password:p});
      if (ok && conv) { await conv.loadConversations(); }
      return {ok, uid: auth.user && auth.user.id};
    }""", [username, password])

def store_logout(page):
    return page.evaluate("""async () => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth');
      const conv = pinia._s.get('conversations');
      await auth.logout();
      if (conv) conv.conversations = [];
      return {uid: auth.user ? auth.user.id : null};
    }""")

def store_create_conv(page, title):
    return page.evaluate("""async (title) => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const conv = pinia._s.get('conversations');
      const msg = { id: crypto.randomUUID(), role:'user', content:title, refs:[], createdAt:new Date().toISOString() };
      await conv.persistConversation([msg]);
      return conv.conversations.map(c=>({t:c.title, o:c.ownerId||null}));
    }""", title)

def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context()
        page = ctx.new_page()
        page.goto(BASE + "/")
        page.wait_for_timeout(2500)

        # ensure clean slate
        page.evaluate("""() => new Promise(res => { const r = indexedDB.deleteDatabase('karpathy-wiki-chat'); r.onsuccess=r.onerror=r.onblocked=()=>res(); });""")
        page.wait_for_timeout(800)
        page.reload(); page.wait_for_timeout(2500)
        enter_qa(page)

        # --- Account A (admin) ---
        r = store_login(page, "admin", "admin123")
        out["A_login"] = r
        enter_qa(page)
        out["A_after_create"] = store_create_conv(page, "ADMIN_SECRET_CONV")

        # --- Account B (user) in SAME browser/origin ---
        store_logout(page)
        page.wait_for_timeout(800)
        r = store_login(page, "user", "user123")
        out["B_login"] = r
        enter_qa(page)
        out["B_before_create"] = read_state(page)["convs"]   # must NOT contain ADMIN_SECRET_CONV
        out["B_after_create"] = store_create_conv(page, "USER_SECRET_CONV")

        # --- Reload as B (re-runs loadConversations from persisted IndexedDB) ---
        page.reload(); page.wait_for_timeout(800)
        page.wait_for_timeout(2500)
        enter_qa(page)
        st = read_state(page)
        if not st["uid"]:
            store_login(page, "user", "user123"); enter_qa(page)
        out["B_after_reload"] = read_state(page)["convs"]

        # --- Back to A, must NOT see B's ---
        store_logout(page)
        page.wait_for_timeout(800)
        store_login(page, "admin", "admin123")
        enter_qa(page)
        out["A_after_switchback"] = read_state(page)["convs"]

        b.close()
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
