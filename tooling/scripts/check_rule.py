import json, urllib.request

# Check S6544 rule description
url = 'http://localhost:9000/api/rules/show?key=typescript:S6544'
req = urllib.request.Request(url)
req.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
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
req2.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
d2 = json.load(urllib.request.urlopen(req2))
for issue in d2.get('issues', []):
    print(f'File: {issue.get("component")}, Line: {issue.get("line")}')
    print(f'Message: {issue.get("message")}')
    print(f'---')