import sys, re
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
content = open(path, encoding="utf-8").read()
lines = content.split("\n")

# Count total backticks, considering only unescaped ones
total_bt = 0
odd_line_positions = []
for i, line in enumerate(lines):
    bt_count = sum(1 for j, ch in enumerate(line) if ch == chr(96) and (j == 0 or line[j-1] != chr(92)))
    total_bt += bt_count
    if bt_count % 2 != 0:
        odd_line_positions.append((i+1, bt_count, line.strip()[:70]))

print(f"Total backticks: {total_bt}")
print(f"Lines with odd count: {len(odd_line_positions)}")
for pos in odd_line_positions:
    print(f"  Line {pos[0]} ({pos[1]} bt): [{pos[2]}]")

# The issue might be that the template literal counting is fooled by 
# backticks inside strings. Let me check the context around line 335-344 more carefully
print()
print("=== Around first odd line ===")
if odd_line_positions:
    line_num = odd_line_positions[0][0] - 1
    for i in range(max(0, line_num-2), min(len(lines), line_num+5)):
        bt = sum(1 for j, ch in enumerate(lines[i]) if ch == chr(96) and (j == 0 or lines[i][j-1] != chr(92)))
        marker = " <-- ODD" if bt % 2 != 0 else ""
        print(f"{i+1}: [{lines[i][:80]}]{marker}")
