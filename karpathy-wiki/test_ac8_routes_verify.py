# -*- coding: utf-8 -*-
"""
AC-8 验证脚本：/api/qq-ingest/* 路由注册无 404
SRS §9 AC-8: 所有 QQ 导入子系统路由必须正确注册，返回非 404

验证策略：
  - GET 路由：直接请求，预期 200（正常）或 400/500（参数错误），但不是 404
  - POST 路由：发送空/无效 body，预期 400（参数校验），但不是 404
  - PUT 路由：发送空 body，预期 200 或 400，但不是 404
  - 路径参数路由：用格式合法但内容不存在的 ID，预期 404（资源不存在），
    但路由本身已注册（区别于"路由未注册"的 404）

关键区分：
  - 路由未注册 404：Fastify 返回 {error:"Route not found"}，statusCode=404
  - 资源不存在 404：路由处理器主动返回 reply.code(404)，含自定义 error message
  AC-8 关注前者，所以需要检查响应体是否为 Fastify 默认 404
"""

import json
import sys
import urllib.request
import urllib.error

API_BASE = "http://localhost:3000"
SCREENSHOTS_DIR = None  # 延迟初始化

results = []


def record(name, ok, status_code, detail=""):
    status = "PASS" if ok else "FAIL"
    results.append({"name": name, "ok": ok, "status": status_code, "detail": detail})
    print(f"[{status}] {name} -> HTTP {status_code}" + (f" - {detail}" if detail else ""))


def check_route(method, path, body=None, headers=None, expect_not_404=True):
    """
    发送请求并返回 (status_code, body_text)
    超时设为 5 秒，避免 SSE 端点长时间阻塞
    """
    url = f"{API_BASE}{path}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        return -1, str(e)
    except Exception as e:
        return -2, str(e)


def is_fastify_default_404(status_code, body_text):
    """
    判断是否为 Fastify 默认 404（路由未注册）
    Fastify 默认 404 响应体格式：{"message":"Route METHOD URL not found","error":"Not Found","statusCode":404}
    路由处理器主动返回的 404 会有自定义 error 字段
    """
    if status_code != 404:
        return False
    try:
        data = json.loads(body_text)
        msg = data.get("message", "") or data.get("error", "")
        # Fastify 默认 404 含 "Route ... not found"
        return "not found" in msg.lower() and "route" in msg.lower()
    except (json.JSONDecodeError, ValueError):
        return False


def main():
    from pathlib import Path
    global SCREENSHOTS_DIR
    SCREENSHOTS_DIR = Path("test_screenshots")
    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    print("=" * 60)
    print("AC-8 验证：/api/qq-ingest/* 路由注册无 404")
    print("=" * 60)

    # 前置检查
    try:
        req = urllib.request.Request(f"{API_BASE}/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                print(f"\n[ERROR] 后端服务不可用")
                sys.exit(1)
        print(f"[OK] 后端服务可用\n")
    except Exception:
        print(f"\n[ERROR] 后端服务不可用，请先启动服务")
        sys.exit(1)

    # 8 个路由的验证用例
    # 为什么这样设计 body：发送最小无效 payload 触发参数校验（400），
    #   而非实际触发 LLM/文件操作（消耗资源且可能超时）
    test_cases = [
        # 1. GET /api/qq-ingest/config - 无参数，预期 200
        {
            "name": "GET /api/qq-ingest/config",
            "method": "GET",
            "path": "/api/qq-ingest/config",
            "body": None,
        },
        # 2. PUT /api/qq-ingest/config - 空对象，预期 200（空更新）或 400
        {
            "name": "PUT /api/qq-ingest/config",
            "method": "PUT",
            "path": "/api/qq-ingest/config",
            "body": {},
        },
        # 3. GET /api/qq-ingest/drafts - 无参数，预期 200
        {
            "name": "GET /api/qq-ingest/drafts",
            "method": "GET",
            "path": "/api/qq-ingest/drafts",
            "body": None,
        },
        # 4. GET /api/qq-ingest/preview/:rawId - 格式合法但内容不存在的 UUID
        #    预期 404（资源不存在），但路由已注册
        {
            "name": "GET /api/qq-ingest/preview/:rawId",
            "method": "GET",
            "path": "/api/qq-ingest/preview/00000000-0000-0000-0000-000000000000",
            "body": None,
        },
        # 5. POST /api/qq-ingest/upload - 无 file 字段，预期 400
        {
            "name": "POST /api/qq-ingest/upload",
            "method": "POST",
            "path": "/api/qq-ingest/upload",
            "body": {},
        },
        # 6. POST /api/qq-ingest/extract/:rawId - 格式合法但内容不存在的 UUID
        #    预期 404（资源不存在），但路由已注册
        {
            "name": "POST /api/qq-ingest/extract/:rawId",
            "method": "POST",
            "path": "/api/qq-ingest/extract/00000000-0000-0000-0000-000000000000",
            "body": None,
        },
        # 7. POST /api/qq-ingest/compile/:draftPath - 无效路径格式，预期 400
        {
            "name": "POST /api/qq-ingest/compile/:draftPath",
            "method": "POST",
            "path": "/api/qq-ingest/compile/invalid",
            "body": None,
        },
        # 8. POST /api/qq-ingest/compile/batch - 含无效路径的 drafts 列表，触发路径校验 400
        # 为什么不用空 body：空 body 会进入"扫描 drafts 目录"分支，若有 draft 文件会启动 SSE 编译导致超时
        {
            "name": "POST /api/qq-ingest/compile/batch",
            "method": "POST",
            "path": "/api/qq-ingest/compile/batch",
            "body": {"drafts": ["invalid/path.md"]},
        },
    ]

    for tc in test_cases:
        status, body_text = check_route(tc["method"], tc["path"], tc["body"])
        # AC-8 通过条件：非 Fastify 默认 404（即路由已注册）
        ok = not is_fastify_default_404(status, body_text)
        # 特殊情况：连接失败
        if status < 0:
            ok = False
        record(tc["name"], ok, status, body_text[:120] if not ok else "")

    # 汇总
    print("\n" + "=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print("=" * 60)

    # 保存结果
    result_file = SCREENSHOTS_DIR / "ac8_routes_verify_result.json"
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
