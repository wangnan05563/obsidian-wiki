import sys
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
content = open(path, encoding="utf-8", errors="replace").read()
lines = content.split("\n")

# Strategy: scan for patterns where consecutive lines together form valid TypeScript
# but individually don't. The key indicator is an unmatched quote on one line
# followed by the closing quote on the next.
# 
# Common patterns caused by \\n -> newline conversion:
# 1. split('\\n') became split('\n') -> line ends with ', next starts with ')
# 2. join('\\n') became join('\n') -> same pattern  
# 3. line + '\\n' became line + '\n' -> line ends with ', next starts with ', 
# 4. regex \\n became actual newline
# 5. '\\n\\n' inside strings
# 
# Approach: find all places where a single-quoted string spans two lines
# and merge them back with literal \\n

output_lines = []
i = 0
fix_count = 0
while i < len(lines):
    line = lines[i]
    stripped = line.rstrip()
    
    # Pattern: line ends with ' (but not '', not a string continuation in JSX)
    # and next line starts with additional string content ending in ' or ');
    if i + 1 < len(lines):
        nxt = lines[i + 1]
        nxt_stripped = nxt.lstrip()
        
        # Single-quote pattern: '...\n'...'... -> merge
        if stripped.endswith("'") and not stripped.endswith("''"):
            if nxt_stripped.startswith("'),") or nxt_stripped.startswith("');") or nxt_stripped.startswith("',"):
                # Could be a split \\n in a string like '+ '\n'
                merged = stripped + "\\n" + nxt_stripped
                output_lines.append(merged)
                i += 2
                fix_count += 1
                continue
        
        # Double-quote pattern for regex
        if stripped.endswith('"') and not stripped.endswith('""'):
            if nxt_stripped.startswith('"') or nxt_stripped.startswith('"//') or nxt_stripped.startswith('"(') or nxt_stripped.startswith('",') or nxt_stripped.startswith('");'):
                merged = stripped + "\\n" + nxt_stripped  
                output_lines.append(merged)
                i += 2
                fix_count += 1
                continue

    output_lines.append(line)
    i += 1

print(f"Fixed {fix_count} split strings")
print(f"Lines: {len(lines)} -> {len(output_lines)}")
result = "\n".join(output_lines)
with open(path, "w", encoding="utf-8") as f:
    f.write(result)
print("Saved.")
