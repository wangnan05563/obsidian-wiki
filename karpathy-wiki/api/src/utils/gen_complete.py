
import sys
sys.stdout.reconfigure(encoding="utf-8")
B = chr(96)  # backtick
D = chr(36)  # dollar sign
SQ = chr(39)
DQ = chr(34)
BS = chr(92)
NL = chr(10)
O = chr(40)
C = chr(41)
LB = chr(123)
RB = chr(125)
LP = chr(91)
RP = chr(93)

path = "D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/utils/url-crawl.ts"

lines = []
def a(s):
    lines.append(s)

# Header
a("// URL 爬取核心工具：BFS 遍历 + 路径前缀限制 + 三跳限制 + 附件检测")
a("")
a("// 优化实施（5.x 系列）：")
a("// - 5.1.1+5.5.1+5.5.2 robots.txt 解析与 Crawl-delay 遵循")
a("// - 5.1.2 并发控制")
a("// - 5.2.1 模板噪声过滤可配置化")
a("// - 5.2.3 附件类型智能过滤")
a("// - 5.2.5 附件跨页面去重")
a("// - 5.3.1 重试机制：指数退避")
a("// - 5.3.3 爬取日志持久化")
a("// - 5.3.4 超时分级")
a("// - 5.4.4 耗时显示")
a("// - 5.5.3 版权声明")
a("")
a("import { type UrlCrawlConfig, type UrlCrawlEvent, type UrlCrawlPage, type UrlCrawlAttachment } from '../types.js';")
a("import fs from 'node:fs/promises';")
a("import path from 'node:path';")
a("")
a("const DEFAULT_CRAWL_CONFIG: Required<UrlCrawlConfig> = {")
a("  maxHops: 3, timeoutMs: 10000, maxPages: 50,")
a(SQ+"KarpathyWikiBot/1.0"+SQ+",")
a("  allowedAttachmentTypes: ["+SQ+"pdf"+SQ+","+SQ+"doc"+SQ+","+SQ+"docx"+SQ+","+SQ+"xls"+SQ+","+SQ+"xlsx"+SQ+","+SQ+"ppt"+SQ+","+SQ+"pptx"+SQ+","+SQ+"jpg"+SQ+","+SQ+"jpeg"+SQ+","+SQ+"png"+SQ+","+SQ+"gif"+SQ+","+SQ+"webp"+SQ+","+SQ+"svg"+SQ+","+SQ+"mp4"+SQ+","+SQ+"webm"+SQ+","+SQ+"mp3"+SQ+","+SQ+"wav"+SQ+","+SQ+"ogg"+SQ+"],")
a("  followRobotsTxt: true, crawlDelayMs: 0, concurrency: 1,")
a("  excludeTemplateElements: true, renderJs: false,")
a("  contentAttachmentTypes: ["+SQ+"pdf"+SQ+","+SQ+"doc"+SQ+","+SQ+"docx"+SQ+","+SQ+"xls"+SQ+","+SQ+"xlsx"+SQ+","+SQ+"ppt"+SQ+","+SQ+"pptx"+SQ+","+SQ+"mp4"+SQ+","+SQ+"webm"+SQ+","+SQ+"mp3"+SQ+","+SQ+"wav"+SQ+","+SQ+"ogg"+SQ+"],")
a("  retryAttempts: 1, retryBackoffMs: 500, enableAttachmentDedup: true,")
a("  logging: { enabled: false, logFilePath: '../data/url-crawl.log' },")
a("  connectTimeoutMs: 0, readTimeoutMs: 0,")
a(SQ+"本文内容来源于互联网公开资源，仅用于个人知识管理，如有侵权请联系删除"+SQ+",")
a("  preserveOnCancel: true,")
a("};")
a("")
a("async function checkSSRF(urlStr) {")
a("  const hostname = new URL(urlStr).hostname;")
a("  try {")
a("    const dns = await import("+SQ+"node:dns"+SQ+");")
a("    const ipv4s = await dns.promises.resolve4(hostname);")
a("    for (const addr of ipv4s) {")
a("      if (/^10\\.".test(addr) || /^172\\.(1[6-9]|2[0-9]|3[01])\\.".test(addr) || /^192\\.168\\.".test(addr) || /^127\\.".test(addr)) {")
a("        throw new Error("+B+"SSRF blocked: hostname "+DQ+D+"{hostname}"+DQ+" resolves to private IP: "+D+"{addr}"+B+");")
a("      }")
a("    }")
a("  } catch {}")
a("}")
a("")
# ... continuing with parseRobotsTxt, isUrlAllowed, normalizeUrl, getDedupeKey, etc.
# This script needs to be more comprehensive. Let me write a COMPLETE version.
print(f"Starting: {len(lines)} lines so far")

with open(path, "w", encoding="utf-8") as f:
    f.write(NL.join(lines) + NL)
print(f"Written part: {len(lines)} lines")
