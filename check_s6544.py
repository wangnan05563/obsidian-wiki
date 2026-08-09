import json, urllib.request

url = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&rules=typescript:S6544&statuses=OPEN,REOPENED,CONFIRMED&ps=200'
req = urllib.request.Request(url)
req.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
d = json.load(urllib.request.urlopen(req))
print(f'Total S6544 issues: {d["total"]}')
for i in d.get('issues', []):
    line = i.get('line', '?')
    print(f'  {i["component"]}:{line} - {i["message"]}')