"""FR-09-2 multimodal SSE 验证脚本

为什么直接用 urllib 而非 requests：避免外部依赖，PowerShell 环境 Python 自带 urllib
为什么手动解析 SSE 而非用 sseclient：SSE 协议简单，手写解析更可控且无依赖
"""
import json
import sys
import urllib.request
import urllib.error

API_URL = "http://localhost:3000/api/query"
TIMEOUT_SEC = 120  # LLM 调用可能较慢，给足超时


def test_mode(mode: str) -> dict:
    """测试单个多模态输出模式，返回事件统计。"""
    print(f"\n=== Testing outputMode={mode} ===")
    body = json.dumps({"question": "什么是 LLM?", "outputMode": mode}).encode('utf-8')
    req = urllib.request.Request(
        API_URL, data=body, method='POST',
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"}
    )

    stats = {"thinking": 0, "answer": 0, "multimodal": 0, "done": 0, "refs": 0, "other": 0}
    multimodal_content = None
    answer_text = []

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            buf = b""
            for chunk in iter(lambda: resp.read(1024), b""):
                buf += chunk
                # SSE 事件以 \n\n 分隔
                while b"\n\n" in buf:
                    event_block, buf = buf.split(b"\n\n", 1)
                    event_lines = event_block.decode('utf-8', errors='replace').splitlines()
                    event_type = None
                    data_str = ""
                    for line in event_lines:
                        if line.startswith("event: "):
                            event_type = line[7:].strip()
                        elif line.startswith("data: "):
                            data_str = line[6:]
                    if not event_type:
                        continue
                    try:
                        data = json.loads(data_str) if data_str else {}
                    except json.JSONDecodeError:
                        data = {"raw": data_str}

                    if event_type == "thinking":
                        stats["thinking"] += 1
                        msg = data.get("message", "")
                        print(f"  [thinking] phase={data.get('phase', '')} msg={msg[:80]}")
                    elif event_type == "answer":
                        stats["answer"] += 1
                        text = data.get("text", "")
                        if text:
                            answer_text.append(text)
                    elif event_type == "multimodal":
                        stats["multimodal"] += 1
                        multimodal_content = data
                        print(f"  [multimodal] type={data.get('type')}, content_len={len(data.get('content', ''))}")
                    elif event_type == "done":
                        stats["done"] += 1
                        print(f"  [done] received")
                    elif event_type == "refs":
                        stats["refs"] += 1
                    else:
                        stats["other"] += 1
                        print(f"  [{event_type}] {str(data)[:80]}")
    except urllib.error.HTTPError as e:
        print(f"  HTTP Error: {e.code} {e.reason}")
        return {"error": f"HTTP {e.code}"}
    except Exception as e:
        print(f"  Error: {e}")
        return {"error": str(e)}

    print(f"  Stats: {stats}")
    if answer_text:
        full = "".join(answer_text)
        print(f"  Answer preview: {full[:200]}...")
    if multimodal_content:
        content = multimodal_content.get("content", "")
        print(f"  Multimodal content preview:")
        print(f"    {content[:500]}")
    return {"stats": stats, "multimodal": multimodal_content, "answer": "".join(answer_text)[:500]}


def main():
    results = {}
    for mode in ["normal", "mindmap", "faq", "timeline"]:
        results[mode] = test_mode(mode)

    print("\n=== Summary ===")
    for mode, r in results.items():
        if "error" in r:
            print(f"  {mode}: ERROR - {r['error']}")
        else:
            stats = r["stats"]
            mm = "YES" if stats["multimodal"] > 0 else "NO"
            print(f"  {mode}: multimodal={mm}, thinking={stats['thinking']}, answer={stats['answer']}, done={stats['done']}")

    # 至少 mindmap/faq/timeline 之一应该有 multimodal 事件
    success = any(
        results[m]["stats"]["multimodal"] > 0
        for m in ["mindmap", "faq", "timeline"]
        if "stats" in results[m]
    )
    print(f"\nResult: {'PASS' if success else 'FAIL'}")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
