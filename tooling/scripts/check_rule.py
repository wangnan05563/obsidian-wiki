import json, urllib.request

import os

# SonarQube 分析令牌一律从环境变量读取，禁止硬编码入库（历史提交中的旧令牌需轮换）。
_SONAR_TOKEN = os.environ.get("SONAR_TOKEN", "")
if not _SONAR_TOKEN:
    raise SystemExit("请先设置环境变量 SONAR_TOKEN（SonarQube 分析令牌）")
AUTH = f"Bearer {_SONAR_TOKEN}"

# Check S6544 rule description
url = 'http://localhost:9000/api/rules/show?key=typescript:S6544'
req = urllib.request.Request(url)
req.add_header('Authorization', AUTH)
d = json.load(urllib.request.urlopen(req))
rule = d.get('rule', {})
print(f'Key: {rule.get("key")}')
print(f'Name: {rule.get("name")}')
print(f'Severity: {rule.get("severity")}')
print(f'Description: {rule.get("description")[:500]}')
print(f'---')

# Also check what the specific issue says
url2 = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&rules=typescript:S6544&ps=3'
req2 = urllib.request.Request(url2)
req2.add_header('Authorization', AUTH)
d2 = json.load(urllib.request.urlopen(req2))
for issue in d2.get('issues', []):
    print(f'File: {issue.get("component")}, Line: {issue.get("line")}')
    print(f'Message: {issue.get("message")}')
    print(f'---')