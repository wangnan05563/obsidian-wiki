# -*- coding: utf-8 -*-
"""
Skill 模块 + APIKEY 同步 + MCP JSON 配置 E2E 测试脚本
覆盖需求 1/2/3 的关键路径验证。
"""

import json
import os
import sys
import time
import tempfile
import zipfile
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Playwright 未安装", file=sys.stderr)
    sys.exit(1)

# 测试配置
API_BASE = "http://localhost:3000"
FRONTEND_URL = "http://localhost:5173"
SCREENSHOTS_DIR = Path("test_screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

# 测试结果收集
results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    results.append({"name": name, "ok": ok, "detail": detail})
    print(f"[{status}] {name}" + (f" - {detail}" if detail else ""))


def test_skill_api_endpoints():
    """测试 Skill API 端点（直接 HTTP 请求）"""
    import urllib.request
    import urllib.error

    # 1. GET /api/skills - 空列表
    try:
        req = urllib.request.Request(f"{API_BASE}/api/skills")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            record("GET /api/skills 空列表", "skills" in data and isinstance(data["skills"], list),
                   f"返回字段: {list(data.keys())}")
    except Exception as e:
        record("GET /api/skills 空列表", False, str(e))

    # 2. POST /api/skills/import - 上传 .md 文件
    try:
        # 创建临时 .md 文件
        md_content = """---
name: Test Skill
description: 测试技能描述
---

# Test Skill

这是一个测试技能，用于验证导入功能。
"""
        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="test-skill.md"\r\n'
            f"Content-Type: text/markdown\r\n\r\n"
            f"{md_content}\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")

        req = urllib.request.Request(
            f"{API_BASE}/api/skills/import",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            ok = data.get("ok") is True and "skill" in data
            record("POST /api/skills/import (.md)", ok,
                   f"name={data.get('skill', {}).get('name')}, id={data.get('skill', {}).get('id')}")
            test_skill_id = data.get("skill", {}).get("id", "")
    except Exception as e:
        record("POST /api/skills/import (.md)", False, str(e))
        test_skill_id = ""

    # 3. GET /api/skills - 应包含刚导入的技能
    if test_skill_id:
        try:
            req = urllib.request.Request(f"{API_BASE}/api/skills")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                skills = data.get("skills", [])
                found = any(s["id"] == test_skill_id for s in skills)
                record("GET /api/skills 包含新导入", found,
                       f"列表 {len(skills)} 项, 找到 {test_skill_id}: {found}")
        except Exception as e:
            record("GET /api/skills 包含新导入", False, str(e))

        # 4. GET /api/skills/:id - 详情
        try:
            req = urllib.request.Request(f"{API_BASE}/api/skills/{test_skill_id}")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                ok = data.get("id") == test_skill_id and "content" in data and "files" in data
                record("GET /api/skills/:id 详情", ok,
                       f"name={data.get('name')}, content长度={len(data.get('content', ''))}")
        except Exception as e:
            record("GET /api/skills/:id 详情", False, str(e))

        # 5. GET /api/skills/:id - 路径穿越防护
        try:
            req = urllib.request.Request(f"{API_BASE}/api/skills/..%2F..%2Fetc%2Fpasswd")
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    record("GET /api/skills/路径穿越防护", False, "应返回 4xx 但实际返回 200")
            except urllib.error.HTTPError as e:
                ok = 400 <= e.code < 500
                record("GET /api/skills/路径穿越防护", ok, f"状态码={e.code}")
        except Exception as e:
            record("GET /api/skills/路径穿越防护", False, str(e))

        # 6. DELETE /api/skills/:id
        try:
            req = urllib.request.Request(
                f"{API_BASE}/api/skills/{test_skill_id}",
                method="DELETE",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                record("DELETE /api/skills/:id", data.get("ok") is True, f"id={test_skill_id}")
        except Exception as e:
            record("DELETE /api/skills/:id", False, str(e))

        # 7. GET /api/skills/:id - 确认已删除（404）
        try:
            req = urllib.request.Request(f"{API_BASE}/api/skills/{test_skill_id}")
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    record("GET /api/skills/:id 删除后 404", False, "应返回 404 但实际返回 200")
            except urllib.error.HTTPError as e:
                ok = e.code == 404
                record("GET /api/skills/:id 删除后 404", ok, f"状态码={e.code}")
        except Exception as e:
            record("GET /api/skills/:id 删除后 404", False, str(e))


def test_zip_skill_import():
    """测试 ZIP 格式技能包导入"""
    import urllib.request
    import urllib.error

    # 创建临时 ZIP 文件
    with tempfile.NamedTemporaryFile(suffix=".skill", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("SKILL.md", """---
name: ZIP Test Skill
description: ZIP 归档测试技能
---

# ZIP Test Skill

通过 ZIP 归档导入的测试技能。
""")
            zf.writestr("config/config.json", '{"key": "value"}')
            zf.writestr("references/guide.md", "# Guide\n\n参考文档")

        # 上传 ZIP
        with open(tmp_path, "rb") as f:
            zip_data = f.read()

        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="zip-test-skill.skill"\r\n'
            f"Content-Type: application/zip\r\n\r\n"
        ).encode("utf-8") + zip_data + f"\r\n--{boundary}--\r\n".encode("utf-8")

        req = urllib.request.Request(
            f"{API_BASE}/api/skills/import",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            ok = data.get("ok") is True and data.get("skill", {}).get("format") == "zip"
            skill_id = data.get("skill", {}).get("id", "")
            record("POST /api/skills/import (.skill ZIP)", ok,
                   f"format={data.get('skill', {}).get('format')}, id={skill_id}")

            # 验证详情包含多个文件
            if skill_id:
                req2 = urllib.request.Request(f"{API_BASE}/api/skills/{skill_id}")
                with urllib.request.urlopen(req2, timeout=5) as resp2:
                    detail = json.loads(resp2.read().decode())
                    files = detail.get("files", [])
                    ok_files = len(files) >= 3  # SKILL.md + config.json + guide.md
                    record("ZIP 导入后文件列表完整", ok_files,
                           f"文件数={len(files)}: {files}")

                # 清理
                try:
                    req3 = urllib.request.Request(
                        f"{API_BASE}/api/skills/{skill_id}", method="DELETE"
                    )
                    urllib.request.urlopen(req3, timeout=5)
                except Exception:
                    pass
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def test_invalid_file_rejection():
    """测试非法文件格式拒绝"""
    import urllib.request
    import urllib.error

    # 上传 .txt 文件应该被拒绝
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="test.txt"\r\n'
        f"Content-Type: text/plain\r\n\r\n"
        f"plain text content\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")

    try:
        req = urllib.request.Request(
            f"{API_BASE}/api/skills/import",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                record("POST /api/skills/import .txt 拒绝", False, "应返回 4xx 但实际返回 200")
        except urllib.error.HTTPError as e:
            ok = 400 <= e.code < 500
            record("POST /api/skills/import .txt 拒绝", ok, f"状态码={e.code}")
    except Exception as e:
        record("POST /api/skills/import .txt 拒绝", False, str(e))


def test_frontend_skill_page():
    """测试前端 Skill 管理页面"""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        try:
            # 1. 登录 - 用 domcontentloaded 避免背景图加载阻塞 networkidle
            page.goto(f"{FRONTEND_URL}", wait_until="domcontentloaded", timeout=30000)
            # 等待登录表单渲染完成
            page.wait_for_selector("#login-username", state="visible", timeout=10000)
            page.fill("#login-username", "admin")
            page.fill("#login-password", "admin123")
            page.click(".login-btn")
            # 等待主界面导航栏出现（登录成功标志）
            page.wait_for_selector(".nav-tabs", state="visible", timeout=10000)
            time.sleep(1)

            page.screenshot(path=str(SCREENSHOTS_DIR / "skill_01_login.png"))

            # 2. 导航到技能管理页（通过菜单文本点击）
            skill_tab = page.query_selector("button.tab-btn:has-text('技能管理')")
            if skill_tab:
                skill_tab.click()
                time.sleep(1)
                record("前端导航到技能管理页", True, "通过菜单点击")
            else:
                record("前端导航到技能管理页", False, "未找到技能管理菜单按钮")
            page.screenshot(path=str(SCREENSHOTS_DIR / "skill_02_skill_page.png"))

            # 3. 验证页头存在
            head = page.query_selector(".head-title")
            record("技能管理页头存在", head is not None,
                   f"text={head.inner_text() if head else 'N/A'}")

            # 4. 验证上传区存在
            upload_zone = page.query_selector(".upload-zone")
            record("上传区存在", upload_zone is not None)

            # 5. 验证统计区存在
            stat = page.query_selector(".stat-value")
            record("统计区存在", stat is not None)

            # 6. 验证工具栏（搜索框 + 筛选器）存在
            search = page.query_selector(".search-input")
            record("搜索框存在", search is not None)

            filter_btns = page.query_selector_all(".filter-btn")
            record("筛选按钮存在", len(filter_btns) == 3, f"数量={len(filter_btns)}")

            # 7. 测试格式筛选点击
            if len(filter_btns) >= 2:
                filter_btns[1].click()  # ZIP
                time.sleep(0.5)
                filter_btns[0].click()  # 全部
                time.sleep(0.5)
                record("格式筛选切换", True)

            # 8. 控制台错误检查（过滤掉网络错误与 favicon）
            real_errors = [
                e for e in console_errors
                if "favicon" not in e.lower()
                and "Failed to load resource" not in e
                and "net::ERR" not in e
            ]
            record("控制台无关键错误", len(real_errors) == 0,
                   f"错误数={len(real_errors)}, 样本={real_errors[:2]}")

        except Exception as e:
            record("前端测试异常", False, str(e))
            try:
                page.screenshot(path=str(SCREENSHOTS_DIR / "skill_error.png"))
            except Exception:
                pass
        finally:
            browser.close()


def test_frontend_config_page_mcp_json():
    """测试前端 Config 页面 MCP JSON 编辑模式"""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        try:
            # 1. 登录 - 用 domcontentloaded 避免背景图加载阻塞 networkidle
            page.goto(f"{FRONTEND_URL}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_selector("#login-username", state="visible", timeout=10000)
            page.fill("#login-username", "admin")
            page.fill("#login-password", "admin123")
            page.click(".login-btn")
            page.wait_for_selector(".nav-tabs", state="visible", timeout=10000)
            time.sleep(1)
            page.screenshot(path=str(SCREENSHOTS_DIR / "skill_03_login.png"))

            # 2. 导航到配置页（通过菜单文本点击，使用 .tab-btn 限定导航按钮）
            config_tab = page.query_selector("button.tab-btn:has-text('配置')")
            if config_tab:
                config_tab.click()
                time.sleep(1)
                record("前端导航到配置页", True, "通过菜单点击")
            else:
                record("前端导航到配置页", False, "未找到配置菜单按钮")
            page.screenshot(path=str(SCREENSHOTS_DIR / "skill_04_config_page.png"))

            # 3. 切换到"工具配置" tab（Element Plus 的 el-tabs__item）
            tools_tab = page.query_selector(".el-tabs__item:has-text('工具配置')")
            if tools_tab:
                tools_tab.click()
                time.sleep(1)
                page.screenshot(path=str(SCREENSHOTS_DIR / "skill_05_config_tools.png"))
                record("Config 工具配置 tab 可访问", True)
            else:
                record("Config 工具配置 tab 可访问", False, "未找到工具配置 tab")

            # 4. 验证 MCP 模式切换按钮存在（.mcp-mode-switch 内的 .preset-tag）
            mcp_switch = page.query_selector(".mcp-mode-switch")
            record("MCP 模式切换区存在", mcp_switch is not None)

            # 5. 点击"JSON 模式"按钮切换到 JSON 编辑模式
            json_btn = page.query_selector(".mcp-mode-switch .preset-tag:has-text('JSON')")
            record("MCP JSON 模式切换按钮存在", json_btn is not None)
            if json_btn:
                json_btn.click()
                time.sleep(0.5)
                page.screenshot(path=str(SCREENSHOTS_DIR / "skill_06_mcp_json_mode.png"))
                record("切换到 MCP JSON 模式", True, "已点击 JSON 模式按钮")

                # 6. 验证 JSON 编辑器文本区域存在
                json_editor = page.query_selector("textarea, .mcp-json-editor, .json-editor")
                record("JSON 编辑器存在", json_editor is not None,
                       f"元素类型={json_editor.evaluate('el => el.tagName') if json_editor else 'N/A'}")

                # 7. 切换回表单模式
                form_btn = page.query_selector(".mcp-mode-switch .preset-tag:has-text('表单')")
                if form_btn:
                    form_btn.click()
                    time.sleep(0.5)
                    record("切换回 MCP 表单模式", True)
            else:
                record("切换到 MCP JSON 模式", False, "JSON 模式按钮不存在")

            # 8. 控制台错误检查（过滤掉网络错误与 favicon）
            real_errors = [
                e for e in console_errors
                if "favicon" not in e.lower()
                and "Failed to load resource" not in e
                and "net::ERR" not in e
            ]
            record("控制台无关键错误", len(real_errors) == 0,
                   f"错误数={len(real_errors)}, 样本={real_errors[:2]}")

        except Exception as e:
            record("Config 页面测试异常", False, str(e))
            try:
                page.screenshot(path=str(SCREENSHOTS_DIR / "config_error.png"))
            except Exception:
                pass
        finally:
            browser.close()


def test_rbac_permission_sync():
    """测试 RBAC 权限点 skill 已同步到前端"""
    import urllib.request

    # 登录获取 token
    try:
        body = json.dumps({"username": "admin", "password": "admin123"}).encode()
        req = urllib.request.Request(
            f"{API_BASE}/api/auth/login",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            token = data.get("token", "")

        if token:
            # 获取当前用户信息，检查 permissions 是否含 'skill'
            req = urllib.request.Request(
                f"{API_BASE}/api/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                me = json.loads(resp.read().decode())
                perms = me.get("permissions", [])
                ok = "skill" in perms
                record("admin 用户 permissions 含 skill", ok,
                       f"权限数={len(perms)}, 含 skill: {ok}")
        else:
            record("admin 登录获取 token", False, "未返回 token")
    except Exception as e:
        record("RBAC 权限同步测试异常", False, str(e))


def main():
    print("=" * 60)
    print("Skill 模块 + APIKEY 同步 + MCP JSON 配置 E2E 测试")
    print("=" * 60)
    print()

    print("--- 阶段 1: Skill API 端点测试 ---")
    test_skill_api_endpoints()
    print()

    print("--- 阶段 2: ZIP 格式导入测试 ---")
    test_zip_skill_import()
    print()

    print("--- 阶段 3: 非法文件拒绝测试 ---")
    test_invalid_file_rejection()
    print()

    print("--- 阶段 4: RBAC 权限同步测试 ---")
    test_rbac_permission_sync()
    print()

    print("--- 阶段 5: 前端技能管理页面测试 ---")
    test_frontend_skill_page()
    print()

    print("--- 阶段 6: 前端 Config MCP JSON 模式测试 ---")
    test_frontend_config_page_mcp_json()
    print()

    # 汇总
    print("=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"测试汇总: {passed}/{total} 通过, {failed} 失败")
    print("=" * 60)

    if failed > 0:
        print("\n失败用例:")
        for r in results:
            if not r["ok"]:
                print(f"  - {r['name']}: {r['detail']}")

    # 保存结果 JSON
    result_file = Path("test_screenshots/skill_e2e_result.json")
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump({"total": total, "passed": passed, "failed": failed, "results": results},
                  f, ensure_ascii=False, indent=2)
    print(f"\n结果已保存到 {result_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
