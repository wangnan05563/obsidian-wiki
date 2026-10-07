#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T01364: run sonar-scanner for one module and poll the CE task until it settles.

Usage: python sonar_scan_t01364.py <api|web>
Token comes from SONAR_TOKEN env or the project's existing scripts/run-sonar.ps1.
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WIKI = os.path.join(ROOT, "karpathy-wiki")
SCANNER = r"D:\code\sonar\sonar-scanner-8.0.1.6346-windows-x64\bin\sonar-scanner.bat"
BASE = os.environ.get("SONAR_HOST", "http://localhost:9000")

MODULES = {
    "api": {"dir": os.path.join(WIKI, "api"), "key": "karpathy_wiki_api"},
    "web": {"dir": os.path.join(WIKI, "frontend"), "key": "karpathy_wiki_web"},
}


def token():
    t = os.environ.get("SONAR_TOKEN")
    if t:
        return t
    p = os.path.join(WIKI, "scripts", "run-sonar.ps1")
    return re.search(r'SONAR_TOKEN\s*=\s*"([^"]+)"', open(p, encoding="utf-8").read()).group(1)


def api(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token())
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.load(r)
    except Exception as e:
        return {"__error__": str(e)}


def node_path():
    for c in (r"D:\code\nodejs24\node.exe", shutil_which("node")):
        if c and os.path.exists(c):
            return c
    return None


def shutil_which(name):
    from shutil import which
    return which(name)


def main():
    mod = sys.argv[1] if len(sys.argv) > 1 else "api"
    m = MODULES[mod]
    log = os.path.join(ROOT, ".qoder-tmp-scan-%s.log" % m["key"])
    cmd = [SCANNER,
           "-Dsonar.projectKey=%s" % m["key"],
           "-Dsonar.host.url=%s" % BASE,
           "-Dsonar.token=%s" % token(),
           "-Dsonar.scm.disabled=true",
           "-Dsonar.qualitygate.wait=true",
           "-Dsonar.qualitygate.timeout=300"]
    np = node_path()
    if np:
        cmd.append("-Dsonar.typescript.node=%s" % np)
    print("scan module=%s dir=%s node=%s" % (mod, m["dir"], np), flush=True)
    t0 = time.time()
    with open(log, "w", encoding="utf-8", errors="replace") as fh:
        p = subprocess.Popen(cmd, cwd=m["dir"], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        for line in p.stdout:
            fh.write(line)
            fh.flush()
        rc = p.wait()
    print("scanner exit=%d elapsed=%.1fs log=%s" % (rc, time.time() - t0, log), flush=True)
    # CE task
    tail = open(log, encoding="utf-8", errors="replace").read()
    tid = re.search(r"Task (?:id|report download url)[^\n]*?id=([0-9a-zA-Z\-]+)", tail)
    if not tid:
        tid = re.search(r"/api/ce/task\?id=([0-9a-zA-Z\-]+)", tail)
    if tid:
        for _ in range(60):
            d = api("/api/ce/task", {"id": tid.group(1)})
            st = d.get("task", {}).get("status")
            print("ce status=%s" % st, flush=True)
            if st in ("SUCCESS", "FAILED", "CANCELED"):
                print(json.dumps(d.get("task", {}), ensure_ascii=False)[:600], flush=True)
                break
            time.sleep(5)
    return rc


if __name__ == "__main__":
    sys.exit(main())
