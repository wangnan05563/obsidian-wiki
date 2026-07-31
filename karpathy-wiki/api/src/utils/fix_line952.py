import sys
sys.stdout.reconfigure(encoding="utf-8")

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"
with open(path, "r", encoding="utf-8") as f:
    lines = f.read().split("\n")

bt = chr(96)  # `
dollar = chr(36)  # $
comma = chr(0xFF0C)  # ，

fixed = "          message: " + bt + "发现附件: " + dollar + "{att.url}" + comma + dollar + "{att.type}/" + dollar + "{att.extension}" + bt + ","
print("FIXED:", repr(fixed))

lines[951] = fixed

result = "\n".join(lines)
with open(path, "w", encoding="utf-8") as f:
    f.write(result)
print("Done.")
