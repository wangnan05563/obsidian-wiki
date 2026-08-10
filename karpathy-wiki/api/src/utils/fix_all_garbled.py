import sys
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
with open(path, "rb") as f:
    data = f.read()

text = data.decode("utf-8", errors="replace")
lines = text.split("\n")

# Find lines with ?{ that should be ${ 
for i, line in enumerate(lines):
    j = 0
    while True:
        pos = line.find("?{", j)
        if pos == -1: break
        
        # Check context
        before = line[:pos]
        bt_count = 0
        for k in range(len(before)):
            if before[k] == "`" and (k == 0 or before[k-1] != "\\"):
                bt_count += 1
        
        # If inside template literal, replace ?{ with ${
        if bt_count % 2 == 1:
            fixed = line.replace("?{", "${", 1)
            lines[i] = fixed
            print(f"Fixed line {i+1}: ...{line[max(0,pos-15):pos+20]}... -> ...{fixed[max(0,pos-15):pos+20]}...")
        
        j = pos + 1

result = "\n".join(lines)
with open(path, "w", encoding="utf-8") as f:
    f.write(result)
print("\nDone. Fixed lines with ?{ pattern.")
