import fs from 'fs';
const p = 'D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/index.ts';
let s = fs.readFileSync(p, 'utf8');

// 1) 移除 buildApp 内的 listen try-block（监听交给 main()）
s = s.replace(/  try \{\s*await app\.listen[\s\S]*?process\.exit\(1\);\n  \}\n/, '');

// 2) 移除 buildApp 内的 process.on 信号注册（交给 main()）
s = s.replace(/  process\.on\('SIGINT', \(\) => \{ void shutdown\('SIGINT'\); \}\);\n  process\.on\('SIGTERM', \(\) => \{ void shutdown\('SIGTERM'\); \}\);\n/, '');

// 3) 在 buildApp 收尾 return，并把原 main().catch 自动执行改为带 WIKI_SMOKE 守卫的 main() 包裹
const tail = [
  "  return { app, config, shutdown };",
  "}",
  "",
  "async function main(): Promise<void> {",
  "  const { app, config, shutdown } = await buildApp();",
  "  try {",
  "    await app.listen({ host: config.server.host, port: config.server.port });",
  "    const url = `http://${config.server.host}:${config.server.port}`;",
  "    console.log(`Wiki API running at ${url}`);",
  "    openBrowser(url);",
  "  } catch (err) {",
  "    app.log.error(err);",
  "    process.exit(1);",
  "  }",
  "  process.on('SIGINT', () => { void shutdown('SIGINT'); });",
  "  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });",
  "}",
  "",
  "if (process.env.WIKI_SMOKE !== '1') {",
  "  main().catch((err) => {",
  "    console.error('启动失败:', err);",
  "    process.exit(1);",
  "  });",
  "}",
  "",
].join('\n');

s = s.replace(/\}\n\nmain\(\)\.catch\(\(err\) => \{[\s\S]*?\}\);\n$/, tail);

fs.writeFileSync(p, s, 'utf8');
console.log('REFACTOR_DONE');
