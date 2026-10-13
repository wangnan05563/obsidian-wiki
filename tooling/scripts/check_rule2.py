import json, urllib.request

import os

# SonarQube 分析令牌一律从环境变量读取，禁止硬编码入库（历史提交中的旧令牌需轮换）。
_SONAR_TOKEN = os.environ.get("SONAR_TOKEN", "")
if not _SONAR_TOKEN:
    raise SystemExit("请先设置环境变量 SONAR_TOKEN（SonarQube 分析令牌）")
AUTH = f"Bearer {_SONAR_TOKEN}"

url = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&rules=typescript:S6544&ps=5'
req = urllib.request.Request(url)
req.add_header('Authorization', AUTH)
d = json.load(urllib.request.urlopen(req))
for issue in d.get('issues', []):
    print(f'File: {issue.get("component")}, Line: {issue.get("line")}')
    print(f'Message: {issue.get("message")}')
    print(f'---')