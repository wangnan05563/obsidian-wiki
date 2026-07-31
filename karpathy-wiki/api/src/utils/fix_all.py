import sys
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
with open(path, "rb") as f:
    data = f.read()

# Decode raw bytes - strip double BOM if present
if data.startswith(b"\xef\xbb\xbf\xef\xbb\xbf"):
    data = data[6:]
elif data.startswith(b"\xef\xbb\xbf"):
    data = data[3:]

text = data.decode("utf-8", errors="replace")
lines = text.split("\n")

# Fix line 336: chr(10)*2 -> '\n\n' and fix the \n in regex
lines[335] = lines[335].rstrip("\\r")
fixed_336 = "  return text.replace(/^\\n{3,}/g, chr(10)*2).trim();"
# Replace with correct JS
fixed_336 = "  return text.replace(/^\\n{3,}/g, chr(10) + chr(10)).trim();"
# Actually we need proper string concatenation in JS:
# Use String.fromCharCode(10) or just '\n' 
fixed_336 = "  return text.replace(/^\\n{3,}/g, \"\\n\\n\").trim();"
lines[335] = fixed_336

result = "\n".join(lines)
with open(path, "wb") as f:
    f.write(result.encode("utf-8"))
print("Applied fixes.")
print(f"Line 336: {lines[335]}")
