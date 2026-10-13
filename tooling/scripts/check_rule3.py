import json, urllib.request

import os

# SonarQube 分析令牌一律从环境变量读取，禁止硬编码入库（历史提交中的旧令牌需轮换）。
_SONAR_TOKEN = os.environ.get("SONAR_TOKEN", "")
if not _SONAR_TOKEN:
    raise SystemExit("请先设置环境变量 SONAR_TOKEN（SonarQube 分析令牌）")
AUTH = f"Bearer {_SONAR_TOKEN}"

url = 'http://localhost:9000/api/rules/show?key=typescript:S6544'
req = urllib.request.Request(url)
req.add_header('Authorization', AUTH)
d = json.load(urllib.request.urlopen(req))
rule = d.get('rule', {})
# Try to get the description HTML
desc = rule.get('descriptionSections', [])
for section in desc:
    print(f'Section key: {section.get("key")}')
    content = section.get('content', '')[:1000]
    print(f'Content: {content}')
    print('---')