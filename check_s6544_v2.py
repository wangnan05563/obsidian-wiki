import json, urllib.request

url = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&rules=typescript:S6544&ps=100'
req = urllib.request.Request(url)
req.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
d = json.load(urllib.request.urlopen(req))
print(f'Total S6544 issues: {d["total"]}')
for i in d.get('issues', []):
    comp = i['component']
    line = i.get('line', 'N/A')
    text_range = i.get('textRange', {})
    start_line = text_range.get('startLine', '?')
    print(f'  {comp}:{line} (startLine={start_line}) - {i["message"]}')