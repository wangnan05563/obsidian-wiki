// 章节目录扁平化改造验证脚本（临时脚本，验证后即删）
// 用 puppeteer-core + 系统 Chrome 实测：登录 → 打开文档 → 检查章节面板自动展开/定位/高亮
const puppeteer = require('C:/Users/hspcadmin/AppData/Roaming/npm/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:5173/wiki/';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  const result = { steps: [], consoleErrors };

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.type('input[placeholder="请输入用户名"]', 'admin');
    await page.type('input[placeholder="请输入密码"]', 'admin123');
    await Promise.all([
      page.waitForFunction(() => !document.querySelector('.login-page'), { timeout: 15000 }),
      page.click('button.login-btn'),
    ]);
    result.steps.push('登录成功');

    // 登录后默认进入 dashboard，点击侧栏「知识浏览」进入 Browse 页
    await page.waitForSelector('.tab-btn', { timeout: 15000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.tab-btn')).find(
        (b) => b.textContent.includes('知识浏览'),
      );
      if (btn) btn.click();
    });
    await page.waitForSelector('.el-tree-node', { timeout: 20000 });
    result.steps.push('已进入知识浏览');
    await page.waitForFunction(() => document.querySelectorAll('.tree-node.is-file').length > 0, { timeout: 15000 });
    result.steps.push('目录树已加载');

    // 收集可见文件节点
    const visibleFiles = await page.$$eval('.tree-node.is-file', (els) => els.map((el) => el.textContent.trim().slice(0, 30)));
    result.visibleFiles = visibleFiles;

    // 若只有一个可见文件，尝试展开根级目录找更多文件
    if (visibleFiles.length < 2) {
      const expanded = await page.evaluate(() => {
        const dirs = Array.from(document.querySelectorAll('.el-tree-node'));
        for (const d of dirs) {
          const expandIcon = d.querySelector('.el-tree-node__expand-icon');
          const isDir = d.querySelector(':scope > .el-tree-node__content .tree-node:not(.is-file)');
          if (isDir && expandIcon && !expandIcon.classList.contains('expanded')) {
            expandIcon.click();
            return true;
          }
        }
        return false;
      });
      result.expandedDirForMoreFiles = expanded;
      if (expanded) await new Promise((r) => setTimeout(r, 800));
    }

    // 点击第 index 个文件节点 → 打开文档，等待章节面板自动展开
    async function clickFileNode(index) {
      const ok = await page.evaluate((i) => {
        const nodes = Array.from(document.querySelectorAll('.tree-node.is-file'));
        const el = nodes[i];
        if (!el) return false;
        el.click();
        return true;
      }, index);
      if (!ok) return false;
      await page.waitForFunction(() => document.querySelector('.file-toc-panel') !== null, { timeout: 15000 });
      return true;
    }

    async function verifyPanel() {
      // 等平滑滚动完成
      await new Promise((r) => setTimeout(r, 700));
      return page.evaluate(() => {
        const panel = document.querySelector('.file-toc-panel');
        const rows = Array.from(panel ? panel.querySelectorAll('.toc-row') : []);
        const active = panel ? panel.querySelector('.toc-row.active') : null;
        const treePanel = document.querySelector('.tree-panel');
        const inView = panel && treePanel
          ? (() => {
              const pr = panel.getBoundingClientRect();
              const tr = treePanel.getBoundingClientRect();
              return pr.top >= tr.top - 2 && pr.bottom <= tr.bottom + 2;
            })()
          : false;
        return {
          panelExists: !!panel,
          panelPath: panel ? panel.getAttribute('data-toc-path') : null,
          tocRowCount: rows.length,
          firstRowText: rows[0] ? rows[0].textContent.trim() : null,
          firstRowActive: active ? active.textContent.trim() : null,
          activeCount: panel ? panel.querySelectorAll('.toc-row.active').length : 0,
          panelInTreePanelViewport: inView,
          tocCaretCount: panel ? panel.querySelectorAll('.toc-caret-btn, .file-toc-toggle').length : -1,
        };
      });
    }

    const v1 = await clickFileNode(0);
    result.firstOpenClicked = v1;
    if (v1) {
      result.panel1 = await verifyPanel();
      result.steps.push('已打开第一个文档并验证章节面板');
      await page.screenshot({ path: __dirname + '\\wiki-toc-verify-1.png' });
    }

    const v2 = await clickFileNode(1);
    result.secondOpenClicked = v2;
    if (v2) {
      result.panel2 = await verifyPanel();
      result.steps.push('已打开第二个文档并验证面板切换');
      await page.screenshot({ path: __dirname + '\\wiki-toc-verify-2.png' });
    }

    // 第三阶段：展开 concepts 目录，打开深层文件，验证树栏滚动定位
    const dirExpanded = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('.el-tree-node'));
      for (const n of nodes) {
        const text = n.querySelector(':scope > .el-tree-node__content .tree-node')?.textContent || '';
        if (text.trim().startsWith('concepts')) {
          const icon = n.querySelector(':scope > .el-tree-node__content .el-tree-node__expand-icon');
          if (icon && !icon.classList.contains('expanded')) { icon.click(); return true; }
        }
      }
      return false;
    });
    result.dirExpanded = dirExpanded;
    if (dirExpanded) {
      await new Promise((r) => setTimeout(r, 1000));
      const deepFile = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.el-tree-node__content'));
        for (const c of els) {
          if (c.querySelector('.tree-node.is-file') && /concepts/.test(c.textContent || '')) {
            c.querySelector('.tree-node.is-file').click();
            return c.textContent.trim().slice(0, 30);
          }
        }
        return null;
      });
      result.deepFileClicked = deepFile;
      if (deepFile) {
        await page.waitForFunction(() => document.querySelector('.file-toc-panel') !== null, { timeout: 15000 });
        result.panel3 = await verifyPanel();
        // 记录树栏滚动位置变化：滚动定位后 scrollTop 应大于 0（深层文件）
        result.treeScrollTopAfter = await page.$eval('.tree-panel', (el) => el.scrollTop).catch(() => null);
        result.steps.push('已打开深层文档并验证滚动定位');
        await page.screenshot({ path: __dirname + '\\wiki-toc-verify-3.png' });
      }
    }
  } catch (e) {
    result.fatal = String((e && e.stack) || e);
    await page.screenshot({ path: __dirname + '\\wiki-toc-verify-fail.png' }).catch(() => {});
  }

  result.consoleErrors = consoleErrors.filter((t) =>
    !/ERR_CONNECTION_CLOSED|429|Failed to load resource.*favicon/i.test(t),
  );
  console.log('=== VERIFY RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('FATAL OUTER:', e);
  process.exit(1);
});
