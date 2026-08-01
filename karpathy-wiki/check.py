import sys
sys.stdout.reconfigure(encoding='utf-8')
p = r'D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\index.ts'
c = open(p, 'r', encoding='utf-8').read()
idx = c.index("app.get('/wiki/*'")
print(repr(c[idx:idx+600]))
