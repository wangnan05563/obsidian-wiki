"""验证【生产构建产物】的多账户会话隔离（FR-RM-06 回归）。
针对修复后的构建（:8088 静态服务 prod_20260806_080000，代理 /wiki/api -> :3000）。
场景：admin 建会话 -> 新用户注册（应看不到 admin 的）-> 新用户建会话 ->
admin 重新登录（历史必须保留、未被覆盖/改属）。
"""
import json, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8088"
ADMIN_U, ADMIN_P = "admin", "admin123"

def enter_qa(page):
    try:
        page.get_by_text("智能问答", exact=True).first.click(timeout=2500)
        page.wait_for_timeout(1500)
    except Exception:
        pass

def login(page, u, p):
    return page.evaluate("""async ([u,p]) => {
      const appEl=document.querySelector('#app');
      const pinia=appEl.__vue_app__.config.globalProperties.$pinia;
      const auth=pinia._s.get('auth'); const conv=pinia._s.get('conversations');
      const ok=await auth.login({username:u,password:p});
      if(ok&&conv) await conv.loadConversations();
      return {ok, uid: auth.user?auth.user.id:null};
    }""", [u,p])

def register(page, u, p):
    return page.evaluate("""async ([u,p]) => {
      const appEl=document.querySelector('#app');
      const pinia=appEl.__vue_app__.config.globalProperties.$pinia;
      const auth=pinia._s.get('auth'); const conv=pinia._s.get('conversations');
      const ok=await auth.register({username:u,password:p,confirmPassword:p});
      if(ok&&conv) await conv.loadConversations();
      return {ok, uid: auth.user?auth.user.id:null};
    }""", [u,p])

def logout(page):
    page.evaluate("""async () => {
      const appEl=document.querySelector('#app');
      const pinia=appEl.__vue_app__.config.globalProperties.$pinia;
      const auth=pinia._s.get('auth'); const conv=pinia._s.get('conversations');
      await auth.logout(); if(conv) conv.conversations=[];
    }""")

def create_conv(page, title):
    page.evaluate("""async (title) => {
      const appEl=document.querySelector('#app');
      const pinia=appEl.__vue_app__.config.globalProperties.$pinia;
      const conv=pinia._s.get('conversations');
      const msg={id:crypto.randomUUID(),role:'user',content:title,refs:[],createdAt:new Date().toISOString()};
      await conv.persistConversation([msg]);
    }""", title)

def raw_records(page):
    return page.evaluate("""() => new Promise(res => {
      const out=[]; const r=indexedDB.open('karpathy-wiki-chat',4);
      r.onsuccess=()=>{const db=r.result; try{
        const tx=db.transaction('conversations','readonly');
        const req=tx.objectStore('conversations').getAll();
        req.onsuccess=()=>{for(const rec of req.result){out.push({id:rec.id,ownerId:rec.ownerId||null});} res(out);};
        req.onerror=()=>res(out);
      }catch(e){res(out);}}; r.onerror=()=>res(out);
    });""")

def store_titles(page):
    return page.evaluate("""() => {
      const appEl=document.querySelector('#app');
      const pinia=appEl.__vue_app__.config.globalProperties.$pinia;
      const conv=pinia._s.get('conversations');
      return conv.conversations.map(c=>({t:c.title,o:c.ownerId||null}));
    }""")

def main():
    newuser = "auto_05563_%d" % int(time.time())
    checks = []
    with sync_playwright() as p:
        b=p.chromium.launch(); ctx=b.new_context(); page=ctx.new_page()
        page.goto(BASE+"/"); page.wait_for_timeout(2500)
        page.evaluate("""()=>new Promise(res=>{const r=indexedDB.deleteDatabase('karpathy-wiki-chat');r.onsuccess=r.onerror=r.onblocked=()=>res();});""")
        page.wait_for_timeout(800); page.reload(); page.wait_for_timeout(2500); enter_qa(page)

        login(page, ADMIN_U, ADMIN_P); enter_qa(page)
        create_conv(page, "ADMIN_SECRET")
        raw = raw_records(page)
        admin_uid = raw[0]["ownerId"] if raw else None

        logout(page); page.wait_for_timeout(800)
        register(page, newuser, "Testpass123"); enter_qa(page)
        new_before = store_titles(page)
        checks.append(("新用户注册后看不到 admin 的会话（无泄漏）", new_before == []))

        create_conv(page, "NEWUSER_CONV")
        raw2 = raw_records(page)
        # admin 记录应保持不变（owner 仍为 admin，id 不变），新用户为独立记录
        admin_rec = [r for r in raw2 if r["ownerId"] == admin_uid]
        newuser_recs = [r for r in raw2 if r["ownerId"] != admin_uid]
        checks.append(("admin 记录未被新用户覆盖/改属", len(admin_rec) == 1 and admin_rec[0]["id"] == (raw[0]["id"] if raw else None)))
        checks.append(("新用户获得独立记录（非复用 admin id）", len(newuser_recs) == 1))

        logout(page); page.wait_for_timeout(800)
        login(page, ADMIN_U, ADMIN_P); enter_qa(page)
        admin_after = store_titles(page)
        checks.append(("admin 重新登录后历史保留（未消失）", admin_after == [{"t":"ADMIN_SECRET","o":admin_uid}]))
        checks.append(("admin 看不到新用户的会话", all(c["o"] == admin_uid for c in admin_after)))

        b.close()

    print("=== 隔离回归验证（构建产物 :8088）===")
    allpass = True
    for name, ok in checks:
        print(("  PASS " if ok else "  FAIL ") + name)
        allpass = allpass and ok
    print("RESULT:", "ALL PASS" if allpass else "FAILED")
    print(json.dumps({"newuser": newuser, "raw_after_admin": raw, "raw_after_newuser_create": raw2, "admin_after": admin_after}, ensure_ascii=False))

if __name__ == "__main__":
    main()
