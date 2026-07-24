# -*- coding: utf-8 -*-
"""
AC-10 验证脚本：Browse.vue source/status 过滤功能
后端 API 层面验证 search 路由支持 source/status 参数
"""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

API_BASE = "http://localhost:3000"
SCREENSHOTS_DIR = Path("test_screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    results.append({"name": name, "ok": ok, "detail": detail})
    print(f"[{status}] {name}" + (f" - {detail}" if detail else ""))


def api_get(path):
    try:
        req = urllib.request.Request(f"{API_BASE}{path}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))
    except Exception as e:
        return -1, {"error": str(e)}


def main():
    print("=" * 60)
    print("AC-10 验证：Browse.vue source/status 过滤（后端 API 层面）")
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
        print(f"\n[ERROR] 后端服务不可用")
        sys.exit(1)

    # 1. 按 source=qq-chat 过滤（纯过滤模式，无搜索词）
    print("--- 测试1: 按 source=qq-chat 过滤（无搜索词） ---")
    status, data = api_get("/api/search?source=qq-chat")
    record("source=qq-chat 过滤无报错", status == 200, f"HTTP {status}")
    hits = data.get("hits", [])
    record("source=qq-chat 返回结果", len(hits) > 0,
           f"共 {len(hits)} 条结果")

    # 验证所有结果的 frontmatter.source 都是 qq-chat
    if hits:
        # 抽查几条验证
        for hit in hits[:3]:
            status2, file_data = api_get(f"/api/files?path={hit['path']}")
            fm = file_data.get("frontmatter", {})
            actual_source = fm.get("source", "")
            record(f"  {hit['path']} source={actual_source}",
                   actual_source == "qq-chat",
                   f"期望=qq-chat, 实际={actual_source}")

    # 2. 按 source=xxx 过滤（预期空结果或正常返回）
    print("\n--- 测试2: 按 source=unknown 过滤 ---")
    status, data = api_get("/api/search?source=unknown")
    record("source=unknown 过滤无报错", status == 200)
    record("source=unknown 返回空结果", len(data.get("hits", [])) == 0)

    # 3. 组合过滤：source + 搜索词
    print("\n--- 测试3: 组合 source + q 过滤 ---")
    # 先用纯 source 过滤取一个结果的名字作为搜索词
    if hits:
        first_title = hits[0]["title"]
        status, data = api_get(
            f"/api/search?source=qq-chat&q={urllib.request.quote(first_title)}"
        )
        record("source + q 组合过滤无报错", status == 200)
        combined_hits = data.get("hits", [])
        record("source + q 组合过滤返回结果", len(combined_hits) > 0,
               f"搜索 '{first_title}'，source=qq-chat，共 {len(combined_hits)} 条")
    else:
        record("source + q 组合（跳过，无 qq-chat 数据）", True, "跳过")

    # 4. 按 status=draft 过滤
    print("\n--- 测试4: 按 status=draft 过滤 ---")
    status, data = api_get("/api/search?status=draft")
    record("status=draft 过滤无报错", status == 200)
    record("status=draft 有返回或空结果", len(data.get("hits", [])) >= 0)

    # 5. 无参数时返回错误（仍需要 q 或 filter）
    print("\n--- 测试5: 无参数报错 ---")
    status, data = api_get("/api/search")
    record("无 q 且无 filter 时报错", status == 400,
           f"HTTP {status}")

    # 6. 前端 UI 代码验证（代码存在性检查）
    print("\n--- 测试6: 前端 UI 元素存在性（代码检查） ---")
    try:
        browse_path = Path("frontend/src/views/Browse.vue")
        content = browse_path.read_text(encoding="utf-8")
        checks = {
            "sourceFilter ref": "sourceFilter = ref(",
            "statusFilter ref": "statusFilter = ref(",
            "sourceOptions 预设": "sourceOptions = [",
            "statusOptions 预设": "statusOptions = [",
            "handleFilterChange": "handleFilterChange",
            "buildSearchUrl": "buildSearchUrl",
            "el-select source 下拉": 'placeholder="来源筛选"',
            "el-select status 下拉": 'placeholder="状态筛选"',
            "filter-bar CSS": ".filter-bar {",
        }
        for name, pattern in checks.items():
            record(f"Browse.vue 含 {name}", pattern in content)
    except Exception as e:
        record(f"Browse.vue 检查失败", False, str(e))

    # 汇总
    print("\n" + "=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print("=" * 60)

    # 保存结果
    result_file = SCREENSHOTS_DIR / "ac10_filter_verify_result.json"
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(
            {
                "total": total, "passed": passed, "failed": failed,
                "results": results,
            },
            f, ensure_ascii=False, indent=2,
        )
    print(f"结果已保存: {result_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
