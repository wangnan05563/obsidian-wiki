import sys
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
with open(path, "rb") as f:
    data = f.read()

# Decode with replace for bad chars  
text = data.decode("utf-8", errors="replace")

# Fix: replace ?{ with ${ in contexts where it looks like corruption
# Specifically on line 991 around position 78
lines = text.split("\n")
line = lines[990]

# Find the ?{ pattern and replace
fixed_line = line.replace("?{pagesSkipped", "${pagesSkipped")
lines[990] = fixed_line

result = "\n".join(lines)
with open(path, "w", encoding="utf-8") as f:
    f.write(result)
print("Fixed line 991")
print(f"Before: ...{line[70:95]}...")
print(f"After:  ...{fixed_line[70:95]}...")
