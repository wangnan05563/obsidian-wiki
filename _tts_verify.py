import urllib.request, urllib.error, json, os

os.environ.setdefault("no_proxy", "localhost,127.0.0.1")
os.environ["no_proxy"] = "localhost,127.0.0.1"

BASE = "http://localhost:3000/api/tts/synthesize"

def post(payload, timeout=60):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            ct = r.headers.get("Content-Type", "")
            cl = r.headers.get("Content-Length", "")
            return r.status, ct, cl, body
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), "", e.read()
    except Exception as e:
        return "ERR", "", "", str(e).encode()

# 1. 有效短文本 → 期望 200 + audio/mpeg + 真实 MP3
status, ct, cl, body = post({"text": "你好世界，这是语音朗读功能测试。", "voice": "zh-CN-YunyangNeural"})
print(f"[valid]   status={status} content-type={ct} content-length={cl} bytes={len(body)}")
print(f"[valid]   magic={body[:4]!r} (ID3=49,44,33 / 0xFFFB=255,251,0,0)")

# 保存到文件供人工试听
if status == 200 and len(body) > 1000:
    out = r"D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\_tts_verify.mp3"
    with open(out, "wb") as f:
        f.write(body)
    print(f"[valid]   saved -> {out}")

# 2. 超长文本 (5001 字) → 期望 400
longtext = "测" * 5001
status2, ct2, cl2, body2 = post({"text": longtext}, timeout=10)
print(f"[overlen] status={status2} (expect 400) body={body2[:80]!r}")

# 3. 非法音色 → 期望 400
status3, _, _, body3 = post({"text": "你好", "voice": "../../etc/passwd"}, timeout=10)
print(f"[badvoice] status={status3} (expect 400) body={body3[:80]!r}")

# 4. 默认音色 (不传 voice) → 期望 200 + MP3
status4, ct4, cl4, body4 = post({"text": "默认音色测试"}, timeout=60)
print(f"[default] status={status4} content-type={ct4} bytes={len(body4)} magic={body4[:4]!r}")
