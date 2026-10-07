#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T01364: SonarQube OPEN-issue collector + reporter for the karpathy-wiki project.

Read-only against the local SonarQube API. Token resolution order:
  1. SONAR_TOKEN env var
  2. the project's existing karpathy-wiki/scripts/run-sonar.ps1 (no new secret stored)
"""
import json, os, re, sys, urllib.request, urllib.parse

HOST = os.environ.get("SONARQUBE_URL", "http://localhost:9000")
PORT = os.environ.get("SONARQUBE_PORT", "9000")
BASE = re.match(r"https?://[^/]+", HOST + ":" + PORT) if HOST.startswith("http") else None
BASE = (HOST if HOST.startswith("http") else "http://%s:%s" % (HOST, PORT)).rstrip("/")

PROJECTS = ["karpathy_wiki_api", "karpathy_wiki_web"]


def token():
    t = os.environ.get("SONAR_TOKEN")
    if t:
        return t
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    p = os.path.join(root, "karpathy-wiki", "scripts", "run-sonar.ps1")
    m = re.search(r'SONAR_TOKEN\s*=\s*"([^"]+)"', open(p, encoding="utf-8").read())
    if not m:
        sys.exit("SONAR_TOKEN not available; set env SONAR_TOKEN")
    return m.group(1)


TOK = token()


def api(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + TOK)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.load(r)
    except Exception as e:
        body = ""
        try:
            body = e.read().decode()[:300]
        except Exception:
            pass
        return {"__error__": "%s %s" % (e, body), "__url__": url}


def fetch_issues(project):
    out, page = [], 1
    while True:
        d = api("/api/issues/search", {
            "projects": project,
            "issueStatuses": "OPEN",
            "ps": 500, "p": page,
        })
        if "__error__" in d:
            sys.exit("API error: " + d["__error__"])
        out.extend(d.get("issues", []))
        if len(out) >= d.get("total", 0) or not d.get("issues"):
            return out
        page += 1


def main():
    data = {}
    for p in PROJECTS:
        data[p] = fetch_issues(p)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    print("=== OPEN issue counts ===")
    rules, sevs, files = {}, {}, {}
    for p, iss in data.items():
        print("%-20s %4d" % (p, len(iss)))
        for i in iss:
            rules.setdefault((i["rule"], i["severity"], i["type"]), 0)
            rules[(i["rule"], i["severity"], i["type"])] += 1
            sevs[i["severity"]] = sevs.get(i["severity"], 0) + 1
            files.setdefault((p, i["component"]), 0)
            files[(p, i["component"])] += 1
    total = sum(len(v) for v in data.values())
    print("TOTAL OPEN: %d" % total)
    print("\n=== by severity ===")
    for k in ("BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"):
        if sevs.get(k):
            print("%-9s %4d" % (k, sevs[k]))
    print("\n=== by rule (desc) ===")
    for (r, s, t), n in sorted(rules.items(), key=lambda x: (-x[1], x[0])):
        print("%4d  %-28s %-9s %-20s" % (n, r, s, t))
    print("\n=== top files ===")
    for (p, f), n in sorted(files.items(), key=lambda x: -x[1])[:25]:
        print("%4d  %s  %s" % (n, p, f.replace(p + ":", "")))


OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "sonar-open.json")

if __name__ == "__main__":
    main()
