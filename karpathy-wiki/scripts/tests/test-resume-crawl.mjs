// 断点续爬验证脚本：第二次爬取应看到 resume 事件和 page_skipped 事件
// 运行：node scripts/tests/test-resume-crawl.mjs

const ENTRY_URL = 'http://www.shcpe.com.cn/content/shcpe/index.html';
const API_URL = 'http://localhost:3000/api/url-ingest/crawl';

async function main() {
  console.log('='.repeat(70));
  console.log('断点续爬验证（第二次爬取）');
  console.log('='.repeat(70));

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: ENTRY_URL }),
  });

  if (!res.ok || !res.body) {
    console.error(`HTTP ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const eventCounts = {};
  let resumeCount = 0;
  let skippedCount = 0;
  let pagesCrawled = 0;
  let pagesSkipped = 0;
  let elapsedMs = 0;

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

      eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (eventType === 'progress' && parsed.step === 'resume') {
        resumeCount++;
        console.log(`[resume] ${parsed.message}`);
      } else if (eventType === 'page_skipped') {
        skippedCount++;
        console.log(`[page_skipped] step=${parsed.step} ${parsed.message}`);
      } else if (eventType === 'done') {
        pagesCrawled = parsed.data?.pagesCrawled || 0;
        pagesSkipped = parsed.data?.pagesSkipped || 0;
        elapsedMs = parsed.data?.elapsedMs || 0;
        console.log(`[done] ${parsed.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('断点续爬验证结果');
  console.log('='.repeat(70));
  console.log(`事件统计: ${JSON.stringify(eventCounts)}`);
  console.log(`resume 进度事件数: ${resumeCount}`);
  console.log(`page_skipped 事件数: ${skippedCount}`);
  console.log(`实际爬取页面数: ${pagesCrawled}`);
  console.log(`跳过页面数: ${pagesSkipped}`);
  console.log(`耗时: ${elapsedMs}ms`);

  const passed = resumeCount > 0 && skippedCount > 0 && pagesCrawled === 0;
  console.log('\n' + (passed ? '✓ 断点续爬验证通过' : '✗ 断点续爬验证未达预期'));
  console.log('='.repeat(70));
}

main().catch(err => console.error('Exception:', err));
