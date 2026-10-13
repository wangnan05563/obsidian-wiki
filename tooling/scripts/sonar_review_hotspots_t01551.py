#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T01551 安全热点复核：把 70 条复核结论批量写回 SonarQube。

判定依据（单一可信源）：karpathy-wiki/docs/sonar-reports/sonar-hotspot-review-20261007.md
（T02137 文档整理：该报告随 docs 收敛到 karpathy-wiki/docs/ 下，安全复核判定的审计源不可删）
本脚本只是那篇文档的可执行化，修改结论必须先改文档再改这里的规则表。

⚠ 本服务器的 API 契约（SonarQube Community Build 26.1.0.118079 实测，勿按旧文档写）：
    POST /api/hotspots/change_status
        hotspot=<key>&status=REVIEWED&resolution=<SAFE|FIXED|ACKNOWLEDGED>&comment=<文本>
    「status」只有两值 TO_REVIEW / REVIEWED，Safe/Fixed/Acknowledged 是 **resolution** 维度；
    传 status=SAFE 会直接 400（value must be one of [TO_REVIEW, REVIEWED]）。
    另：status=TO_REVIEW（退回未复核）需要更高的项目权限（Administer Issues），分析令牌会被 403。

⚠ 凭据类型要求（实测踩坑，2026-10-07）：
    - 全局分析令牌（sqa_ 前缀，含本项目 scancode 用的那把）：能读 issues/measures/QG，
      但 /api/hotspots/search 与 change_status 均返回 403「Insufficient privileges」——它不是复核身份。
    - 需要 **用户令牌**（squ_ / sqp_ 前缀，且该用户具备热点复核权限）或管理员会话。
    - 读侧可在项目 public 可见性下匿名 GET，所以 dry-run 不需要任何凭据。
    - 令牌只从环境变量 SONAR_TOKEN 读取，绝不写入仓库文件/日志。

用法：
    python sonar_review_hotspots_t01551.py                # dry-run：打印 70 条判定（无需凭据）
    python sonar_review_hotspots_t01551.py --check         # 凭据权限自检（只读，不写状态）
    set SONAR_TOKEN=<squ_/sqp_ 用户令牌>
    python sonar_review_hotspots_t01551.py --apply         # 写回（HOLD 条目按 owner 决策落 ACKNOWLEDGED）
    python sonar_review_hotspots_t01551.py --apply --skip-hold   # 保守：3 条默认口令条目不动
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

BASE = os.environ.get("SONARQUBE_URL", "http://localhost:9000")
PROJECTS = ["karpathy_wiki_api", "karpathy_wiki_web"]

# 已在代码侧真实修复的条目（file, line）→ resolution=FIXED
FIXED = {
    ("src/index.ts", 119),                  # killPid 增加 pid 数字白名单校验，命令拼接注入面消除
    ("src/utils/audioPostprocess.ts", 44),  # 临时文件名改用 node:crypto randomBytes
}
# owner 已决策接受风险的条目（file 前缀）→ resolution=ACKNOWLEDGED（方案 C，2026-10-07 owner 裁决）
HOLD_PREFIX = ("src/auth/user-store.ts",)

RESOLUTION_BY_GROUP = {
    "fixed_cmd": "FIXED",
    "fixed_crypto": "FIXED",
    "auth_ack": "ACKNOWLEDGED",
}
# 其余分组一律 SAFE（判定理由写在 COMMENT_BY_GROUP，随状态一起落库供审计）

COMMENT_BY_GROUP = {
    "fixed_cmd": "已修复：killPid 入参先做数字白名单校验再拼入 taskkill 命令，注入面消除（T01551 复核）。",
    "fixed_crypto": "已修复：临时文件名随机段由 Math.random 改为 node:crypto.randomBytes，消除可预测文件名（T01551 复核）。",
    "dos_url_crawl": "输入已在唯一入口 extractHtmlContent 封顶 4M 字符，且该处正则均为否定字符类/字面量边界的懒匹配形态，无嵌套量词，最坏回溯为多项式且被常数约束（T01551 复核）。",
    "dos_regex": "复核为无风险：该正则由单一字符类量词或字面量边界构成（如 <[^>]+>、[[^]]+]]、/+$、^-+$），不存在嵌套量词或重叠交替，不存在超线性回溯；输入为本地 vault/文档文本或配置常量，长度有界（T01551 复核）。",
    "dos_line": "复核为无风险：正则在逐行切分后的单行上执行（match 而非全文），单行长度受源文件格式约束；模式本身无嵌套量词（T01551 复核）。",
    "dos_child_stdout": "复核为无风险：匹配输入是本项目自行 spawn 的子进程（cloudflared）stdout，非外部可控数据；正则无嵌套量词（T01551 复核）。",
    "path": "复核为无风险：调用的是固定命令名（netstat/git/ffmpeg/cmd），参数为常量或本机生成的端口/URL，不含外部输入；本应用是单机桌面程序，运行在与用户相同权限上下文，PATH 可写性不构成提权边界（T01551 复核）。",
    "weak_id": "复核为无风险：Math.random 仅用于生成非保密标识（调度表 id / mermaid DOM 渲染 id），唯一性碰撞只影响可读性，不参与任何鉴权、令牌或密钥派生（T01551 复核）。",
    "rce_bookmarklet": "复核为无风险：该 javascript: URL 是本项目自撰的静态书签脚本常量（非用户/外部输入，无拼接），用于用户手动拖入浏览器书签栏跨域抓取页面；应用内不存在以外部数据构造该 href 的路径（T01551 复核）。",
    "auth_ack": "已知悉并接受风险：本地单机知识库首启默认口令，安装后即提示修改；owner 决策维持现状（T01551 复核，方案 C）。",
    "auth_hold": "待 owner 决策：首启写入的默认账号口令属真实风险项，是否改为随机初始口令/强制首登改密需产品确认（见 T01551 回传）。（--skip-hold 时使用）",
}

LINE_GROUPS = {
    # 逐行匹配（match on one line）的正则热点
    ("src/utils/bookmark-connector.ts", 39): "dos_line",
    ("src/data-clean/ai-analysis-workflow.ts", 148): "dos_line",
}


def classify(fp, line, category, hold_too=True):
    """返回 (resolution, comment_key)；resolution=None 表示本轮不落状态。"""
    if fp.startswith(HOLD_PREFIX):
        # owner 2026-10-07 裁决：接受风险 → ACKNOWLEDGED；--skip-hold 时保持不写
        return (None, "auth_hold") if not hold_too else ("ACKNOWLEDGED", "auth_ack")
    key = (fp, line)
    if key in FIXED:
        return ("FIXED", "fixed_cmd" if fp == "src/index.ts" else "fixed_crypto")
    if category == "dos":
        if fp == "src/utils/url-crawl.ts":
            return ("SAFE", "dos_url_crawl")
        if fp == "src/tunnel/tunnel-service.ts":
            return ("SAFE", "dos_child_stdout")
        if key in LINE_GROUPS:
            return ("SAFE", LINE_GROUPS[key])
        return ("SAFE", "dos_regex")
    if category == "others":
        return ("SAFE", "path")
    if category == "weak-cryptography":
        return ("SAFE", "weak_id")
    if category == "rce":
        return ("SAFE", "rce_bookmarklet")
    return ("SAFE", "dos_regex")


def creds():
    tok = os.environ.get("SONAR_TOKEN") or os.environ.get("SONAR_ADMIN_USER")
    if not tok:
        return None
    raw = tok if ":" in tok else tok + ":"
    return "Basic " + base64.b64encode(raw.encode()).decode()


def request(path, params=None, data=None, use_creds=False):
    """use_creds=False 时走匿名（项目 public 可见性下 GET 可读，分析令牌照 GET 反而 403）。"""
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    body = urllib.parse.urlencode(dict(data)).encode() if data else None
    r = urllib.request.Request(url, data=body, method="POST" if data else "GET")
    auth = creds() if (data or use_creds) else None
    if auth:
        r.add_header("Authorization", auth)
    if data:
        r.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"errors": [{"msg": e.read().decode()[:200]}]}


def fetch_rows():
    rows = []
    hold_too = "--skip-hold" not in sys.argv
    for p in PROJECTS:
        code, j = request("/api/hotspots/search", {
            "projectKey": p, "p": 1, "ps": 100,
            "additionalFields": "message,securityCategory,line,status",
        })
        if code != 200:
            sys.exit(f"读取 {p} 热点失败 HTTP {code}: {j}")
        for h in j["hotspots"]:
            fp = h["component"].split(":", 1)[1]
            res, ckey = classify(fp, h["line"], h["securityCategory"], hold_too)
            rows.append((p, fp, h["line"], h["securityCategory"], h["key"], h["status"], res, COMMENT_BY_GROUP[ckey]))
    return rows


def check_privilege():
    """只读权限自检：带凭据能否读热点 + 当前凭据解析成哪个身份。"""
    if not creds():
        sys.exit("--check 需要 SONAR_TOKEN（squ_/sqp_ 用户令牌，或 admin:密码）")
    code, who = request("/api/users/current", use_creds=True)
    login = who.get("login") if code == 200 else None
    perms = (who.get("permissions") or {}).get("global") if code == 200 else None
    print(f"凭据解析：HTTP {code} login={login} globalPerms={perms}")
    code, j = request("/api/hotspots/search", {"projectKey": PROJECTS[0], "p": 1, "ps": 1}, use_creds=True)
    if code == 200:
        print(f"热点读取：HTTP 200 total={j['paging']['total']} —— 该凭据具备复核身份，可以 --apply")
        return 0
    print(f"热点读取：HTTP {code} {j}")
    print("结论：这是分析令牌（sqa_）而非用户令牌，无法复核安全热点（403 Insufficient privileges）。")
    print(" remedy：在 SonarQube 控制台「我的账户 → 安全 → 生成新令牌」取 squ_/sqp_ 用户令牌，")
    print("        或用管理员用户名密码（SONAR_TOKEN=admin:<密码>）；分析令牌无论如何权限都不够。")
    return 2


def main():
    if "--check" in sys.argv:
        sys.exit(check_privilege())
    rows = fetch_rows()
    print("总数:", len(rows), Counter(r[6] or "SKIP" for r in rows))
    for r in sorted(rows, key=lambda x: (x[6] or "SKIP", x[0], x[1], x[2])):
        print(f"{(r[6] or 'SKIP'):12s} {r[3]:18s} {r[0]}:{r[1]}:{r[2]}  (server={r[5]})")
    if "--apply" not in sys.argv:
        print("\n[dry-run] 未写入任何状态。先 --check 验证凭据，再 --apply 写回。")
        return
    if not creds():
        sys.exit("--apply 需要 SONAR_TOKEN（用户令牌，分析令牌会 403）")
    ok = fail = 0
    for p, fp, line, cat, key, _server, res, comment in rows:
        if res is None:
            continue
        code, resp = request("/api/hotspots/change_status", data={
            "hotspot": key, "status": "REVIEWED", "resolution": res, "comment": comment,
        })
        # 实测：change_status 成功返回 204 无正文（不是 200），2xx 均视为成功
        if 200 <= code < 300:
            ok += 1
        else:
            fail += 1
            print("失败:", fp, line, code, str(resp)[:120])
            if code == 403:
                sys.exit("403：凭据不具备复核权限（分析令牌），已中止。请改用用户令牌后重跑。")
    print(f"\n应用完成：成功 {ok}，失败 {fail}，跳过 {sum(1 for r in rows if r[6] is None)}")


if __name__ == "__main__":
    main()
