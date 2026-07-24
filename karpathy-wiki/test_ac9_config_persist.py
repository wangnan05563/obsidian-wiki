# -*- coding: utf-8 -*-
"""
AC-9 验证脚本：QQ 配置可在 Config.vue 编辑并持久化
SRS §9 AC-9: QQ 配置可在 Config.vue 编辑并持久化

验证策略：
  后端 API 持久化闭环（本脚本）：
    1. GET /api/qq-ingest/config 获取当前配置（基线）
    2. 修改 max_batch_size 为新值
    3. PUT /api/qq-ingest/config 保存
    4. GET /api/qq-ingest/config 再次获取，验证值已持久化
    5. 恢复原始值并保存

  前端 UI 实现（代码层面分析，已在 Config.vue 中验证）：
    - loadQqConfig() → GET /api/qq-ingest/config → 填充表单
    - saveQqConfigForm() → PUT /api/qq-ingest/config → 持久化
    - el-tab-pane label="QQ 导入" name="qq" 提供 UI 入口
    - el-input/el-input-number v-model 双向绑定
    - ElMessage 成功/失败提示
    - 表单校验（max_batch_size 1-200, chunk_threshold 50-2000）
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


def api_call(method, path, body=None):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))
    except Exception as e:
        return -1, {"error": str(e)}


def main():
    print("=" * 60)
    print("AC-9 验证：QQ 配置编辑并持久化（后端 API 闭环）")
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

    # 步骤1：GET 当前配置（基线）
    print("--- 步骤1: 获取当前 QQ 配置（基线） ---")
    status, config_before = api_call("GET", "/api/qq-ingest/config")
    qq_before = config_before.get("qq", {})
    original_max_batch = qq_before.get("max_batch_size", 20)
    record("GET /api/qq-ingest/config", status == 200,
           f"max_batch_size={original_max_batch}")

    # 步骤2：修改 max_batch_size 为新值
    print(f"\n--- 步骤2: 修改 max_batch_size ---")
    # 选择一个不同于当前值的新值（在 1-200 范围内）
    new_max_batch = 30 if original_max_batch != 30 else 35
    print(f"  原值: {original_max_batch} → 新值: {new_max_batch}")

    update_payload = {
        "qq": {
            "noise_rules": qq_before.get("noise_rules", {}),
            "privacy_patterns": qq_before.get("privacy_patterns", {}),
            "max_batch_size": new_max_batch,
            "chunk_threshold": qq_before.get("chunk_threshold", 200),
            "extract_model": qq_before.get("extract_model", "agnes-2.0-flash"),
            "extract_base_url": qq_before.get("extract_base_url", ""),
            "extract_token_budget": qq_before.get("extract_token_budget", 50000),
        }
    }

    status, resp = api_call("PUT", "/api/qq-ingest/config", update_payload)
    record("PUT /api/qq-ingest/config（修改 max_batch_size）", status == 200,
           f"status={status}, resp={json.dumps(resp, ensure_ascii=False)[:100]}")

    # 步骤3：GET 验证持久化
    print(f"\n--- 步骤3: 验证持久化（GET 重新读取） ---")
    status, config_after = api_call("GET", "/api/qq-ingest/config")
    qq_after = config_after.get("qq", {})
    persisted_max_batch = qq_after.get("max_batch_size", -1)
    is_persisted = persisted_max_batch == new_max_batch
    record("配置已持久化到后端", is_persisted,
           f"期望={new_max_batch}, 实际={persisted_max_batch}")

    # 步骤4：验证其他字段未被意外修改
    original_chunk = qq_before.get("chunk_threshold", 200)
    persisted_chunk = qq_after.get("chunk_threshold", -1)
    record("其他字段未被意外修改（chunk_threshold）",
           original_chunk == persisted_chunk,
           f"原值={original_chunk}, 实际={persisted_chunk}")

    original_model = qq_before.get("extract_model", "")
    persisted_model = qq_after.get("extract_model", "")
    record("其他字段未被意外修改（extract_model）",
           original_model == persisted_model,
           f"原值={original_model}, 实际={persisted_model}")

    # 步骤5：恢复原始值
    print(f"\n--- 步骤5: 恢复原始值 ---")
    restore_payload = {
        "qq": {
            "noise_rules": qq_before.get("noise_rules", {}),
            "privacy_patterns": qq_before.get("privacy_patterns", {}),
            "max_batch_size": original_max_batch,
            "chunk_threshold": qq_before.get("chunk_threshold", 200),
            "extract_model": qq_before.get("extract_model", ""),
            "extract_base_url": qq_before.get("extract_base_url", ""),
            "extract_token_budget": qq_before.get("extract_token_budget", 50000),
        }
    }
    status, resp = api_call("PUT", "/api/qq-ingest/config", restore_payload)
    record("恢复原始值", status == 200, f"max_batch_size 恢复为 {original_max_batch}")

    # 步骤6：验证恢复成功
    status, config_restored = api_call("GET", "/api/qq-ingest/config")
    qq_restored = config_restored.get("qq", {})
    restored_max_batch = qq_restored.get("max_batch_size", -1)
    is_restored = restored_max_batch == original_max_batch
    record("恢复后值正确", is_restored,
           f"期望={original_max_batch}, 实际={restored_max_batch}")

    # 汇总
    print("\n" + "=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print("=" * 60)

    # 保存结果
    result_file = SCREENSHOTS_DIR / "ac9_config_persist_result.json"
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(
            {
                "total": total, "passed": passed, "failed": failed,
                "results": results,
                "frontend_analysis": {
                    "loadQqConfig": "Config.vue line 1077: GET /api/qq-ingest/config → 填充表单",
                    "saveQqConfigForm": "Config.vue line 1099: PUT /api/qq-ingest/config → 持久化",
                    "ui_entry": "Config.vue line 1941: el-tab-pane label='QQ 导入' name='qq'",
                    "form_binding": "v-model 双向绑定 qqConfig reactive 对象",
                    "validation": "max_batch_size 1-200, chunk_threshold 50-2000, extract_token_budget 0-1000000",
                    "user_feedback": "ElMessage.success/error 提示保存结果",
                },
            },
            f, ensure_ascii=False, indent=2,
        )
    print(f"结果已保存: {result_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
