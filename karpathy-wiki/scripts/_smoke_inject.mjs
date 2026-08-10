// 非运行副本：本文件留在 scripts/ 下会因模块解析链找不到 api/node_modules 中的 fastify 而无法运行。
// 规范可运行版本在 api/_smoke_inject.mjs，从 karpathy-wiki/api 目录执行：
//   node node_modules/tsx/dist/cli.mjs _smoke_inject.mjs
// 该脚本用 app.inject 在进程内验证 SPA 静态服务（绕过沙箱跨进程 localhost TCP 拦截）。
