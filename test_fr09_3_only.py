#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Run only FR-09-3 podcast tests (static file checks, no browser needed)."""
import os
import sys
import json
import yaml

# Add the templates directory to path
script_dir = os.path.dirname(os.path.abspath(__file__))
templates_dir = os.path.join(script_dir, ".trae", "skills", "wiki-auto-testing", "templates")
sys.path.insert(0, templates_dir)

from test_suite_full import load_config, TestResults, test_fr09_3_podcast

def main():
    cfg = load_config()
    results = TestResults(quiet=False)

    # FR-09-3 tests don't need a browser, pass None for page/ctx
    # The test function only uses cfg and results
    print("=== FR-09-3 Podcast Tests ===")
    test_fr09_3_podcast(None, None, cfg, results)

    print(f"\n{results.summary()}")
    results.save("test_fr09_3_result.json", encoding="utf-8")
    return results.failed == 0

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
