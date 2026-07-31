import sys
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
with open(path, "rb") as f:
    data = f.read()

text = data.decode("utf-8", errors="replace")
lines = text.split("\n")

# Find lines with ?{ inside template literals or Chinese encoding corruption
found = []
for i, line in enumerate(lines):
    # Pattern: Chinese char followed by ? followed by non-Chinese
    # Or just find all ? in Chinese-heavy lines  
    for j in range(len(line) - 2):
        if line[j] == "?" and j + 1 < len(line) and line[j+1] == "{":
            before = line[:j]
            bt_count = 0
            for k in range(len(before)):
                if before[k] == "`" and (k == 0 or before[k-1] != "\\"):
                    bt_count += 1
            if bt_count % 2 == 1:  # Inside template literal
                found.append((i+1, j, line[max(0,j-15):j+20]))

if not found:
    print("No ?{ patterns found in template literals")
else:
    for ln, pos, ctx in found:
        print(f"Line {ln} pos {pos}: ...{ctx}...")

print(f"\nTotal found: {len(found)}")
