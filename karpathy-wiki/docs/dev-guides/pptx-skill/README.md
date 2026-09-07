# pptx-skill-for-trae（内置技能资产）

本目录是从 `D:\code\Data_Trae\.trae-cn\skills\pptx-skill-for-trae` **移植**的内置技能参考文档，供 Karpathy-Wiki 问答页 PPT 生成模块的后续维护引用。

## 与本项目代码的关系

- 问答页 `PPT` 模式的**原生 `.pptx` 生成**实现在
  `api/src/workflows/pptx-renderer.ts`：把 LLM 产出的 Marp Markdown 解析为页纲，
  再用 `pptxgenjs` 程序化排版（本技能的核心运行时依赖）渲染出可下载的 .pptx。
- 本目录文档是技能的**设计规范与 API 参考**，`pptx-renderer.ts` 的排版策略
  （主题色、无空页、防溢出、封面/目录/内容/总结/结语五种布局）即从中提炼。
- 浏览器联预览仍由前端 `@marp-team/marpit` 负责（`MultimodalOutputCard.vue`）。

## 未迁移项

- `scripts/*.py`（unpack/pack/fix/validate_layout）未迁移：后端为 Node/TS 栈，
  且本项目是「从零生成 .pptx」而非「离线编辑已有 .pptx」，用不到这些 python 工具。
- 迁移前的 skill 为一份 agent 提示词 + 脚本；本项目将其**落地为可被服务端
  直接调用的后端代码**，不依赖外部路径也能用。

## 参考文档

- `SKILL.md`：从零创建 PPT 的设计规范（配色/版式/无空页/防溢出）
- `pptxgenjs.md`：pptxgenjs 的 Node API 用法与布局安全实践