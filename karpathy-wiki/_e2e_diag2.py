"""Forensic: inspect the RAW IndexedDB records across the account round-trip.
Determines whether admin's record is (a) destroyed/overwritten, (b) re-encrypted
under the wrong key, or (c) just failing to decrypt on re-login."""
import json, time
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
    except Exception: pass

def raw_records(page):
    return page.evaluate("""() => new Promise(res => {
      const out = [];
      const r = indexedDB.open('karpathy-wiki-chat', 4);
      r.onsuccess = () => {
        const db = r.result;
        try {
          const tx = db.transaction('conversations','readonly');
          const req = tx.objectStore('conversations').getAll();
          req.onsuccess = () => {
            for (const rec of req.result) {
              out.push({ id: rec.id, ownerId: rec.ownerId||null, _enc: rec._enc||0, hasCt: !!(rec.ct), keys: Object.keys(rec).filter(k=>!['messages','preview'].includes(k)) });
            }
            res(out);
          };
          req.onerror = () => res(out);
        } catch(e){ res(out); }
      };
      r.onerror = () => res(out);
    });""")

def login(page, u, p):
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
    }""", title)

def main():
    out = {}
    newuser = "auto_05563_%d" % int(time.time())
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(); page = ctx.new_page()
        page.goto(BASE + "/"); page.wait_for_timeout(2500)
        page.evaluate("""() => new Promise(res => { const r=indexedDB.deleteDatabase('karpathy-wiki-chat'); r.onsuccess=r.onerror=r.onblocked=()=>res(); });""")
        page.wait_for_timeout(800); page.reload(); page.wait_for_timeout(2500); enter_qa(page)

        login(page, "admin", "admin123"); enter_qa(page)
        create_conv(page, "ADMIN_PRE_EXISTING")
        out["raw_after_admin_create"] = raw_records(page)

        logout(page); page.wait_for_timeout(800)
        register(page, newuser, "Testpass123"); enter_qa(page)
        out["raw_after_newuser_register"] = raw_records(page)
        create_conv(page, "NEWUSER_CONV")
        out["raw_after_newuser_create"] = raw_records(page)

        logout(page); page.wait_for_timeout(800)
        login(page, "admin", "admin123"); enter_qa(page)
        out["raw_after_admin_relink"] = raw_records(page)
        out["admin_store"] = page.evaluate("""() => {
          const appEl=document.querySelector('#app');
          const pinia=appEl.__vue_app__.config.globalProperties.$pinia;
          const conv=pinia._s.get('conversations');
          return conv.conversations.map(c=>({t:c.title,o:c.ownerId||null}));
        }""")

        out["newuser_name"] = newuser
        b.close()
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
