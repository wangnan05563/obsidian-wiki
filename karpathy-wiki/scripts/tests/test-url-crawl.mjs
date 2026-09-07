// URL 爬取功能测试脚本
// 测试入口：http://www.shcpe.com.cn/content/shcpe/index.html
// 期望目标：http://www.shcpe.com.cn/content/shcpe/vip/xyd/xgzdgz.html?articleType=vip-xyd-xgzdgz&articleId=WZ202306161669544876103282688
//
// 运行：node scripts/tests/test-url-crawl.mjs

const ENTRY_URL = 'http://www.shcpe.com.cn/content/shcpe/index.html';
const TARGET_URL_PATTERN = 'xgzdgz.html';
const API_URL = 'http://localhost:3000/api/url-ingest/crawl';

async function testCrawl() {
  console.log('='.repeat(70));
  console.log('URL 爬取功能测试');
  console.log('='.repeat(70));
  console.log(`入口 URL: ${ENTRY_URL}`);
  console.log(`期望目标（含 "${TARGET_URL_PATTERN}"）: http://www.shcpe.com.cn/content/shcpe/vip/xyd/xgzdgz.html?articleType=vip-xyd-xgzdgz&articleId=WZ202306161669544876103282688`);
  console.log('='.repeat(70));

  const startTime = Date.now();
  const events = [];
  let foundTarget = false;
  let combinedMarkdown = '';
  let pagesCrawled = 0;
  let totalAttachmentCount = 0;
  let pagesList = [];
  let attachmentsList = [];
  let errorMessage = '';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 3 分钟超时

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: ENTRY_URL }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      console.error(`[FAIL] HTTP ${res.status}: ${errText}`);
      clearTimeout(timeout);
      return;
    }

    console.log('[OK] SSE 连接已建立，开始接收事件...\n');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const evts = buffer.split('\n\n');
      buffer = evts.pop() || '';

      for (const evt of evts) {
        const lines = evt.split('\n');
        let eventType = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!eventType || !data) continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        events.push({ eventType, ...parsed });

        // 检查是否到达目标 URL
        if (parsed.data?.url && parsed.data.url.includes(TARGET_URL_PATTERN)) {
          foundTarget = true;
        }

        // 按事件类型输出简短信息
        if (eventType === 'progress') {
          console.log(`[progress] ${parsed.message}`);
        } else if (eventType === 'page_start') {
          console.log(`[page_start] depth=${parsed.data?.depth} ${parsed.data?.url}`);
        } else if (eventType === 'page_done') {
          console.log(`[page_done]  depth=${parsed.data?.depth} "${parsed.data?.title}" (${parsed.data?.contentLength} 字符, ${parsed.data?.attachmentCount} 附件)`);
          if (parsed.data?.url?.includes(TARGET_URL_PATTERN)) {
            console.log(`  >>> ✓ 命中目标页面！`);
          }
        } else if (eventType === 'page_error') {
          console.log(`[page_error] depth=${parsed.data?.depth} ${parsed.data?.url} - ${parsed.data?.error}`);
        } else if (eventType === 'attachment') {
          console.log(`[attachment] ${parsed.data?.type}/${parsed.data?.extension} ${parsed.data?.url}`);
        } else if (eventType === 'done') {
          console.log(`\n[done] ${parsed.message}`);
          combinedMarkdown = parsed.data?.combinedMarkdown || '';
          pagesCrawled = parsed.data?.pagesCrawled || 0;
          totalAttachmentCount = parsed.data?.totalAttachmentCount || 0;
          pagesList = parsed.data?.pages || [];
          attachmentsList = parsed.data?.attachments || [];
        } else if (eventType === 'error') {
          console.log(`\n[error] ${parsed.message}`);
          errorMessage = parsed.message || '';
        }
      }
    }
    clearTimeout(timeout);
  } catch (err) {
    console.error(`\n[EXCEPTION] ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n' + '='.repeat(70));
  console.log('测试结果汇总');
  console.log('='.repeat(70));
  console.log(`耗时: ${elapsed}s`);
  console.log(`事件总数: ${events.length}`);
  console.log(`爬取页面数: ${pagesCrawled}`);
  console.log(`附件总数: ${totalAttachmentCount}`);
  console.log(`合并 Markdown 长度: ${combinedMarkdown.length} 字符`);
  console.log(`是否命中目标页面 (${TARGET_URL_PATTERN}): ${foundTarget ? '✓ 是' : '✗ 否'}`);
  if (errorMessage) {
    console.log(`错误信息: ${errorMessage}`);
  }

  console.log('\n--- 已爬取页面列表 ---');
  for (const p of pagesList) {
    const isTarget = p.url.includes(TARGET_URL_PATTERN);
    console.log(`  ${isTarget ? '✓' : ' '} [d=${p.depth}] ${p.title || '(无标题)'} (${p.contentLength} 字符, ${p.attachmentCount} 附件)`);
    console.log(`     URL: ${p.url}`);
  }

  console.log('\n--- 附件列表 ---');
  if (attachmentsList.length === 0) {
    console.log('  (无附件)');
  } else {
    for (const a of attachmentsList) {
      console.log(`  [${a.type}/${a.extension}] ${a.url}`);
    }
  }

  // 检查目标页面内容是否包含期望的正文
  if (foundTarget && combinedMarkdown) {
    console.log('\n--- 目标页面内容检查 ---');
    const targetPageIndex = combinedMarkdown.indexOf(TARGET_URL_PATTERN);
    if (targetPageIndex >= 0) {
      // 截取目标页面附近的内容片段
      const snippetStart = Math.max(0, targetPageIndex - 100);
      const snippetEnd = Math.min(combinedMarkdown.length, targetPageIndex + 500);
      const snippet = combinedMarkdown.slice(snippetStart, snippetEnd);
      console.log(`  目标页面在合并 Markdown 中的位置: ${targetPageIndex}`);
      console.log(`  内容片段（${snippetStart}~${snippetEnd}）:`);
      console.log('  ' + snippet.split('\n').slice(0, 15).join('\n  '));
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(foundTarget ? '✓ 测试通过：成功爬取到目标页面' : '✗ 测试失败：未爬取到目标页面');
  console.log('='.repeat(70));
}

testCrawl().catch(err => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
