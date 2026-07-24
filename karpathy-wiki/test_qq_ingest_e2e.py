# -*- coding: utf-8 -*-
"""
QQ 聊天记录导入子系统 E2E 全链路测试脚本
覆盖 SRS §6.1 路由族 8 个端点的 HTTP 级测试 + 前端 UI 可达性测试。

前置条件：
  1. 后端服务运行在 localhost:3000（scripts/启动服务.bat 或 pnpm dev:api）
  2. 前端服务运行在 localhost:5173（pnpm dev:web）
  3. Playwright Python + Chromium 已安装

执行方式：
  cd karpathy-wiki
  python test_qq_ingest_e2e.py

设计决策：
  - extract/compile 端点依赖 LLM API，E2E 中只验证 SSE 流正确启动与事件格式，
    不深度验证 LLM 输出质量（那是小样本回归的任务）
  - 使用 urllib 而非 requests：减少外部依赖，与 test_skill_e2e.py 保持一致
  - 使用自定义 record 而非 pytest：与项目现有 E2E 脚本模式一致
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Playwright 未安装，请运行: pip install playwright && playwright install chromium", file=sys.stderr)
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


# ============================================================================
# 工具函数
# ============================================================================

def check_service_available():
    """检查后端服务是否可用，不可用则提前退出"""
    try:
        req = urllib.request.Request(f"{API_BASE}/health", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def build_multipart(filename, content, content_type="text/plain"):
    """构造 multipart/form-data 请求体"""
    boundary = "----vitestboundary" + str(int(time.time() * 1000))
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
        f"{content}\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    return body, boundary


def parse_sse_events(text):
    """解析 SSE 响应文本为事件列表"""
    events = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        event = ""
        data_str = ""
        for line in block.split("\n"):
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data_str += line[6:]
        if event:
            try:
                data = json.loads(data_str) if data_str else {}
            except json.JSONDecodeError:
                data = data_str
            events.append({"event": event, "data": data})
    return events


def extract_raw_id_from_sse(sse_text):
    """从 upload SSE 响应中提取 rawId"""
    events = parse_sse_events(sse_text)
    for ev in events:
        if ev["event"] == "done":
            data = ev["data"]
            # done 事件结构: { data: { rawId: "...", rawPath: "...", meta: {...} } }
            inner = data.get("data", data)
            return inner.get("rawId")
    return None


# ============================================================================
# 后端 API 测试
# ============================================================================

def test_qq_config_endpoints():
    """测试 GET/PUT /api/qq-ingest/config"""
    # 1. GET /api/qq-ingest/config - 返回配置
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/config")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            ok = "qq" in data and "noise_rules" in data["qq"] and "privacy_patterns" in data["qq"]
            record("GET /api/qq-ingest/config 返回配置", ok,
                   f"字段: {list(data.get('qq', {}).keys())[:5]}")
    except Exception as e:
        record("GET /api/qq-ingest/config 返回配置", False, str(e))

    # 2. PUT /api/qq-ingest/config - 部分更新（仅改 chunk_threshold，避免破坏其他配置）
    try:
        body = json.dumps({"chunk_threshold": 150}).encode("utf-8")
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/config",
            data=body,
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            ok = data.get("qq", {}).get("chunk_threshold") == 150
            record("PUT /api/qq-ingest/config 部分更新", ok,
                   f"chunk_threshold={data.get('qq', {}).get('chunk_threshold')}")
            # 恢复默认值，避免影响后续测试
            restore_body = json.dumps({"chunk_threshold": 200}).encode("utf-8")
            restore_req = urllib.request.Request(
                f"{API_BASE}/api/qq-ingest/config",
                data=restore_body,
                headers={"Content-Type": "application/json"},
                method="PUT",
            )
            urllib.request.urlopen(restore_req, timeout=5)
    except Exception as e:
        record("PUT /api/qq-ingest/config 部分更新", False, str(e))


def test_qq_upload_and_preview():
    """测试 POST /api/qq-ingest/upload + GET /api/qq-ingest/preview/:rawId 全链路"""
    raw_id = None

    # 1. POST /api/qq-ingest/upload - 上传 TXT 文件
    try:
        txt_content = """测试群 聊天记录
2026-07-20 14:30:15 张三<zhangsan@qq.com>
如何配置环境变量？请详细说明步骤。
2026-07-20 14:30:20 李四<lisi@qq.com>
在 .env 文件中添加 CONFIG_KEY=value 即可，重启服务后生效。"""
        body, boundary = build_multipart("e2e-test.txt", txt_content)
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/upload",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        # SSE 流在 safeEnd 后结束，urllib 能正常接收完整响应
        with urllib.request.urlopen(req, timeout=30) as resp:
            sse_text = resp.read().decode("utf-8")
            events = parse_sse_events(sse_text)
            done_event = next((e for e in events if e["event"] == "done"), None)
            ok = done_event is not None
            if ok:
                raw_id = extract_raw_id_from_sse(sse_text)
                meta = done_event["data"].get("data", {}).get("meta", {})
                detail = f"rawId={raw_id}, filteredCount={meta.get('filteredCount')}"
            else:
                detail = "未找到 done 事件"
            record("POST /api/qq-ingest/upload TXT 上传", ok, detail)
    except Exception as e:
        record("POST /api/qq-ingest/upload TXT 上传", False, str(e))

    # 2. GET /api/qq-ingest/preview/:rawId - 预览清洗结果
    if raw_id:
        try:
            req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/preview/{raw_id}")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                ok = (
                    data.get("meta", {}).get("source") == "qq-chat"
                    and isinstance(data.get("chunks"), list)
                    and len(data["chunks"]) > 0
                )
                record("GET /api/qq-ingest/preview/:rawId 预览", ok,
                       f"chatName={data.get('meta', {}).get('chatName')}, chunks={len(data.get('chunks', []))}")
        except Exception as e:
            record("GET /api/qq-ingest/preview/:rawId 预览", False, str(e))
    else:
        record("GET /api/qq-ingest/preview/:rawId 预览", False, "跳过：upload 未返回 rawId")

    # 3. GET /api/qq-ingest/preview/:rawId - 无效 rawId 格式
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/preview/invalid-uuid")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                record("GET /api/qq-ingest/preview 无效 rawId 格式", False, f"应返回 400 但实际 {resp.status}")
        except urllib.error.HTTPError as e:
            record("GET /api/qq-ingest/preview 无效 rawId 格式", e.code == 400, f"状态码={e.code}")
    except Exception as e:
        record("GET /api/qq-ingest/preview 无效 rawId 格式", False, str(e))

    return raw_id


def test_qq_drafts_endpoint():
    """测试 GET /api/qq-ingest/drafts"""
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/drafts")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            ok = "drafts" in data and isinstance(data["drafts"], list)
            record("GET /api/qq-ingest/drafts 列表", ok, f"drafts 数量={len(data.get('drafts', []))}")
    except Exception as e:
        record("GET /api/qq-ingest/drafts 列表", False, str(e))


def test_qq_extract_sse(raw_id):
    """测试 POST /api/qq-ingest/extract/:rawId SSE 流启动
    为什么只验证流启动：extract 依赖 LLM API，E2E 环境可能无有效 API Key，
      深度验证 LLM 输出质量属于小样本回归的任务范围
    """
    if not raw_id:
        record("POST /api/qq-ingest/extract/:rawId SSE 启动", False, "跳过：无 rawId")
        return

    try:
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/extract/{raw_id}",
            method="POST",
        )
        # extract 可能调用 LLM API，超时设 60s 兜底
        with urllib.request.urlopen(req, timeout=60) as resp:
            sse_text = resp.read().decode("utf-8")
            events = parse_sse_events(sse_text)
            # 至少应有一个事件（done 或 error 都算流正常启动）
            ok = len(events) > 0
            last_event = events[-1]["event"] if events else "none"
            record("POST /api/qq-ingest/extract/:rawId SSE 启动", ok,
                   f"事件数={len(events)}, 最后事件={last_event}")
    except Exception as e:
        # LLM API 错误也会通过 SSE error 事件返回，HTTP 层应 200
        record("POST /api/qq-ingest/extract/:rawId SSE 启动", False, str(e))


def test_qq_compile_batch_validation():
    """测试 POST /api/qq-ingest/compile/batch 参数校验（不实际编译）"""
    # 1. 无效 draftPath 应返回 400
    try:
        body = json.dumps({"drafts": ["entities/foo.md"]}).encode("utf-8")
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/compile/batch",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                record("POST /api/qq-ingest/compile/batch 无效路径", False, f"应返回 400 但实际 {resp.status}")
        except urllib.error.HTTPError as e:
            record("POST /api/qq-ingest/compile/batch 无效路径", e.code == 400, f"状态码={e.code}")
    except Exception as e:
        record("POST /api/qq-ingest/compile/batch 无效路径", False, str(e))

    # 2. 空 drafts 列表应返回 400
    try:
        body = json.dumps({"drafts": []}).encode("utf-8")
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/compile/batch",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                record("POST /api/qq-ingest/compile/batch 空列表", False, f"应返回 400 但实际 {resp.status}")
        except urllib.error.HTTPError as e:
            record("POST /api/qq-ingest/compile/batch 空列表", e.code == 400, f"状态码={e.code}")
    except Exception as e:
        record("POST /api/qq-ingest/compile/batch 空列表", False, str(e))


def test_qq_path_traversal_protection():
    """路径穿越防护测试"""
    # GET /api/qq-ingest/preview/../../etc/passwd 应返回 400（不匹配 UUID 正则）
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/preview/..%2F..%2Fetc%2Fpasswd")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                record("路径穿越防护 (preview)", False, f"应返回 4xx 但实际 {resp.status}")
        except urllib.error.HTTPError as e:
            ok = 400 <= e.code < 500
            record("路径穿越防护 (preview)", ok, f"状态码={e.code}")
    except Exception as e:
        record("路径穿越防护 (preview)", False, str(e))


# ============================================================================
# 前端 UI 测试
# ============================================================================

def test_qq_frontend_ui():
    """测试 QQ 导入子系统前端 UI 可达性"""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-setuid-sandbox",
            ],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        console_errors = []
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
        )

        try:
            # 登录
            # 为什么用 domcontentloaded：背景图持续加载会导致 networkidle 永不触发
            page.goto(f"{FRONTEND_URL}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_selector("#login-username", state="visible", timeout=10000)
            page.fill("#login-username", "admin")
            page.fill("#login-password", "admin123")
            page.click(".login-btn")
            page.wait_for_selector(".nav-tabs", state="visible", timeout=10000)
            record("前端登录", True, "admin 登录成功")

            # 导航到 Ingest 页面（知识导入）
            # 为什么用 text 定位：tab-btn 的 key 属性不暴露在 DOM，text 更稳定
            # 为什么用"投递资料"：menuItems 中 ingest 的 label 是"投递资料"（App.vue §38-52）
            ingest_tab = page.locator(".tab-btn", has_text="投递资料")
            if ingest_tab.count() > 0:
                ingest_tab.first.click()
                page.wait_for_timeout(1000)
                record("导航到 Ingest 页面", True)

                # 检查 QQ 聊天记录 Tab 是否存在
                # 为什么用 has_text：Tab 标题可能含"QQ 聊天记录"或"QQ 导入"
                qq_tab = page.locator("text=/QQ.*聊天|QQ.*导入/")
                if qq_tab.count() > 0:
                    record("QQ 聊天记录 Tab 可见", True, f"匹配到 {qq_tab.count()} 个元素")
                    # 点击 Tab 验证无报错
                    qq_tab.first.click()
                    page.wait_for_timeout(500)
                    record("QQ 聊天记录 Tab 可点击", True)
                else:
                    record("QQ 聊天记录 Tab 可见", False, "未找到 QQ 相关 Tab")
            else:
                record("导航到 Ingest 页面", False, "未找到导入标签")

            # 截图存档
            page.screenshot(path=str(SCREENSHOTS_DIR / "qq_ingest_e2e.png"))
            record("截图保存", True, str(SCREENSHOTS_DIR / "qq_ingest_e2e.png"))

        except Exception as e:
            page.screenshot(path=str(SCREENSHOTS_DIR / "qq_ingest_e2e_error.png"))
            record("前端 UI 测试", False, str(e))
        finally:
            # 控制台错误检查（过滤 favicon 等噪音）
            real_errors = [
                e for e in console_errors
                if "favicon" not in e.lower()
                and "Failed to load resource" not in e
                and "net::ERR" not in e
            ]
            record("控制台无关键错误", len(real_errors) == 0,
                   f"错误数={len(real_errors)}, 样本={real_errors[:2]}")
            browser.close()


# ============================================================================
# 主函数
# ============================================================================

def main():
    print("=" * 60)
    print("QQ 聊天记录导入子系统 E2E 测试")
    print("=" * 60)

    # 前置检查：服务可用性
    if not check_service_available():
        print(f"\n[ERROR] 后端服务不可用 ({API_BASE})，请先启动服务")
        print("  启动方式: scripts/启动服务.bat 或 pnpm dev:api + pnpm dev:web")
        sys.exit(1)
    print(f"[OK] 后端服务可用 ({API_BASE})\n")

    # 后端 API 测试
    print("--- 后端 API 测试 ---")
    test_qq_config_endpoints()
    raw_id = test_qq_upload_and_preview()
    test_qq_drafts_endpoint()
    test_qq_extract_sse(raw_id)
    test_qq_compile_batch_validation()
    test_qq_path_traversal_protection()

    # 前端 UI 测试
    print("\n--- 前端 UI 测试 ---")
    test_qq_frontend_ui()

    # 汇总
    print("\n" + "=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print("=" * 60)

    # 保存结果 JSON
    result_file = SCREENSHOTS_DIR / "qq_ingest_e2e_result.json"
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(
            {"total": total, "passed": passed, "failed": failed, "results": results},
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"结果已保存: {result_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
