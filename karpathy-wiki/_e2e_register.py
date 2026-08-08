"""Registration-path isolation test (the ORIGINAL reported bug):
a newly REGISTERED user creates conversations; verify admin does NOT see them,
and the new user does NOT see admin's pre-existing conversations.
Real browser, live source, shared per-origin IndexedDB."""
import json, time, random
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173"

def enter_qa(page):
    page.evaluate("""() => {
      const appEl = document.querySelector('#app');
      const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
      for (const s of ['auth','conversations','query']) { try { pinia._s.get(s); } catch(e){} }
    }""")
    try:
        page.get_by_text("智能问答", exact=True).first.click(timeout=2500)
        page.wait_for_timeout(1500)
    except Exception:
        pass

def read_state(page):
    return page.evaluate("""() => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth');
      const conv = pinia._s.get('conversations');
      return { uid: auth.user?auth.user.id:null,
               uname: auth.user?auth.user.username:null,
               convs: conv?conv.conversations.map(c=>({t:c.title,o:c.ownerId||null})):null };
    }""")

def store_login(page, u, p):
    return page.evaluate("""async ([u,p]) => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth'); const conv = pinia._s.get('conversations');
      const ok = await auth.login({username:u,password:p});
      if (ok && conv) await conv.loadConversations();
      return {ok, uid: auth.user?auth.user.id:null};
    }""", [u,p])

def register(page, u, p):
    return page.evaluate("""async ([u,p]) => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth'); const conv = pinia._s.get('conversations');
      const ok = await auth.register({username:u,password:p,confirmPassword:p});
      if (ok && conv) await conv.loadConversations();
      return {ok, uid: auth.user?auth.user.id:null};
    }""", [u,p])

def logout(page):
    page.evaluate("""async () => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth'); const conv = pinia._s.get('conversations');
      await auth.logout(); if (conv) conv.conversations=[];
    }""")

def create_conv(page, title):
    return page.evaluate("""async (title) => {
      const appEl = document.querySelector('#app');
      const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      const conv = pinia._s.get('conversations');
      const msg = {id:crypto.randomUUID(),role:'user',content:title,refs:[],createdAt:new Date().toISOString()};
      await conv.persistConversation([msg]);
      return conv.conversations.map(c=>({t:c.title,o:c.ownerId||null}));
    }""", title)

def main():
    out = {}
    newuser = "auto_05563_%d" % int(time.time())
    newpass = "Testpass123"
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(); page = ctx.new_page()
        page.goto(BASE + "/"); page.wait_for_timeout(2500)
        page.evaluate("""() => new Promise(res => { const r=indexedDB.deleteDatabase('karpathy-wiki-chat'); r.onsuccess=r.onerror=r.onblocked=()=>res(); });""")
        page.wait_for_timeout(800); page.reload(); page.wait_for_timeout(2500); enter_qa(page)

        # admin creates first
        out["admin_login"] = store_login(page, "admin", "admin123"); enter_qa(page)
        out["admin_create"] = create_conv(page, "ADMIN_PRE_EXISTING")

        # newly registered user 05563
        logout(page); page.wait_for_timeout(800)
        out["reg"] = register(page, newuser, newpass); enter_qa(page)
        out["newuser_before"] = read_state(page)["convs"]   # must NOT see ADMIN_PRE_EXISTING
        out["newuser_create"] = create_conv(page, "NEWUSER_05563_CONV")
        out["newuser_after"] = read_state(page)["convs"]

        # admin logs back in — must NOT see NEWUSER_05563_CONV
        logout(page); page.wait_for_timeout(800)
        out["admin_login2"] = store_login(page, "admin", "admin123"); enter_qa(page)
        out["admin_after"] = read_state(page)["convs"]

        out["newuser_name"] = newuser
        b.close()
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
