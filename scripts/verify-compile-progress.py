"""
Karpathy-Wiki 编译进度优化方案 E2E 验证脚本（v3）

关键发现：
- App.vue 不用 vue-router，用自定义 currentView ref + go() 函数
- hash 路由 #/progress 不会切换视图，必须点击导航按钮
- authStore 不读 localStorage 的 user 字段，必须等 restoreSession 从后端恢复
- "编译进度"按钮 disabled 条件：!store.isCompiling && !store.isDone
- Progress.vue onMounted 调用 loadPersistedState 从 localStorage 恢复 isDone

v3 改进：
- 启动时自动调用 /api/auth/login 获取新 token，避免硬编码 token 过期导致脚本失效
- 符合"配置化无硬编码"原则，token 由运行时动态获取

验证流程：
1. 调用 /api/auth/login 获取 authToken → 注入 localStorage → 刷新 → 等待 restoreSession
2. 注入 mock compile state → 强制点击"编译进度"按钮
3. Progress.vue 挂载 → onMounted → loadPersistedState → 恢复 isDone=true
4. 验证进度条/耗时/状态恢复
"""
import json
import sys
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

# 项目常量
FRONTEND_URL = "http://localhost:5173/wiki/"
BACKEND_URL = "http://localhost:3000/api"
ADMIN_CREDENTIALS = {"username": "admin", "password": "admin123"}


def fetch_auth_token():
    """启动时调用 /api/auth/login 获取新 token

    为什么动态获取：硬编码 token 会过期，导致 restoreSession 失败、
    脚本反复需要手动更新。动态获取符合"配置化无硬编码"原则
    """
    body = json.dumps(ADMIN_CREDENTIALS).encode("utf-8")
    req = urllib.request.Request(
        f"{BACKEND_URL}/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not data.get("ok") or not data.get("token"):
        raise RuntimeError(f"登录失败: {data}")
    return data["token"]

# mock 编译完成态数据（对应 store 中 PersistableCompileState 接口）
MOCK_DONE_STATE = {
    "timeline": [
        {"step": "archive", "status": "done", "message": "已存档到 data/vault/raw/",
         "page": None, "timestamp": 1785165740000},
        {"step": "read_schema", "status": "done", "message": "SCHEMA 已加载",
         "page": None, "timestamp": 1785165745000},
        {"step": "extract", "status": "done", "message": "提取要点完成",
         "page": None, "timestamp": 1785165750000},
        {"step": "generate_page", "status": "done", "message": "生成页面",
         "page": {"path": "concepts/recursion.md", "title": "递归"},
         "timestamp": 1785165755000},
        {"step": "finalize", "status": "done", "message": "收尾完成",
         "page": None, "timestamp": 1785165760000}
    ],
    "isCompiling": False,
    "isDone": True,
    "isCancelled": False,
    "errorMessage": "",
    "doneMessage": "编译完成（mock 数据）",
    "currentRunId": "",
    "stageTimings": {
        "archive": 4500,
        "read_schema": 1200,
        "extract": 8500,
        "generate_page": 15300,
        "finalize": 800
    },
    "compileStartedAt": 1785165740000,
    "pendingPayloadType": "text",
    "pendingPayloadContent": "测试 mock 内容"
}

# mock 运行态数据（用于切走再切回测试）
MOCK_RUNNING_STATE = {
    "timeline": [
        {"step": "archive", "status": "done", "message": "已存档",
         "page": None, "timestamp": 1785165740000}
    ],
    "isCompiling": True,
    "isDone": False,
    "isCancelled": False,
    "errorMessage": "",
    "doneMessage": "",
    "currentRunId": "mock-run-123",
    "stageTimings": {"archive": 4500},
    "compileStartedAt": 1785165740000,
    "pendingPayloadType": "text",
    "pendingPayloadContent": "测试 mock 内容"
}

OUTPUT_DIR = Path(__file__).parent / "test_screenshots"
OUTPUT_DIR.mkdir(exist_ok=True)


def inject_compile_state(page, state):
    """注入编译状态到 localStorage

    为什么用 page.evaluate 第二参数传 state：避免 f-string 嵌套转义问题，
    Playwright 会自动序列化为 JS 对象，localStorage.setItem 直接接收 JSON 字符串
    """
    state_json = json.dumps(state, ensure_ascii=False)
    page.evaluate(
        "(jsonStr) => {"
        "  localStorage.setItem('wiki:compile:state', jsonStr);"
        "  return 'compile state injected';"
        "}",
        state_json
    )


def check_elements(page, selectors):
    """批量检查元素存在性，返回 dict[selector -> bool]"""
    return page.evaluate(
        "(sels) => {"
        "  const result = {};"
        "  for (const s of sels) {"
        "    result[s] = !!document.querySelector(s);"
        "  }"
        "  return result;"
        "}",
        selectors
    )


def wait_for_restore_session(page, timeout_ms=10000):
    """等待 authStore.restoreSession 完成

    判断依据：导航栏 .nav-user-name 元素显示用户名（admin）
    为什么用这个判断：authStore.user 只在 restoreSession 成功后有值，
    App.vue 模板中 .nav-user-name 绑定 authStore.user?.username，
    用户名出现即表示 restoreSession 完成
    """
    try:
        page.wait_for_selector(".nav-user-name", state="visible", timeout=timeout_ms)
        username = page.evaluate(
            "document.querySelector('.nav-user-name')?.textContent?.trim() || ''")
        return username == "admin"
    except Exception:
        return False


def click_progress_tab(page):
    """点击"编译进度"导航按钮切换视图

    为什么用 force=True：按钮 disabled 条件是 !store.isCompiling && !store.isDone，
    在 mock state 注入前 store.isDone=false 导致按钮 disabled。
    force=True 绕过 disabled 检查，go() 函数本身只检查 isLoggedIn
    """
    # 优先尝试展开模式的 tab-btn，回退到折叠模式的 icon-btn
    selectors = [
        'button.tab-btn:has-text("编译进度")',
        'button.icon-btn[aria-label="编译进度"]',
        'button:has-text("编译进度")'
    ]
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            if btn.count() > 0:
                btn.click(force=True, timeout=3000)
                return True
        except Exception as e:
            continue
    return False


def main():
    results = []
    console_errors = []

    # 启动时动态获取 auth token，避免硬编码 token 过期
    print("=== 步骤 0: 获取 auth token ===")
    try:
        auth_token = fetch_auth_token()
        print(f"token 获取成功 (前 16 字符): {auth_token[:16]}...")
    except Exception as e:
        print(f"!!! 获取 token 失败: {e}")
        print("请确认后端服务运行在 http://localhost:3000 且 admin 账户可用")
        return 1

    with sync_playwright() as p:
        # 启动 chromium（CODING-053 headless 参数）
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-gpu", "--no-sandbox",
                  "--disable-dev-shm-usage", "--disable-setuid-sandbox"]
        )
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()

        # 收集控制台错误
        page.on("console", lambda msg: console_errors.append(
            f"[{msg.type}] {msg.text}") if msg.type == "error" else None)

        try:
            print("\n=== 步骤 1: 访问前端首页 ===")
            page.goto(FRONTEND_URL, wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(1000)
            print(f"当前 URL: {page.url}")

            print("\n=== 步骤 2: 注入 authToken 到 localStorage ===")
            # authStore 不读 localStorage 的 user 字段，只读 authToken
            # user 信息由 restoreSession 从后端 /api/auth/me 恢复
            page.evaluate(
                "(token) => { localStorage.setItem('authToken', token); }",
                auth_token
            )
            keys = page.evaluate("Object.keys(localStorage).join(',')")
            print(f"localStorage keys: {keys}")

            print("\n=== 步骤 3: 注入 mock done 态到 localStorage（在刷新前注入）===")
            # 为什么在刷新前注入：App.vue onMounted 会在 restoreSession 成功后调用
            #   store.loadPersistedState()，此时若 localStorage 已有 done 态，
            #   store.isDone 会被设为 true，按钮 disabled 自动解除
            #   若刷新后再注入，store 已初始化完成不会重新读取，按钮仍 disabled
            inject_compile_state(page, MOCK_DONE_STATE)
            page.wait_for_timeout(500)
            print("mock done 态已注入")

            print("\n=== 步骤 4: 刷新页面触发 restoreSession + loadPersistedState ===")
            page.reload(wait_until="networkidle", timeout=15000)
            print("等待 restoreSession 完成（.nav-user-name 显示 admin）...")
            restored = wait_for_restore_session(page, timeout_ms=10000)
            print(f"restoreSession 完成: {restored}")
            if not restored:
                # 检查页面实际状态
                body_text = page.evaluate("document.body.innerText.substring(0, 500)")
                print(f"页面文本前 500 字符: {body_text}")
                screenshot_path = OUTPUT_DIR / "00_restore_failed.png"
                page.screenshot(path=str(screenshot_path), full_page=True)
                print(f"截图已保存: {screenshot_path}")
                results.append(("restoreSession 完成", False))
                raise Exception("restoreSession 未完成，无法继续验证")
            results.append(("restoreSession 完成", True))

            # 验证 store 已加载持久化状态（按钮应已 enabled）
            # 为什么用 Array.from + textContent.includes 而非 :has-text：
            #   :has-text 是 Playwright 专有伪类，document.querySelector 不支持
            store_state = page.evaluate(
                "() => {"
                "  const allBtns = Array.from(document.querySelectorAll('button'));"
                "  const btn = allBtns.find(b => (b.textContent || '').includes('编译进度') || b.getAttribute('aria-label') === '编译进度');"
                "  return {"
                "    btnExists: !!btn,"
                "    btnDisabled: btn ? btn.disabled : null,"
                "    hasProgressContainer: !!document.querySelector('.single-progress-container'),"
                "    currentView: document.querySelector('.progress-page') ? 'progress' : 'other'"
                "  };"
                "}"
            )
            print(f"按钮状态: {store_state}")

            print("\n=== 步骤 5: 点击'编译进度'按钮切换视图 ===")
            clicked = click_progress_tab(page)
            print(f"按钮点击成功: {clicked}")
            if not clicked:
                results.append(("点击编译进度按钮", False))
                raise Exception("无法点击编译进度按钮")
            results.append(("点击编译进度按钮", True))

            # 等待 Progress.vue 挂载 + onMounted → loadPersistedState
            print("等待 Progress.vue 挂载（.single-progress-container 出现）...")
            try:
                page.wait_for_selector(".single-progress-container", timeout=5000)
                print("Progress.vue 已挂载")
            except Exception:
                print("Progress.vue 未挂载，等待 3s 后继续...")
                page.wait_for_timeout(3000)

            # 截图 1：done 态恢复后的页面
            screenshot_path = OUTPUT_DIR / "01_done_state_restored.png"
            page.screenshot(path=str(screenshot_path), full_page=True)
            print(f"截图已保存: {screenshot_path}")

            print("\n=== 验证点 1: 进度条核心元素 ===")
            progress_selectors = [
                ".single-progress-container",
                ".progress-bar",
                ".progress-percentage",
                ".progress-status-dot",
                ".success-banner"
            ]
            progress_result = check_elements(page, progress_selectors)
            for sel, found in progress_result.items():
                mark = "PASS" if found else "FAIL"
                print(f"  {mark} {sel}: {found}")
                results.append(("进度条元素 " + sel, found))

            # 检查容器类名（应含 done）
            container_class = page.evaluate(
                "document.querySelector('.single-progress-container')?.className || ''")
            print(f"  容器类名: {container_class}")
            results.append(("容器含 done 类", "done" in container_class))

            # 检查百分比文本
            percentage_text = page.evaluate(
                "document.querySelector('.progress-percentage')?.textContent || ''")
            print(f"  百分比文本: '{percentage_text}'")
            results.append(("百分比显示 100%", "100" in percentage_text))

            print("\n=== 验证点 2: 各阶段耗时统计 ===")
            stage_selectors = [
                ".stage-timings",
                ".stage-item",
                ".stage-label",
                ".stage-duration",
                ".stage-bar"
            ]
            stage_result = check_elements(page, stage_selectors)
            for sel, found in stage_result.items():
                mark = "PASS" if found else "FAIL"
                print(f"  {mark} {sel}: {found}")
                results.append(("耗时元素 " + sel, found))

            # 统计 stage-item 数量
            stage_count = page.evaluate(
                "document.querySelectorAll('.stage-item').length")
            print(f"  stage-item 数量: {stage_count}")
            results.append(("阶段项 ≥4", stage_count >= 4))

            # 获取阶段标签文本
            stage_labels = page.evaluate(
                "Array.from(document.querySelectorAll('.stage-label')).map(el => el.textContent)")
            print(f"  阶段标签: {stage_labels}")

            # 获取阶段耗时文本
            stage_durations = page.evaluate(
                "Array.from(document.querySelectorAll('.stage-duration')).map(el => el.textContent)")
            print(f"  阶段耗时: {stage_durations}")

            print("\n=== 验证点 3: localStorage 清除（done 态恢复后）===")
            # done 态恢复后应触发 clearPersistedState
            compile_state = page.evaluate(
                "localStorage.getItem('wiki:compile:state')")
            cleared = compile_state is None
            mark = "PASS" if cleared else "FAIL"
            print(f"  {mark} wiki:compile:state 已清除: {cleared}")
            results.append(("done 态恢复后 localStorage 清除", cleared))

            print("\n=== 验证点 4: 切走再切回（mock running 态）===")
            # 切到其他视图（如 dashboard）
            try:
                page.locator('button.tab-btn:has-text("仪表盘")').first.click(force=True, timeout=3000)
            except Exception:
                page.locator('button:has-text("仪表盘")').first.click(force=True, timeout=3000)
            page.wait_for_timeout(1000)
            print("已切到仪表盘页")

            # 注入 running 态
            inject_compile_state(page, MOCK_RUNNING_STATE)
            page.wait_for_timeout(500)

            # 切回编译进度
            clicked = click_progress_tab(page)
            print(f"切回编译进度按钮点击: {clicked}")
            page.wait_for_timeout(3000)

            # 截图 2：running 态恢复
            screenshot_path = OUTPUT_DIR / "02_running_state_restored.png"
            page.screenshot(path=str(screenshot_path), full_page=True)
            print(f"截图已保存: {screenshot_path}")

            # 检查 running 态或 error 态（resume 失败会进 error 态）
            running_check = page.evaluate(
                "() => {"
                "  const container = document.querySelector('.single-progress-container');"
                "  if (!container) return { exists: false, classes: '' };"
                "  return {"
                "    exists: true,"
                "    classes: container.className,"
                "    hasRunning: container.className.includes('running'),"
                "    hasError: container.className.includes('error'),"
                "    hasCancelled: container.className.includes('cancelled')"
                "  };"
                "}"
            )
            print(f"  容器状态: {running_check}")
            # running 或 error（resume 失败兜底）都算状态恢复成功
            state_restored = (running_check.get("exists") and
                              (running_check.get("hasRunning") or
                               running_check.get("hasError")))
            mark = "PASS" if state_restored else "FAIL"
            print(f"  {mark} running/error 态恢复: {state_restored}")
            results.append(("running 态恢复或 resume 失败兜底", state_restored))

            print("\n=== 步骤 6: 切到仪表盘再切回（状态保留测试）===")
            try:
                page.locator('button.tab-btn:has-text("仪表盘")').first.click(force=True, timeout=3000)
            except Exception:
                page.locator('button:has-text("仪表盘")').first.click(force=True, timeout=3000)
            page.wait_for_timeout(1500)

            # 切回 progress
            clicked = click_progress_tab(page)
            page.wait_for_timeout(2000)

            # 截图 3：切回后的状态
            screenshot_path = OUTPUT_DIR / "03_after_switch_back.png"
            page.screenshot(path=str(screenshot_path), full_page=True)
            print(f"截图已保存: {screenshot_path}")

            # 验证切回后仍有进度条容器（状态保留）
            container_exists = page.evaluate(
                "!!document.querySelector('.single-progress-container')")
            mark = "PASS" if container_exists else "FAIL"
            print(f"  {mark} 切回后进度条容器仍存在: {container_exists}")
            results.append(("切走再切回状态保留", container_exists))

            print("\n=== 步骤 7: 清理 localStorage ===")
            page.evaluate(
                "() => {"
                "  localStorage.removeItem('wiki:compile:state');"
                "  localStorage.removeItem('wiki:test:before');"
                "}"
            )
            print("  清理完成")

            print("\n=== 控制台错误 ===")
            if console_errors:
                for err in console_errors[:10]:
                    print(f"  {err}")
            else:
                print("  无控制台错误")

        except Exception as e:
            print(f"\n!!! 异常: {type(e).__name__}: {e}")
            try:
                err_path = OUTPUT_DIR / "99_error.png"
                page.screenshot(path=str(err_path), full_page=True)
                print(f"异常截图: {err_path}")
            except:
                pass
            results.append(("脚本异常", False))
        finally:
            context.close()
            browser.close()

    # 汇总报告
    print("\n" + "=" * 60)
    print("E2E 验证汇总报告")
    print("=" * 60)
    passed = sum(1 for _, v in results if v)
    failed = sum(1 for _, v in results if not v)
    for name, ok in results:
        mark = "✅ PASS" if ok else "❌ FAIL"
        print(f"  {mark}  {name}")
    print(f"\n总计: {passed} PASS / {failed} FAIL")

    # 写入 JSON 结果
    report_path = OUTPUT_DIR / "verify-result.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({
            "results": [{"name": n, "passed": v} for n, v in results],
            "summary": {"passed": passed, "failed": failed},
            "console_errors": console_errors[:10]
        }, f, ensure_ascii=False, indent=2)
    print(f"\n报告已保存: {report_path}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
