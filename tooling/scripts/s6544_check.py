import json, urllib.request

# Get sample S6544 issues with full context
url = 'http://localhost:9000/api/issues/search?componentKeys=karpathy_wiki_api&rules=typescript:S6544&ps=5&additionalFields=_all'
req = urllib.request.Request(url)
req.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
d = json.load(urllib.request.urlopen(req))
for i in d.get('issues', []):
    print(f'Component: {i.get("component")}')
    print(f'Line: {i.get("line")}')
    print(f'Message: {i.get("message")}')
    print(f'---')
    # Get rule info
    url2 = f'http://localhost:9000/api/rules/show?key={i.get("rule")}'
    req2 = urllib.request.Request(url2)
    req2.add_header('Authorization', 'Bearer ***REDACTED-SECRET***')
    d2 = json.load(urllib.request.urlopen(req2))
    rule = d2.get('rule', {})
    print(f'Rule description: {rule.get("name")}')
    for sec in rule.get('descriptionSections', []):
        if sec.get('key') == 'how_to_fix':
            print(f'How to fix: {sec.get("content")[:500]}')
    print('='*50)