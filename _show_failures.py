# -*- coding: utf-8 -*-
import json
r = json.load(open('.trae/test_result.json', encoding='utf-8'))
print(f"Top-level keys: {list(r.keys()) if isinstance(r, dict) else type(r).__name__}")
print(f"Type: {type(r).__name__}")
if isinstance(r, list):
    print(f"List length: {len(r)}")
    if r:
        print(f"First item keys: {list(r[0].keys()) if isinstance(r[0], dict) else type(r[0]).__name__}")
        for item in r[:3]:
            print(f"  - {item}")
else:
    print(json.dumps(r, ensure_ascii=False, indent=2)[:2000])
