import json, urllib.request, base64

import os

# SonarQube 分析令牌一律从环境变量读取，禁止硬编码入库（历史提交中的旧令牌需轮换）。
_SONAR_TOKEN = os.environ.get("SONAR_TOKEN", "")
if not _SONAR_TOKEN:
    raise SystemExit("请先设置环境变量 SONAR_TOKEN（SonarQube 分析令牌）")
AUTH = f"Bearer {_SONAR_TOKEN}"

req = urllib.request.Request(
    'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&statuses=OPEN,REOPENED,CONFIRMED&ps=500'
)
req.add_header('Authorization', AUTH)
d = json.load(urllib.request.urlopen(req))

print(f'Total OPEN issues: {d["total"]}')
print()

# Group by rule
rules = {}
for i in d['issues']:
    rule = i['rule']
    rules.setdefault(rule, []).append(i)

print('By rule:')
print(f'{"Rule":35s} {"Count":5s} {"Severity":10s}')
print('-' * 55)
for k, v in sorted(rules.items(), key=lambda x: -len(x[1])):
    print(f'{k:35s} {len(v):5d} {v[0]["severity"]:10s}')

print()
print('By file:')
files = {}
for i in d['issues']:
    fname = i['component'].split(':')[-1]
    files.setdefault(fname, []).append(i)
for fname, issues in sorted(files.items(), key=lambda x: -len(x[1])):
    print(f'{fname:50s} {len(issues):3d} issues')

print()
print(f'Total issues: {len(d["issues"])}')
print()
print('All issues (file:line:rule):')
for i in d['issues']:
    fname = i['component'].split(':')[-1]
    line = i.get('textRange', {}).get('startLine', '?')
    print(f'  {fname}:{line}:{i["rule"]}:{i["severity"]}')