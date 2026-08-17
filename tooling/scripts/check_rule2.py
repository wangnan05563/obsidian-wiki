import json, urllib.request

url = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&rules=typescript:S6544&ps=5'
req = urllib.request.Request(url)
req.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
d = json.load(urllib.request.urlopen(req))
for issue in d.get('issues', []):
    print(f'File: {issue.get("component")}, Line: {issue.get("line")}')
    print(f'Message: {issue.get("message")}')
    print(f'---')