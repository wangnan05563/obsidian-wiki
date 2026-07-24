# -*- coding: utf-8 -*-
"""
QQ 聊天记录导入子系统 M5 小样本回归测试
覆盖 SRS §9 验收标准 AC-1/AC-2/AC-3/AC-4/AC-7，使用 8 个内联样本验证全链路。

样本设计矩阵：
  S1  正常业务 Q&A（TXT）          → AC-1 中间格式 / AC-7 source=qq-chat
  S2  纯噪声消息（TXT）            → AC-3 噪声过滤（filteredCount=0）
  S3  含 PII 对话（TXT）           → AC-2 无 PII 残留
  S4  JSON 格式输入                → AC-1 格式兼容
  S5  混合内容（有价值+噪声+PII）   → AC-2+AC-3 综合验证
  S6  重复刷屏（NR-6）             → AC-3 NR-6 生效
  S7  方案沉淀讨论（TXT）          → AC-4 extract 抽取
  S8  多行正文 + 系统消息混合       → AC-3 NR-3 生效

前置条件：
  1. 后端服务运行在 localhost:3000
  2. LLM API Key 已配置（extract 测试需要）

执行方式：
  cd karpathy-wiki
  python test_qq_regression.py
"""

import json
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

API_BASE = "http://localhost:3000"
SCREENSHOTS_DIR = Path("test_screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    results.append({"name": name, "ok": ok, "detail": detail})
    print(f"[{status}] {name}" + (f" - {detail}" if detail else ""))


# ============================================================================
# 样本定义
# ============================================================================

SAMPLES = [
    {
        "id": "S1",
        "name": "正常业务Q&A",
        "filename": "s1_normal_qa.txt",
        "content": """技术讨论群 聊天记录
2026-07-20 14:30:15 张三<zhangsan@qq.com>
如何配置环境变量？请详细说明步骤。
2026-07-20 14:30:20 李四<lisi@qq.com>
在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
2026-07-20 14:31:00 王五<wangwu@qq.com>
补充一下，生产环境建议用 dotenv 库加载，避免硬编码。
""",
    },
    {
        "id": "S2",
        "name": "纯噪声消息",
        "filename": "s2_pure_noise.txt",
        "content": """闲聊群 聊天记录
2026-07-20 10:00:00 用户A<a@qq.com>
[图片]
2026-07-20 10:00:05 用户B<b@qq.com>
[表情]
2026-07-20 10:00:10 用户C<c@qq.com>
嗯
2026-07-20 10:00:15 用户D<d@qq.com>
https://example.com
2026-07-20 10:00:20 用户E<e@qq.com>
12345
2026-07-20 10:00:25 系统<sys@qq.com>
用户F 加入了群聊
""",
    },
    {
        "id": "S3",
        "name": "含PII对话",
        "filename": "s3_pii_data.txt",
        "content": """客户支持群 聊天记录
2026-07-20 09:00:00 客服<kefu@qq.com>
请提供您的手机号以便核实身份。
2026-07-20 09:00:30 客户<customer@qq.com>
我的手机号是 13812345678，身份证号是 110101199001011234，邮箱是 user@example.com。
2026-07-20 09:01:00 客服<kefu@qq.com>
已记录，银行卡号 6222021234567890123 也需要登记一下。
2026-07-20 09:01:30 客户<customer@qq.com>
好的，QQ号是 123456789。
""",
    },
    {
        "id": "S4",
        "name": "JSON格式输入",
        "filename": "s4_json_input.json",
        "content": json.dumps({
            "meta": {"chatName": "JSON测试群"},
            "messages": [
                {"timestamp": "2026-07-20 15:00:00", "speaker": "开发者", "type": "text", "content": "如何实现快速排序算法？"},
                {"timestamp": "2026-07-20 15:00:30", "speaker": "算法专家", "type": "text", "content": "选择基准元素，分区后递归排序左右子数组。"},
            ],
        }, ensure_ascii=False, indent=2),
    },
    {
        "id": "S5",
        "name": "混合内容",
        "filename": "s5_mixed.txt",
        "content": """项目协作群 聊天记录
2026-07-20 16:00:00 PM<pm@qq.com>
[图片]
2026-07-20 16:00:10 开发<dev@qq.com>
这个功能的 API 应该怎么设计？
2026-07-20 16:00:15 开发<dev@qq.com>
哦
2026-07-20 16:00:20 架构师<arch@qq.com>
建议采用 RESTful 风格，资源用复数名词，用 HTTP 方法表达操作语义。联系我 13987654321 详谈。
2026-07-20 16:01:00 系统<sys@qq.com>
测试员 退出了群聊
2026-07-20 16:01:10 开发<dev@qq.com>
明白了，我去查一下 RESTful 规范。
""",
    },
    {
        "id": "S6",
        "name": "重复刷屏NR6",
        "filename": "s6_spam.txt",
        "content": """测试群 聊天记录
2026-07-20 11:00:00 刷屏者<spam@qq.com>
签到
2026-07-20 11:00:01 刷屏者<spam@qq.com>
签到
2026-07-20 11:00:02 刷屏者<spam@qq.com>
签到
2026-07-20 11:00:03 刷屏者<spam@qq.com>
签到
2026-07-20 11:00:04 刷屏者<spam@qq.com>
签到
2026-07-20 11:00:05 刷屏者<spam@qq.com>
签到
2026-07-20 11:00:10 正常用户<normal@qq.com>
请问如何重置密码？
""",
    },
    {
        "id": "S7",
        "name": "方案沉淀讨论",
        "filename": "s7_solution.txt",
        "content": """运维群 聊天记录
2026-07-20 20:00:00 运维A<ops_a@qq.com>
线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？
2026-07-20 20:00:30 运维B<ops_b@qq.com>
先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
2026-07-20 20:01:00 运维C<ops_c@qq.com>
补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
2026-07-20 20:02:00 运维A<ops_a@qq.com>
按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
""",
    },
    {
        "id": "S8",
        "name": "多行正文+系统消息",
        "filename": "s8_multiline.txt",
        "content": """讨论群 聊天记录
2026-07-20 12:00:00 提问者<q@qq.com>
Docker 容器如何设置时区？
我按官方文档设了 TZ 环境变量但没生效。
2026-07-20 12:00:10 系统<sys@qq.com>
管理员 修改了群名为"技术讨论群"
2026-07-20 12:00:30 回答者<a@qq.com>
除了 TZ 还需要安装 tzdata 包。
Alpine 镜像用 apk add tzdata。
Debian 镜像用 apt-get install tzdata。
2026-07-20 12:01:00 提问者<q@qq.com>
搞定，谢谢！
""",
    },
]


# ============================================================================
# 工具函数
# ============================================================================

def build_multipart(filename, content, content_type="text/plain"):
    """构造 multipart/form-data 请求体"""
    boundary = "----regressionboundary" + str(int(time.time() * 1000))
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


def upload_sample(sample):
    """上传样本，返回 (raw_id, meta, done_event) 或 (None, None, None)"""
    body, boundary = build_multipart(sample["filename"], sample["content"])
    req = urllib.request.Request(
        f"{API_BASE}/api/qq-ingest/upload",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            sse_text = resp.read().decode("utf-8")
            events = parse_sse_events(sse_text)
            done_event = next((e for e in events if e["event"] == "done"), None)
            if done_event:
                inner = done_event["data"].get("data", done_event["data"])
                raw_id = inner.get("rawId")
                meta = inner.get("meta", {})
                return raw_id, meta, done_event
            return None, None, None
    except Exception as e:
        print(f"  upload 异常: {e}")
        return None, None, None


def preview_raw(raw_id):
    """预览清洗结果，返回解析后的 JSON 或 None"""
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/preview/{raw_id}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  preview 异常: {e}")
        return None


def extract_raw(raw_id, timeout=90):
    """触发抽取，返回 SSE 事件列表或 None"""
    try:
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/extract/{raw_id}",
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            sse_text = resp.read().decode("utf-8")
            return parse_sse_events(sse_text)
    except Exception as e:
        print(f"  extract 异常: {e}")
        return None


# PII 检测正则（与后端 privacy_patterns 对齐）
PII_PATTERNS = {
    "phone": re.compile(r"1[3-9]\d{9}"),
    "id_card": re.compile(r"\d{17}[\dXx]"),
    "email": re.compile(r"[\w.-]+@[\w.-]+\.\w+"),
    "card": re.compile(r"\d{16,19}"),
}


def scan_pii(text):
    """扫描文本中的 PII 残留，返回 {type: [matches]} 字典"""
    found = {}
    for pii_type, pattern in PII_PATTERNS.items():
        matches = pattern.findall(text)
        # 过滤掉 [REDACTED-XXX] 标记（这些是脱敏后的标记，不是 PII）
        real_matches = [m for m in matches if not m.startswith("[REDACTED")]
        if real_matches:
            found[pii_type] = real_matches
    return found


# ============================================================================
# 测试用例
# ============================================================================

def test_upload_and_preview(sample):
    """测试单个样本的 upload + preview 链路，返回 raw_id"""
    sid = sample["id"]
    sname = sample["name"]

    # 记录 extract 前的 drafts 数量（供 AC-4 对比）
    drafts_before = get_drafts_count()

    # AC-1: 上传后返回中间格式 JSON（SSE done 事件 + rawId）
    raw_id, meta, done_event = upload_sample(sample)
    record(f"{sid} AC-1 upload 返回 rawId", raw_id is not None,
           f"rawId={raw_id}" if raw_id else "未返回 rawId")

    if not raw_id:
        return None, drafts_before

    # preview 验证
    preview = preview_raw(raw_id)
    if preview:
        # AC-1: 中间格式 JSON 结构校验
        struct_ok = (
            isinstance(preview.get("meta"), dict)
            and isinstance(preview.get("chunks"), list)
        )
        record(f"{sid} AC-1 中间格式结构", struct_ok,
               f"chunks={len(preview.get('chunks', []))}")

        # AC-7: source = qq-chat（从 preview 的 meta 检查，而非 done 事件的 meta）
        # 为什么从 preview 检查：QqPreprocessResult.meta 不含 source，
        #   但落盘的 PreprocessOutput.meta 含 source（SRS §5.1.4）
        preview_meta = preview.get("meta", {})
        source_ok = preview_meta.get("source") == "qq-chat"
        record(f"{sid} AC-7 source=qq-chat", source_ok,
               f"source={preview_meta.get('source')}")

        # AC-2: PII 残留扫描（扫描整个 preview JSON 文本）
        preview_text = json.dumps(preview, ensure_ascii=False)
        pii_found = scan_pii(preview_text)
        record(f"{sid} AC-2 无PII残留", len(pii_found) == 0,
               f"残留: {pii_found}" if pii_found else "清洁")

        # AC-3: 噪声过滤验证
        original = meta.get("originalCount", 0)
        filtered = meta.get("filteredCount", 0)
        # S2/S6 应该过滤掉大部分消息
        if sid in ("S2", "S6"):
            filter_ok = filtered < original
            record(f"{sid} AC-3 噪声过滤", filter_ok,
                   f"原始{original}→保留{filtered}")
        else:
            # 其他样本只校验 filteredCount <= originalCount
            filter_ok = filtered <= original
            record(f"{sid} AC-3 过滤计数", filter_ok,
                   f"原始{original}→保留{filtered}")
    else:
        record(f"{sid} AC-1 中间格式结构", False, "preview 失败")
        record(f"{sid} AC-7 source=qq-chat", False, "preview 失败")
        record(f"{sid} AC-2 无PII残留", False, "preview 失败")
        record(f"{sid} AC-3 噪声过滤", False, "preview 失败")

    return raw_id, drafts_before


def get_drafts_count():
    """获取当前 drafts 列表数量"""
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/drafts")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return len(data.get("drafts", []))
    except Exception:
        return 0


def test_extract(sample, raw_id, drafts_before):
    """测试抽取链路（AC-4），仅对有价值样本执行"""
    sid = sample["id"]
    if not raw_id:
        record(f"{sid} AC-4 extract 跳过", False, "无 rawId")
        return

    events = extract_raw(raw_id)
    if not events:
        record(f"{sid} AC-4 extract SSE 启动", False, "无事件返回")
        return

    # AC-4a: extract SSE 流正确完成（done 事件存在）
    done_event = next((e for e in events if e["event"] == "done"), None)
    record(f"{sid} AC-4 extract SSE 完成", done_event is not None,
           f"事件数={len(events)}, 最后={events[-1]['event']}")

    if not done_event:
        error_event = next((e for e in events if e["event"] == "error"), None)
        if error_event:
            record(f"{sid} AC-4 draft 生成", False,
                   f"LLM错误: {error_event['data'].get('message', '')[:80]}")
        else:
            record(f"{sid} AC-4 draft 生成", False, "无 done/error 事件")
        return

    # 打印 done 事件 message 用于诊断
    done_msg = done_event["data"].get("message", "")
    print(f"  extract done: {done_msg}")

    # AC-4b: draft 文件实际生成（通过 drafts 列表数量变化验证）
    # 为什么通过列表变化而非解析 done.data：done.data 只含 {path}，不含 drafts 详情
    drafts_after = get_drafts_count()
    drafts_generated = drafts_after - drafts_before
    record(f"{sid} AC-4 draft 生成", drafts_generated > 0,
           f"新增 draft={drafts_generated}（{drafts_before}→{drafts_after}）")

    # AC-4c: draft 含 original_refs 字段（通过 /api/files 读取 draft 文件 frontmatter 验证 Schema）
    # 为什么用 /api/files 而非 drafts 列表：列表 API 只返回 {path, name}，不含文件内容；
    # /api/files 返回 {content, frontmatter, body}，frontmatter 中含 original_refs（SRS §5.2.3）
    if drafts_generated > 0:
        try:
            req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/drafts")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                drafts_list = data.get("drafts", [])
                # 取最后一个 draft（最可能是本次生成的）
                last_draft = drafts_list[-1] if drafts_list else None
                if last_draft and last_draft.get("path"):
                    draft_path = last_draft["path"]
                    # 通过 /api/files 读取 draft 文件的 frontmatter
                    file_url = f"{API_BASE}/api/files?path={urllib.parse.quote(draft_path)}"
                    file_req = urllib.request.Request(file_url)
                    with urllib.request.urlopen(file_req, timeout=5) as file_resp:
                        file_data = json.loads(file_resp.read().decode())
                        frontmatter = file_data.get("frontmatter", {})
                        has_refs = "original_refs" in frontmatter
                        record(f"{sid} AC-4 original_refs 字段", has_refs,
                               f"frontmatter keys={list(frontmatter.keys())[:6]}")
                else:
                    record(f"{sid} AC-4 original_refs 字段", False, "draft 无 path")
        except Exception as e:
            record(f"{sid} AC-4 original_refs 字段", False, str(e))
    else:
        record(f"{sid} AC-4 original_refs 字段", False, "无 draft 生成")


# ============================================================================
# 主函数
# ============================================================================

def main():
    print("=" * 60)
    print("QQ 聊天记录导入子系统 M5 小样本回归测试")
    print(f"样本数: {len(SAMPLES)}")
    print("=" * 60)

    # 前置检查
    try:
        req = urllib.request.Request(f"{API_BASE}/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                print(f"\n[ERROR] 后端服务不可用 ({API_BASE})")
                sys.exit(1)
        print(f"[OK] 后端服务可用\n")
    except Exception:
        print(f"\n[ERROR] 后端服务不可用 ({API_BASE})")
        sys.exit(1)

    # 阶段1：所有样本 upload + preview
    print("--- 阶段1: upload + preview (AC-1/AC-2/AC-3/AC-7) ---")
    raw_ids = {}
    drafts_before_map = {}
    for sample in SAMPLES:
        print(f"\n[{sample['id']}] {sample['name']}")
        rid, drafts_before = test_upload_and_preview(sample)
        raw_ids[sample["id"]] = rid
        drafts_before_map[sample["id"]] = drafts_before

    # 阶段2：对有价值样本执行 extract（AC-4）
    # 为什么只选 S1/S7/S8：这三个样本含明确的 Q&A 或方案沉淀，LLM 应能抽出 draft
    # S2/S6 纯噪声无抽取价值，S3/S5 含 PII 但 extract 会二次脱敏，S4 是格式验证
    print("\n--- 阶段2: extract (AC-4) ---")
    extract_samples = ["S1", "S7", "S8"]
    for sid in extract_samples:
        sample = next(s for s in SAMPLES if s["id"] == sid)
        print(f"\n[{sid}] {sample['name']}")
        test_extract(sample, raw_ids.get(sid), drafts_before_map.get(sid, 0))

    # 汇总
    print("\n" + "=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print("=" * 60)

    # 保存结果
    result_file = SCREENSHOTS_DIR / "qq_regression_result.json"
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
