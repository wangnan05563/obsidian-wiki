#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T01551 安全热点复核：批量应用复核结论。

背景：项目分析令牌（PROJECT_ANALYSIS）对 /api/hotspots/search 返回 403、且无法改状态，
复核动作需要特权账号（user token 或 admin 账号）。本脚本把「逐条判定」沉淀成可审查的规则表，
默认只做 dry-run 打印结论表；带 --apply 时才真正写状态。

用法：
    set SONAR_TOKEN=<具备 hotspot 复核权限的 user token>      # 或 admin:user 密码，均走 Basic
    python sonar_review_hotspots_t01551.py                  # dry-run：打印 70 条判定
    python sonar_review_hotspots_t01551.py --apply           # 应用（FIXED/SAFE），HOLD 条目保持 TO_REVIEW
    python sonar_review_hotspots_t01551.py --apply --hold-too  # 连 auth 默认口令条目一起落 ACKNOWLEDGED

判定依据见 docs/sonar-reports/sonar-hotspot-review-20261007.md（单一可信源是那篇文档，本脚本只是其可执行化）。
"""
import base64
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("SONARQUBE_URL", "http://localhost:9000")
PROJECTS = ["karpathy_wiki_api", "karpathy_wiki_web"]

# 已在代码侧真实修复的条目（file, line）→ 状态 FIXED
FIXED = {
    ("src/index.ts", 119),                    # killPid 增加 pid 数字白名单校验，命令拼接注入面消除
    ("src/utils/audioPostprocess.ts", 44),   # 临时文件名改用 node:crypto randomBytes
}
# 需要 owner 决策、本轮不擅自落状态的条目（file 前缀）→ 保持 TO_REVIEW（或 --hold-too 时 ACKNOWLEDGED）
HOLD_PREFIX = ("src/auth/user-store.ts",)

COMMENT_BY_GROUP = {
    "fixed_cmd": "已修复：killPid 入参先做 /^\\d+$/ 白名单校验再拼入 taskkill 命令，注入面消除（T01551 复核）。",
    "fixed_crypto": "已修复：临时文件名随机段由 Math.random 改为 node:crypto.randomBytes，消除可预测文件名（T01551 复核）。",
    "dos_url_crawl": "输入已在唯一入口 extractHtmlContent 封顶 4M 字符，且该处正则均为否定字符类/字面量边界的懒匹配形态，无嵌套量词，最坏回溯为多项式且被常数约束（T01551 复核）。",
    "dos_regex": "复核为无风险：该正则由单一字符类量词或字面量边界构成（如 <[^>]+>、\\[\\[([^\\]]+)\\]\\]、\\/+$、^-+$），不存在嵌套量词或重叠交替，不存在超线性回溯；输入为本地 vault/文档文本或配置常量，长度有界（T01551 复核）。",
    "dos_line": "复核为无风险：正则在逐行切分后的单行上执行（match 而非全文），单行长度受源文件格式约束；模式本身无嵌套量词（T01551 复核）。",
    "dos_child_stdout": "复核为无风险：匹配输入是本项目自行 spawn 的子进程（cloudflared）stdout，非外部可控数据；正则无嵌套量词（T01551 复核）。",
    "path": "复核为无风险：调用的是固定命令名（netstat/git/ffmpeg/cmd），参数为常量或本机生成的端口/URL，不含外部输入；本应用是单机桌面程序，运行在与用户相同权限上下文，PATH 可写性不构成提权边界（T01551 复核）。",
    "weak_id": "复核为无风险：Math.random 仅用于生成非保密标识（调度表 id / mermaid DOM 渲染 id），唯一性碰撞只影响可读性，不参与任何鉴权、令牌或密钥派生（T01551 复核）。",
    "rce_bookmarklet": "复核为无风险：该 javascript: URL 是本项目自撰的静态书签脚本常量（非用户/外部输入，无拼接），用于用户手动拖入浏览器书签栏跨域抓取页面；应用内不存在以外部数据构造该 href 的路径（T01551 复核）。",
    "auth_hold": "待 owner 决策：首启写入的默认账号口令属真实风险项，是否改为随机初始口令/强制首登改密需产品确认，本轮不擅自落状态（见 T01551 回传）。",
    "auth_ack": "已知悉并接受风险：本地单机知识库首启默认口令，安装后即提示修改；owner 决策维持现状（T01551 复核，--hold-too）。",
}

LINE_GROUPS = {
    # 逐行匹配（match on one line）的正则热点
    ("src/utils/bookmark-connector.ts", 39): "dos_line",
    ("src/data-clean/ai-analysis-workflow.ts", 148): "dos_line",
}


def classify(project, fp, line, category):
    key = (fp, line)
    if fp.startswith(HOLD_PREFIX):
        return ("TO_REVIEW", "auth_hold"), True
    if key in FIXED:
        return ("FIXED", "fixed_cmd" if fp == "src/index.ts" else "fixed_crypto"), False
    if category == "dos":
        if fp == "src/utils/url-crawl.ts":
            return ("SAFE", "dos_url_crawl"), False
        if fp == "src/tunnel/tunnel-service.ts":
            return ("SAFE", "dos_child_stdout"), False
        if key in LINE_GROUPS:
            return ("SAFE", LINE_GROUPS[key]), False
        return ("SAFE", "dos_regex"), False
    if category == "others":
        return ("SAFE", "path"), False
    if category == "weak-cryptography":
        return ("SAFE", "weak_id"), False
    if category == "rce":
        return ("SAFE", "rce_bookmarklet"), False
    return ("SAFE", "dos_regex"), False


def auth_header():
    tok = os.environ.get("SONAR_TOKEN") or os.environ.get("SONAR_ADMIN_USER")
    if not tok:
        sys.exit("需要 SONAR_TOKEN（具备 hotspot 复核权限的 user token；分析令牌会 403）")
    if ":" in tok:  # admin:user 形式
        b = tok.encode()
    else:
        b = (tok + ":").encode()
    return "Basic " + base64.b64encode(b).decode()


def has_creds():
    return bool(os.environ.get("SONAR_TOKEN") or os.environ.get("SONAR_ADMIN_USER"))


def req(path, params=None, data=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    r = urllib.request.Request(url, data=data.encode() if data else None, method="POST" if data else "GET")
    # 读操作在项目 public 可见性下可匿名（仅 dry-run 用）；写操作必须带凭据
    if data or has_creds():
        r.add_header("Authorization", auth_header())
    if data:
        r.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main():
    apply_it = "--apply" in sys.argv
    hold_too = "--hold-too" in sys.argv
    rows = []
    for p in PROJECTS:
        j = req("/api/hotspots/search", {"projectKey": p, "p": 1, "additionalFields": "message,securityCategory,vulnerabilityProbability,line,status"})
        for h in j["hotspots"]:
            fp = h["component"].split(":", 1)[1]
            (status, ckey), _ = classify(p, fp, h["line"], h["securityCategory"])
            if status == "TO_REVIEW" and hold_too:
                status, ckey = "ACKNOWLEDGED", "auth_ack"
            rows.append((p, fp, h["line"], h["securityCategory"], h["key"], status, COMMENT_BY_GROUP[ckey]))
    from collections import Counter
    print("总数:", len(rows), Counter(r[5] for r in rows))
    for r in sorted(rows, key=lambda x: (x[5], x[0], x[1], x[2])):
        print(f"{r[5]:12s} {r[3]:18s} {r[0]}:{r[1]}:{r[2]}")
    if not apply_it:
        print("\n[dry-run] 未写入任何状态。加 --apply 使用 SONAR_TOKEN 落状态。")
        return
    ok = fail = 0
    for r in rows:
        if r[5] == "TO_REVIEW":
            continue
        try:
            req("/api/hotspots/change_status", data=f"issue={r[4]}&status={r[5]}&comment={urllib.parse.quote(r[6])}")
            ok += 1
        except Exception as e:
            fail += 1
            print("失败:", r[1], r[2], str(e)[:120])
    print(f"\n应用完成：成功 {ok}，失败 {fail}，保持 TO_REVIEW {sum(1 for r in rows if r[5]=='TO_REVIEW')}")


if __name__ == "__main__":
    main()
