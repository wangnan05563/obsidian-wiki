import sys
sys.stdout.reconfigure(encoding='utf-8')
p = r'D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\index.ts'
c = open(p, 'r', encoding='utf-8').read()
old_str = "    app.addHook('preParsing', async (request: FastifyRequest, reply: FastifyReply) => {\n      if (request.url.startsWith('/wiki/')) {\n        request.url = request.url.replace(/^\\/wiki/, '');\n        (request.raw as any).url = request.url;\n      }\n    });\n"
new_str = "    // /wiki/* route handler for Tailscale Funnel prefix\n    app.get('/wiki/*', async (request: FastifyRequest, reply: FastifyReply) => {\n      const suffix = request.url.replace(/^\\/wiki/, '');\n      if (suffix.startsWith('/api')) {\n        request.url = suffix;\n        (request.raw as any).url = suffix;\n        return reply.callNotFound();\n      }\n      if (suffix === '' || suffix === '/') {\n        return reply.sendFile('index.html');\n      }\n      try {\n        return reply.sendFile(suffix.slice(1));\n      } catch {\n        return reply.sendFile('index.html');\n      }\n    });\n"
if old_str in c:
    c = c.replace(old_str, new_str)
    open(p, 'w', encoding='utf-8').write(c)
    print('Replaced successfully, length:', len(c))
else:
    print('Old string not found. Checking current content...')
    idx = c.find('preParsing')
    print('preParsing at:', idx)
    print(repr(c[idx:idx+200]))
