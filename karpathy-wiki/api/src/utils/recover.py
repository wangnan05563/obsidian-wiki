import re

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
content = open(path, encoding="utf-8").read()
lines = content.split("\n")

# We need to find patterns where a \n was split across lines that should be one line.
# Common patterns:
# 1. .split('\n') - line ends with single-quote, next starts with ');
# 2. .join('\n') - same pattern
# 3. /\n/g or similar regex - need to check for this
# 4. Template strings with \n

output_lines = []
i = 0
while i < len(lines):
    current = lines[i]
    
    # Pattern: line ends with ' (single quote) and next line continuation
    if i + 1 < len(lines):
        next_line = lines[i + 1]
        
        # Check for string containing \n that got split
        if current.rstrip().endswith("'"):
            stripped_next = next_line.lstrip()
            
            # Case 1: split('\n') -> the newline was between ' and )
            if stripped_next.startswith("');") or stripped_next.startswith("'); "):
                # Merge: replace the break with literal \\n
                merge_target = "\\n"
                merged = current.rstrip() + merge_target + stripped_next
                output_lines.append(merged)
                i += 2
                continue
            
            # Case 2: .join('\n'); 
            if stripped_next.startswith("';"):
                merge_target = "\\n"
                merged = current.rstrip() + merge_target + stripped_next
                output_lines.append(merged)
                i += 2
                continue
        
        # Check for regex patterns split across lines
        # e.g., /pattern\n  followed by ;/g on next line
        if current.rstrip().endswith("/"):
            stripped_next = next_line.lstrip()
            if stripped_next.startswith("g") or stripped_next.startswith(";") or stripped_next.startswith("/") or stripped_next.startswith(")"):
                merged = current.rstrip() + "\\n" + stripped_next
                output_lines.append(merged)
                i += 2
                continue
    
    output_lines.append(current)
    i += 1

print(f"Merged: {len(lines)} -> {len(output_lines)} lines")
result = "\n".join(output_lines)
with open(path, "w", encoding="utf-8") as f:
    f.write(result)
print("Saved.")
