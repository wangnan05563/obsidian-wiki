import json, urllib.request

import os

# SonarQube 分析令牌一律从环境变量读取，禁止硬编码入库（历史提交中的旧令牌需轮换）。
_SONAR_TOKEN = os.environ.get("SONAR_TOKEN", "")
if not _SONAR_TOKEN:
    raise SystemExit("请先设置环境变量 SONAR_TOKEN（SonarQube 分析令牌）")
AUTH = f"Bearer {_SONAR_TOKEN}"

url = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&statuses=OPEN,REOPENED,CONFIRMED&ps=1'
req = urllib.request.Request(url)
req.add_header('Authorization', AUTH)
d = json.load(urllib.request.urlopen(req))
print(f'Total OPEN issues: {d["total"]}')

url2 = 'http://localhost:9000/api/qualitygates/project_status?projectKey=karpathy_wiki_api'
req2 = urllib.request.Request(url2)
req2.add_header('Authorization', AUTH)
d2 = json.load(urllib.request.urlopen(req2))
print(f'Quality Gate: {d2["projectStatus"]["status"]}')