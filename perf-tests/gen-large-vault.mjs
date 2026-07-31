// 大 vault 测试数据生成脚本
// 为什么需要：验证 P2 缓存机制在 1000+ 页面场景下的效果
// 策略：备份当前 vault → 生成 ~850 个测试页面 → 测试后恢复
// 每个测试页面包含 frontmatter + 正文 + 3-5 个 [[wikilinks]]（模拟真实双链结构）
import fs from 'node:fs';
import path from 'node:path';

const VAULT = process.argv[2] || '../karpathy-wiki/data/vault';
const ROOT = process.argv[3] || process.cwd();

// 测试页面分布：模拟真实知识库的比例
const DISTRIBUTION = [
  { dir: 'entities', count: 400, type: 'entity' },
  { dir: 'concepts', count: 400, type: 'concept' },
  { dir: 'comparisons', count: 50, type: 'comparison' },
  { dir: 'qa', count: 50, type: 'qa' },
];

const TAGS_POOL = ['测试', '性能', '缓存', '架构', '设计', '规范', '工作流', 'LLM', 'RAG', '向量化'];

function randItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randTags() {
  const n = 2 + Math.floor(Math.random() * 3); // 2-4 个
  const tags = new Set();
  while (tags.size < n) tags.add(randItem(TAGS_POOL));
  return Array.from(tags);
}

function randLinks(existingNames, count) {
  const links = new Set();
  while (links.size < count && links.size < existingNames.length) {
    links.add(randItem(existingNames));
  }
  return Array.from(links);
}

// 生成单个页面内容（含 frontmatter + 正文 + 双向链接）
function genPage(name, type, existingNames) {
  const today = new Date().toISOString().slice(0, 10);
  const tags = randTags();
  // 每页 3-5 个双链，模拟真实知识网络密度
  const linkCount = 3 + Math.floor(Math.random() * 3);
  const links = randLinks(existingNames, linkCount);

  const fm = [
    '---',
    `title: ${name}`,
    `type: ${type}`,
    `created: ${today}`,
    `updated: ${today}`,
    'source: synthetic-test-data',
    `tags: [${tags.join(', ')}]`,
  ];
  if (type === 'qa' || type === 'solution') {
    fm.push('status: published');
    fm.push('confidence: medium');
  }
  fm.push('---', '');

  const body = [
    `# ${name}`,
    '',
    `这是性能测试用合成页面（${type} 类型）。用于验证 P2 缓存机制在大 vault 场景下的有效性。`,
    '',
    '## 背景',
    '',
    '本文档由 gen-large-vault.mjs 脚本生成，内容为模板化占位文本，仅用于压力测试。' +
      '通过批量生成 1000+ 页面并测量关键端点响应时间，可验证 stat 缓存、增量图构建、brotli 压缩等改进项在高数据量下的稳定性。',
    '',
    '## 相关链接',
    '',
    ...links.map((l) => `- [[${l}]] 相关参考`),
    '',
    '## 总结',
    '',
    '合成页面，无实际业务含义。测试完成后将通过 restore-vault 恢复原始数据。',
    '',
  ];

  return fm.join('\n') + body.join('\n');
}

function main() {
  const vaultPath = path.resolve(ROOT, VAULT);
  if (!fs.existsSync(vaultPath)) {
    console.error(`[错误] vault 路径不存在: ${vaultPath}`);
    process.exit(1);
  }

  // 先收集已有页面名（用于生成 wikilink）
  const existingNames = [];
  for (const { dir } of DISTRIBUTION) {
    const dirFull = path.join(vaultPath, dir);
    if (fs.existsSync(dirFull)) {
      for (const f of fs.readdirSync(dirFull)) {
        if (f.endsWith('.md')) existingNames.push(f.slice(0, -3));
      }
    }
  }
  console.log(`[信息] 当前已有 ${existingNames.length} 个正式页面`);

  let total = 0;
  for (const { dir, count, type } of DISTRIBUTION) {
    const dirFull = path.join(vaultPath, dir);
    fs.mkdirSync(dirFull, { recursive: true });

    for (let i = 0; i < count; i++) {
      const name = `synthetic-${type}-${String(i).padStart(4, '0')}`;
      const filename = `${name}.md`;
      // 已存在则跳过（保证可重复执行）
      const fullPath = path.join(dirFull, filename);
      if (fs.existsSync(fullPath)) {
        total++;
        continue;
      }
      const content = genPage(name, type, existingNames);
      fs.writeFileSync(fullPath, content, 'utf8');
      existingNames.push(name);
      total++;
    }
  }

  console.log(`[完成] 生成完毕，当前 vault 正式页面总数: ${existingNames.length}`);
}

main();
