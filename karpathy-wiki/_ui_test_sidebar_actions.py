# -*- coding: utf-8 -*-
"""
会话历史栏操作图标的 UI 自动化测试（「...」更多操作菜单 + 直显置顶/删除）。

对应需求：保留「置顶」（pin-conversation）与「删除」（delete-conversation）为直显图标，
将「重命名」（rename-conversation）/「复制会话」（copy-conversation）/「会话导出」（export-conversation）
收进「更多操作」（more-actions, ...）悬浮菜单，点击展开点选。

运行前提（在可访问浏览器与已部署前端的环境，例如用户本机执行 /wiki-auto-testing）：
  1. 已安装 Playwright 浏览器：python -m playwright install chromium
  2. 前端 dev server（默认 http://localhost:5173）或生产构建可访问
  3. 后端（默认 http://localhost:3000）可访问（登录用）

本脚本针对「会话历史栏操作图标增强」这一独立功能做聚焦验证，不依赖 LLM 问答链路：
会话数据直接写入浏览器 IndexedDB（karpathy-wiki-chat / conversations），
绕过「发送问题→SSE 生成回答」这一需要真实 LLM 的环节。

用法：
  python _ui_test_sidebar_actions.py
  BASE=http://localhost:5173 USER=admin PASS=admin123 python _ui_test_sidebar_actions.py
"""
import os
import sys
import json
import time

BASE = os.environ.get("BASE", "http://localhost:5173").rstrip("/")
API = os.environ.get("API", "http://localhost:3000").rstrip("/")
USER = os.environ.get("USER", "admin")
PASS = os.environ.get("PASS", "admin123")

# 浏览器启动参数：遵循 wiki-auto-testing headless_crash_guard（必须 --disable-gpu 等）
LAUNCH_ARGS = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-software-rasterizer",
]

passed = 0
failed = 0
failures = []


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        failures.append(f"{name} :: {detail}")
        print(f"  [FAIL] {name} :: {detail}")


def seed_conversations(page, owner_id):
    """直接写入 IndexedDB 两条会话，ownerId 与当前登录用户一致，确保侧栏可见。"""
    page.evaluate(
        """async (ownerId) => {
            const DB_NAME = 'karpathy-wiki-chat';
            const DB_VERSION = 4;
            const open = indexedDB.open(DB_NAME, DB_VERSION);
            await new Promise((res, rej) => {
                open.onsuccess = () => res();
                open.onerror = () => rej(open.error);
            });
            const db = open.result;
            const tx = db.transaction('conversations', 'readwrite');
            const store = tx.objectStore('conversations');
            const now = new Date().toISOString();
            const mk = (id, title, ageMs) => ({
                id, title,
                createdAt: now,
                updatedAt: new Date(Date.now() - ageMs).toISOString(),
                messageCount: 2, isPinned: false, preview: 'preview',
                messages: [
                    { id: id + '-m1', role: 'user', content: '测试问题 ' + title, createdAt: now },
                    { id: id + '-m2', role: 'assistant', content: '测试回答 ' + title, createdAt: now }
                ],
                threadId: 'thread-' + id, ownerId
            });
            store.put(mk('seed-a', '种子会话A', 2000));
            store.put(mk('seed-b', '种子会话B', 1000));
            await new Promise((res) => { tx.oncomplete = () => res(); });
        }""",
        owner_id,
    )


def get_user_id(page):
    """通过已登录的 token 调 /api/auth/me 获取当前用户 id（会话 ownerId 隔离需要）。"""
    token = page.evaluate("() => localStorage.getItem('authToken')")
    if not token:
        return None
    import urllib.request

    req = urllib.request.Request(
        f"{API}/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        # 兼容 {user:{id}} 或 {id} 两种返回结构
        if "user" in data and data["user"]:
            return data["user"].get("id")
        return data.get("id")
    except Exception as e:  # noqa: BLE001
        print(f"  [WARN] /api/auth/me 失败：{e}")
        return None


def main():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LAUNCH_ARGS)
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        # 预置侧栏为展开态，保证历史列表渲染
        page.add_init_script(
            "localStorage.setItem('sidebarState', 'expanded');"
        )
        page.on("console", lambda m: None)  # 静默收集，避免噪音

        print(f"\n== 打开应用 {BASE} ==")
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1500)

        # 登录（若被重定向到登录页）
        try:
            login_btn = page.get_by_role("button", name="登录").first
            if login_btn.is_visible(timeout=2000):
                page.fill("input[type='text']", USER)
                page.fill("input[type='password']", PASS)
                login_btn.click()
                page.wait_for_timeout(2000)
                print("  [INFO] 已通过登录页登录")
        except Exception:
            print("  [INFO] 未检测到登录页，假设已登录")

        owner_id = get_user_id(page)
        check("获取当前用户 id（用于 ownerId 隔离）", bool(owner_id), f"owner_id={owner_id}")
        if not owner_id:
            print("  无法获取用户 id，终止。")
            browser.close()
            sys.exit(2)

        # 注入测试会话并重载，使侧栏加载
        seed_conversations(page, owner_id)
        page.reload(wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2000)

        # 切换到知识问答视图（SPA 内部跳转：karpathy:navigate）
        page.evaluate(
            "() => window.dispatchEvent(new CustomEvent('karpathy:navigate', {detail:{view:'query'}}))"
        )
        page.wait_for_timeout(1500)

        # 等待侧栏历史列表出现
        page.wait_for_selector(".conversation-item", timeout=15000)
        items = page.query_selector_all(".conversation-item")
        check("侧栏渲染出历史会话", len(items) >= 2, f"item_count={len(items)}")

        # 取第一个会话项做悬停操作测试
        first = items[0]
        title_text = first.query_selector(".conv-title").inner_text()
        first.hover()
        page.wait_for_timeout(400)

        # 1) 直显图标：置顶 / 删除 存在；低频操作收进「更多操作」菜单（more-actions）
        more_btn = first.query_selector("[data-testid='more-actions']")
        pin_btn = first.query_selector("[data-testid='pin-conversation']")
        del_btn = first.query_selector("[data-testid='delete-conversation']")
        check("更多操作(...)图标存在", more_btn is not None)
        check("置顶图标直显存在", pin_btn is not None)
        check("删除图标直显存在", del_btn is not None)

        # 点击「更多操作」展开悬浮列表，收纳 重命名/复制/导出
        check("点击更多操作可点击", more_btn is not None)
        if more_btn:
            more_btn.click()
            page.wait_for_timeout(400)
            menu = page.query_selector(".conv-menu")
            check("悬浮菜单已展开", menu is not None)

            rename_btn = menu.query_selector("[data-testid='rename-conversation']") if menu else None
            copy_btn = menu.query_selector("[data-testid='copy-conversation']") if menu else None
            export_btn = menu.query_selector("[data-testid='export-conversation']") if menu else None
            check("重命名菜单项存在", rename_btn is not None)
            check("复制会话菜单项存在", copy_btn is not None)
            check("会话导出菜单项存在", export_btn is not None)

            if copy_btn:
                check("复制会话悬停提示含『复制』说明",
                      "复制" in (copy_btn.get_attribute("title") or ""),
                      copy_btn.get_attribute("title"))
            if export_btn:
                check("会话导出悬停提示含『导出』说明",
                      "导出" in (export_btn.get_attribute("title") or ""),
                      export_btn.get_attribute("title"))
            if rename_btn:
                check("重命名悬停提示含『重命名』说明",
                      "重命名" in (rename_btn.get_attribute("title") or ""),
                      rename_btn.get_attribute("title"))

            # 2) 视觉风格一致：菜单项共用 .conv-menu-item 类
            for sel, label in [
                ("[data-testid='rename-conversation']", "重命名"),
                ("[data-testid='copy-conversation']", "复制"),
                ("[data-testid='export-conversation']", "导出"),
            ]:
                it = menu.query_selector(sel) if menu else None
                cls = it.get_attribute("class") or "" if it else ""
                check(f"{label}菜单项沿用 conv-menu-item 样式类", "conv-menu-item" in cls, cls)

            # 点空白处收起菜单，便于后续直显图标测试
            page.mouse.click(5, 5)
            page.wait_for_timeout(300)

        # 3) 置顶（直显图标）：重新悬停以显示操作栏后点击
        first.hover()
        page.wait_for_timeout(300)
        pin_btn = first.query_selector("[data-testid='pin-conversation']")
        if pin_btn:
            pin_btn.click()
            page.wait_for_timeout(400)
            pin_btn2 = first.query_selector("[data-testid='pin-conversation']")
            cls2 = pin_btn2.get_attribute("class") or "" if pin_btn2 else ""
            check("点击置顶后按钮进入激活态(pin-active)", "pin-active" in cls2, cls2)
            check("置顶激活后提示变为『取消置顶』",
                  (pin_btn2.get_attribute("title") or "") == "取消置顶",
                  pin_btn2.get_attribute("title"))

        # 4) 复制会话：打开「更多操作」菜单后点选复制，列表新增一条「(副本)」且被选中（active）
        first.hover()
        page.wait_for_timeout(300)
        more_btn2 = first.query_selector("[data-testid='more-actions']")
        if more_btn2:
            more_btn2.click()
            page.wait_for_timeout(400)
        copy_btn2 = page.query_selector("[data-testid='copy-conversation']")
        before = len(page.query_selector_all(".conversation-item"))
        if copy_btn2:
            copy_btn2.click()
            page.wait_for_timeout(800)
            after = page.query_selector_all(".conversation-item")
            check("复制后会话数量 +1", len(after) == before + 1,
                  f"before={before} after={len(after)}")
            # 存在标题含 (副本) 的条目
            has_copy = any(
                "(副本)" in (it.query_selector(".conv-title").inner_text() or "")
                for it in after
            )
            check("存在标题含 (副本) 的新会话", has_copy)
            # 新副本应处于选中(active)态
            copied_active = any(
                "active" in (it.get_attribute("class") or "")
                and "(副本)" in (it.query_selector(".conv-title").inner_text() or "")
                for it in after
            )
            check("复制生成的新会话处于选中(active)态", copied_active)

        # 5) 会话导出：悬停并打开「更多操作」菜单，点选导出触发 .md 下载
        items_now = page.query_selector_all(".conversation-item")
        target = items_now[0]
        target.hover()
        page.wait_for_timeout(300)
        more_btn3 = target.query_selector("[data-testid='more-actions']")
        if more_btn3:
            more_btn3.click()
            page.wait_for_timeout(400)
        exp_btn = target.query_selector("[data-testid='export-conversation']")
        if exp_btn:
            try:
                with page.expect_download(timeout=8000) as dl_info:
                    exp_btn.click()
                dl = dl_info.value
                fname = dl.suggested_filename
                check("点击会话导出触发文件下载", True)
                check("导出文件名以 .md 结尾", fname.endswith(".md"), fname)
            except Exception as e:  # noqa: BLE001
                check("点击会话导出触发文件下载", False, str(e))

        browser.close()

    print(f"\n==== 结果：通过 {passed} / 失败 {failed} ====")
    if failures:
        print("失败项：")
        for f in failures:
            print(f"  - {f}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
