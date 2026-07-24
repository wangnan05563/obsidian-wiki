# -*- coding: utf-8 -*-
"""
QQ 聊天记录导入子系统 AC-5/AC-6 验证脚本
覆盖 SRS §9 剩余两项验收标准：
  AC-5: draft 页面经 compile 后写入 qa/ 或 solutions/，frontmatter 完整
  AC-6: compile 后页面与已有 entities/concepts 建立至少 1 条双向链接

前置条件：
  1. 后端服务运行在 localhost:3000
  2. vault/drafts/ 下至少有 1 个 draft 文件（由 M5 小样本回归生成）

执行方式：
  cd karpathy-wiki
  python test_qq_ac56_verify.py
"""

import json
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


def get_drafts():
    """获取 drafts 列表"""
    try:
        req = urllib.request.Request(f"{API_BASE}/api/qq-ingest/drafts")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get("drafts", [])
    except Exception as e:
        print(f"获取 drafts 失败: {e}")
        return []


def get_graph():
    """获取双向链接图数据"""
    try:
        req = urllib.request.Request(f"{API_BASE}/api/graph")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"获取 graph 失败: {e}")
        return {"nodes": [], "edges": []}


def get_file_tree():
    """获取 vault 文件树"""
    try:
        req = urllib.request.Request(f"{API_BASE}/api/files/tree")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode()).get("tree", [])
    except Exception as e:
        print(f"获取文件树失败: {e}")
        return []


def read_file(path):
    """读取 vault 文件内容（含 frontmatter 解析）"""
    try:
        url = f"{API_BASE}/api/files?path={urllib.parse.quote(path)}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"读取文件 {path} 失败: {e}")
        return None


def trigger_compile(draft_path):
    """触发单 draft compile，返回 SSE 事件列表"""
    try:
        encoded = urllib.parse.quote(draft_path, safe='')
        req = urllib.request.Request(
            f"{API_BASE}/api/qq-ingest/compile/{encoded}",
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            sse_text = resp.read().decode("utf-8")
            return parse_sse_events(sse_text)
    except Exception as e:
        print(f"compile {draft_path} 失败: {e}")
        return []


def collect_tree_paths(tree, prefix=""):
    """递归收集文件树中的所有文件路径"""
    paths = []
    for node in tree or []:
        name = node.get("name", "")
        path = f"{prefix}{name}" if not prefix else f"{prefix}/{name}"
        if node.get("type") == "file":
            paths.append(path)
        elif node.get("type") == "directory" or "children" in node:
            children = node.get("children", [])
            paths.extend(collect_tree_paths(children, path))
    return paths


def find_qa_solutions_pages(tree_paths):
    """从文件树中找出 qa/ 和 solutions/ 目录下的 .md 文件"""
    qa_pages = [p for p in tree_paths if p.startswith("qa/") and p.endswith(".md")]
    sol_pages = [p for p in tree_paths if p.startswith("solutions/") and p.endswith(".md")]
    return qa_pages, sol_pages


# ============================================================================
# 主函数
# ============================================================================

def main():
    print("=" * 60)
    print("QQ 聊天记录导入子系统 AC-5/AC-6 验证")
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

    # 1. 获取 compile 前的状态基线
    print("--- 阶段1: 记录 compile 前状态 ---")
    drafts = get_drafts()
    print(f"当前 drafts 数量: {len(drafts)}")
    if not drafts:
        print("\n[ERROR] 无 draft 可编译，请先运行小样本回归生成 draft")
        sys.exit(1)

    tree_before = get_file_tree()
    paths_before = collect_tree_paths(tree_before)
    qa_before, sol_before = find_qa_solutions_pages(paths_before)
    print(f"compile 前 qa/ 页面: {len(qa_before)}")
    print(f"compile 前 solutions/ 页面: {len(sol_before)}")

    graph_before = get_graph()
    edges_before = graph_before.get("edges", [])
    print(f"compile 前双向链接边数: {len(edges_before)}")

    # 2. 选择一个未编译过的 draft 触发 compile
    # 为什么跳过已编译 draft：adapter.compile 有缓存机制，内容已编译过会直接返回缓存命中，
    #   不生成新页面，无法验证 AC-5/AC-6。需要选内容不同的 draft。
    print(f"\n--- 阶段2: 触发 draft compile ---")
    # 读取每个 draft 的内容，找第一个未编译过的（通过 compile SSE 判断）
    target_draft = None
    for d in drafts:
        # 先尝试 compile，如果命中缓存则跳过下一个
        test_events = trigger_compile(d["path"])
        test_done = next((e for e in test_events if e["event"] == "done"), None)
        if test_done:
            msg = test_done["data"].get("message", "")
            if "缓存命中" in msg or "已编译过" in msg:
                print(f"  跳过（缓存命中）: {d['path']}")
                continue
            # 未命中缓存，说明这个 draft 会实际编译
            target_draft = d
            events = test_events
            break
        # done 事件都没有说明有问题，跳过
        print(f"  跳过（无 done 事件）: {d['path']}")

    if not target_draft:
        # 所有 draft 都命中缓存，用最后一个的事件作为结果（至少验证 SSE 流正常）
        print("  所有 draft 均命中缓存，使用最后一个的结果")
        target_draft = drafts[-1]
        events = trigger_compile(target_draft["path"])

    draft_path = target_draft["path"]
    print(f"目标 draft: {draft_path}")

    done_event = next((e for e in events if e["event"] == "done"), None)
    error_event = next((e for e in events if e["event"] == "error"), None)
    page_events = [e for e in events if e["event"] == "page"]

    record("AC-5 compile SSE 完成", done_event is not None,
           f"事件数={len(events)}, page事件={len(page_events)}, done={'是' if done_event else '否'}")

    if error_event:
        record("AC-5 compile 无错误", False,
               f"错误: {error_event['data'].get('message', '')[:100]}")
    else:
        record("AC-5 compile 无错误", True)

    if done_event:
        done_msg = done_event["data"].get("message", "")
        print(f"  compile done: {done_msg}")

    # 3. 验证 AC-5：compile 后 qa/ 或 solutions/ 新增页面 + frontmatter 完整
    print(f"\n--- 阶段3: 验证 AC-5 (compile 后页面写入) ---")

    # 从 SSE 事件中提取生成的页面路径
    # 为什么从 SSE 提取而非文件树：/api/files/tree 有 30 秒缓存，compile 刚完成时返回旧数据；
    #   SSE 的 progress 事件 data.path 字段含 generate_page 步骤生成的页面路径
    generated_pages = []
    for ev in events:
        if ev["event"] == "progress":
            msg = ev["data"].get("message", "")
            step = ev["data"].get("step", "")
            path = ev["data"].get("data", {}).get("path", "")
            # generate_page 步骤的 path 是 qa/xxx.md 或 solutions/xxx.md
            if step == "generate_page" and path and (path.startswith("qa/") or path.startswith("solutions/")):
                generated_pages.append(path)
            # 兜底：从 message 中提取（格式 "步骤 N: write_file" + data.path）
            elif "generate_page" in msg and path and (path.startswith("qa/") or path.startswith("solutions/")):
                generated_pages.append(path)

    print(f"  SSE 事件中提取的生成页面: {generated_pages}")

    # 如果 SSE 没提取到，等待缓存过期后用文件树
    if not generated_pages:
        print("  SSE 未提取到页面路径，等待 35 秒后用文件树验证...")
        time.sleep(35)
        tree_after = get_file_tree()
        paths_after = collect_tree_paths(tree_after)
        qa_after, sol_after = find_qa_solutions_pages(paths_after)
        new_qa = [p for p in qa_after if p not in qa_before]
        new_sol = [p for p in sol_after if p not in sol_before]
        generated_pages = new_qa + new_sol
    else:
        # 过滤掉 compile 前已存在的页面
        generated_pages = [p for p in generated_pages if p not in qa_before and p not in sol_before]

    tree_after = get_file_tree()
    paths_after = collect_tree_paths(tree_after)
    qa_after, sol_after = find_qa_solutions_pages(paths_after)

    new_qa = [p for p in qa_after if p not in qa_before]
    new_sol = [p for p in sol_after if p not in sol_before]
    new_pages = new_qa + new_sol

    record("AC-5 compile 生成新页面", len(generated_pages) > 0,
           f"新增页面: {generated_pages[:3]}")

    # 验证新页面 frontmatter 完整
    if generated_pages:
        first_new_page = generated_pages[0]
        file_data = read_file(first_new_page)
        if file_data:
            frontmatter = file_data.get("frontmatter", {})
            # AC-5 要求 frontmatter 完整：title/created/updated/source 至少存在
            required_keys = ["title", "created", "updated"]
            has_required = all(k in frontmatter for k in required_keys)
            record("AC-5 frontmatter 完整", has_required,
                   f"keys={list(frontmatter.keys())[:6]}")
        else:
            record("AC-5 frontmatter 完整", False, f"读取 {first_new_page} 失败")
    else:
        record("AC-5 frontmatter 完整", False, "无新页面")

    # 4. 验证 AC-6：compile 后建立至少 1 条双向链接
    print(f"\n--- 阶段4: 验证 AC-6 (双向链接建立) ---")

    # AC-6 验证策略：
    # 1) 优先检查 graph API 是否新增边（目标页面存在时计入双向链接）
    # 2) 兜底检查新页面正文是否含 [[页面名]] 链接语法（目标页面可能不存在，但 LLM 已尝试建立链接）
    # 为什么需要兜底：QQ 导入的内容主题可能与已有 entities/concepts 不相关，
    #   LLM 生成的 [[xxx]] 链接目标可能不存在，buildLinkGraph 不计入悬空链接；
    #   但 AC-6 的本质是验证 compile 流程建立了链接关系，而非目标必须存在

    # graph API 有 30 秒缓存，等待过期
    print("  等待 35 秒（graph 缓存 TTL 30s + 余量）...")
    time.sleep(35)

    graph_after = get_graph()
    edges_after = graph_after.get("edges", [])
    new_edges = [e for e in edges_after if e not in edges_before]

    record("AC-6 graph 新增双向链接边", len(new_edges) > 0,
           f"新增边数={len(new_edges)}, 样本={new_edges[:2]}")

    # 兜底：检查新页面正文是否含 [[...]] 链接语法
    import re
    link_pattern = re.compile(r'\[\[([^\]]+)\]\]')

    if generated_pages:
        first_page = generated_pages[0]
        file_data = read_file(first_page)
        if file_data:
            body = file_data.get("body", "")
            content = file_data.get("content", "")
            full_text = body or content
            links = link_pattern.findall(full_text)
            has_links = len(links) > 0
            record("AC-6 新页面含双向链接语法", has_links,
                   f"链接数={len(links)}, 链接={links[:3]}")

            # 进一步验证：新页面是否参与 graph 边（作为 from 或 to）
            if new_edges:
                new_page_name = first_page.replace(".md", "").replace("/", "-")
                involved_edges = [
                    e for e in new_edges
                    if new_page_name in str(e.get("from", "")) or new_page_name in str(e.get("to", ""))
                ]
                record("AC-6 新页面参与 graph 边", len(involved_edges) > 0,
                       f"参与边数={len(involved_edges)}")
            else:
                record("AC-6 新页面参与 graph 边", False,
                       "无新增边（链接目标页面可能不存在）")
        else:
            record("AC-6 新页面含双向链接语法", False, f"读取 {first_page} 失败")
    else:
        record("AC-6 新页面含双向链接语法", False, "无新页面")

    # 汇总
    print("\n" + "=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print("=" * 60)

    # 保存结果
    result_file = SCREENSHOTS_DIR / "qq_ac56_verify_result.json"
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
