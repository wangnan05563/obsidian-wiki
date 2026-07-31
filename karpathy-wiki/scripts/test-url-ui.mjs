// URL 爬取 UI 专项测试
// 验证 Ingest.vue URL tab 的两段式工作流（爬取 → 编译）和提示文本展示
// 验证 API 端点、类型同步、路由注册、源码关键标记
// 运行：node scripts/test-url-ui.mjs

import fs from 'node:fs/promises';
import path from 'node:path';

const API_URL = 'http://localhost:3000';
// 5173 被其他项目占用，本项目前端改用 5174 端口（与 config.yaml service.frontend_url 对齐）
const FRONTEND_URL = 'http://localhost:5174';
const PROJECT_ROOT = process.cwd();

// 简易断言
let passCount = 0;
let failCount = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  [OK] ${msg}`);
    passCount++;
  } else {
    console.error(`  [FAIL] ${msg}`);
    failCount++;
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('URL 爬取 UI 专项测试');
  console.log('='.repeat(70));

  // ---------- 1. 后端健康检查 ----------
  console.log('\n[1] 后端健康检查 GET /health');
  try {
    const r = await fetch(`${API_URL}/health`);
    const j = await r.json();
    assert(r.ok && j.ok === true, `GET /health 返回 ok:true (HTTP ${r.status})`);
  } catch (e) {
    console.error(`  [FAIL] 健康检查异常: ${e.message}`);
    process.exit(1);
  }

  // ---------- 2. URL 爬取配置端点 ----------
  console.log('\n[2] URL 爬取配置端点 GET /api/url-ingest/config');
  try {
    const r = await fetch(`${API_URL}/api/url-ingest/config`);
    assert(r.ok, `HTTP ${r.status}`);
    const j = await r.json();
    assert(j.urlCrawl && typeof j.urlCrawl.maxHops === 'number', `urlCrawl.maxHops 存在 (=${j.urlCrawl?.maxHops})`);
    assert(j.urlCrawl.maxHops === 3, `maxHops 默认为 3 (满足"最多三次跳转"要求)`);
    assert(Array.isArray(j.urlCrawl.allowedAttachmentTypes) && j.urlCrawl.allowedAttachmentTypes.length > 0,
      `allowedAttachmentTypes 非空数组 (含 ${j.urlCrawl?.allowedAttachmentTypes?.length} 种类型)`);
    assert(j.urlCrawl.maxPages > 0, `maxPages > 0 (=${j.urlCrawl?.maxPages})`);
    assert(j.urlCrawl.timeoutMs > 0, `timeoutMs > 0 (=${j.urlCrawl?.timeoutMs})`);
    assert(typeof j.urlCrawl.userAgent === 'string' && j.urlCrawl.userAgent.length > 0,
      `userAgent 存在 (="${j.urlCrawl?.userAgent}")`);
  } catch (e) {
    console.error(`  [FAIL] 配置端点异常: ${e.message}`);
    process.exit(1);
  }

  // ---------- 3. 前端可访问性 ----------
  console.log('\n[3] 前端可访问性');
  try {
    const r = await fetch(FRONTEND_URL);
    assert(r.ok, `GET ${FRONTEND_URL} 返回 HTTP ${r.status}`);
    const html = await r.text();
    assert(html.includes('<div id="app">'), '返回的 HTML 含 <div id="app">');
  } catch (e) {
    console.error(`  [FAIL] 前端访问异常: ${e.message}`);
  }

  // ---------- 4. Ingest.vue 源码静态检查 ----------
  console.log('\n[4] Ingest.vue 源码静态检查（提示文本与两段式 UI）');
  const ingestVuePath = path.resolve(PROJECT_ROOT, 'frontend/src/views/Ingest.vue');
  const src = await fs.readFile(ingestVuePath, 'utf-8');

  const REQUIRED_TIP = '系统将从入口网页开始，自动查询同级路径或子路径下、最多三次跳转内的页面内容';
  assert(src.includes(REQUIRED_TIP), `提示文本完整存在（"${REQUIRED_TIP.slice(0, 30)}..."）`);
  assert(src.includes('class="url-tip-banner"'), '存在 url-tip-banner 样式类（显著提示横幅）');
  assert(src.includes('class="url-tip-text"'), '存在 url-tip-text 样式类（提示文字样式）');
  assert(src.includes('class="url-tip-icon"'), '存在 url-tip-icon 样式类（提示图标）');
  assert(src.includes("type UrlStage = 'idle' | 'crawling' | 'crawled' | 'error'"),
    "UrlStage 类型覆盖 4 态（idle/crawling/crawled/error）");
  assert(src.includes('async function startUrlCrawl'), '存在 startUrlCrawl 异步函数（阶段 1）');
  assert(src.includes('function startUrlCompile'), '存在 startUrlCompile 函数（阶段 2）');
  assert(src.includes("urlStage.value = 'crawling'"), "startUrlCrawl 触发 crawling 态");
  assert(src.includes("urlStage.value = 'crawled'"), "爬取完成后切到 crawled 态");
  assert(src.includes('/api/url-ingest/crawl'), '调用 /api/url-ingest/crawl SSE 端点');
  assert(src.includes('urlCombinedMarkdown'), '使用 urlCombinedMarkdown 暂存爬取结果');
  assert(src.includes('el-progress'), '使用 el-progress 展示进度');
  assert(src.includes('urlCrawlResult'), '使用 urlCrawlResult 展示爬取元信息');
  assert(src.includes('AbortController'), '使用 AbortController 支持取消爬取');
  assert(src.includes('handleUrlCrawlEvent'), '存在 SSE 事件分发函数');

  // ---------- 5. 类型同步检查 ----------
  console.log('\n[5] 前后端类型同步检查');
  const beTypes = await fs.readFile(path.resolve(PROJECT_ROOT, 'api/src/types.ts'), 'utf-8');
  const feTypes = await fs.readFile(path.resolve(PROJECT_ROOT, 'frontend/src/types.ts'), 'utf-8');

  const requiredBEInterfaces = ['UrlCrawlConfig', 'UrlCrawlAttachment', 'UrlCrawlPage', 'UrlCrawlEvent', 'UrlCrawlEventData'];
  const requiredFEInterfaces = ['UrlCrawlEventType', 'UrlCrawlEventData', 'UrlCrawlAttachment', 'UrlCrawlEvent', 'UrlCrawlConfigData', 'UrlCrawlConfigResponse', 'UrlCrawlPageSummary'];

  for (const iface of requiredBEInterfaces) {
    assert(beTypes.includes(`export interface ${iface}`) || beTypes.includes(`interface ${iface}`),
      `后端 types.ts 定义 ${iface}`);
  }
  for (const iface of requiredFEInterfaces) {
    const hasInterface = feTypes.includes(`export interface ${iface}`) || feTypes.includes(`export type ${iface}`);
    assert(hasInterface, `前端 types.ts 定义 ${iface}`);
  }

  // ---------- 6. 路由注册检查 ----------
  console.log('\n[6] 路由注册检查');
  const indexTs = await fs.readFile(path.resolve(PROJECT_ROOT, 'api/src/index.ts'), 'utf-8');
  assert(indexTs.includes("import { registerUrlIngestRoute }"), 'index.ts 导入 registerUrlIngestRoute');
  assert(indexTs.includes('registerUrlIngestRoute(app,'), 'index.ts 调用 registerUrlIngestRoute');

  const urlIngestRoute = await fs.readFile(path.resolve(PROJECT_ROOT, 'api/src/routes/url-ingest.ts'), 'utf-8');
  assert(urlIngestRoute.includes('/api/url-ingest/config'), '路由文件注册 GET /api/url-ingest/config');
  assert(urlIngestRoute.includes('/api/url-ingest/crawl'), '路由文件注册 POST /api/url-ingest/crawl');

  // ---------- 7. URL 爬取核心模块检查 ----------
  console.log('\n[7] URL 爬取核心模块检查');
  const urlCrawlPath = path.resolve(PROJECT_ROOT, 'api/src/utils/url-crawl.ts');
  try {
    const urlCrawlSrc = await fs.readFile(urlCrawlPath, 'utf-8');
    assert(urlCrawlSrc.includes('export async function* crawlUrl'), '导出 crawlUrl 异步生成器');
    assert(urlCrawlSrc.includes('depth > config.maxHops'), '严格深度限制：depth > maxHops 跳过');
    assert(urlCrawlSrc.includes('depth < config.maxHops'), '严格深度限制：depth < maxHops 才入队下一跳');
    assert(urlCrawlSrc.includes('getDirectoryPrefix'), '存在 getDirectoryPrefix 计算路径前缀');
    assert(urlCrawlSrc.includes('url.startsWith(prefix)'), '使用路径前缀过滤非同级/子路径');
    assert(urlCrawlSrc.includes('getDedupeKey'), '存在 getDedupeKey URL 去重');
    assert(urlCrawlSrc.includes('extractLinksAndAttachments'), '存在 extractLinksAndAttachments 提取链接与附件');
    assert(urlCrawlSrc.includes('combinePagesToMarkdown'), '存在 combinePagesToMarkdown 合并 Markdown');
    assert(urlCrawlSrc.includes('DEFAULT_CRAWL_CONFIG') || urlCrawlSrc.includes('maxHops: 3'),
      '默认配置 maxHops=3');
  } catch (e) {
    console.error(`  [FAIL] url-crawl.ts 读取失败: ${e.message}`);
  }

  // ---------- 8. config.json 默认配置检查 ----------
  console.log('\n[8] config.json 默认配置检查');
  try {
    const configJson = JSON.parse(await fs.readFile(path.resolve(PROJECT_ROOT, 'api/config.json'), 'utf-8'));
    assert(configJson.urlCrawl?.maxHops === 3, `config.json urlCrawl.maxHops === 3 (实际 ${configJson.urlCrawl?.maxHops})`);
    assert(Array.isArray(configJson.urlCrawl?.allowedAttachmentTypes), 'config.json 含 allowedAttachmentTypes 数组');
  } catch (e) {
    console.error(`  [FAIL] config.json 读取失败: ${e.message}`);
  }

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(70));
  const total = passCount + failCount;
  console.log(`测试结果: ${passCount}/${total} 通过, ${failCount} 失败`);
  if (failCount === 0) {
    console.log('✓ 全部测试通过');
  } else {
    console.log(`✗ 测试失败（退出码 1）`);
  }
  console.log('='.repeat(70));

  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('未捕获异常:', e);
  process.exit(1);
});
