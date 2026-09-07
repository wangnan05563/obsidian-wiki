# 知识图谱动画实现评估报告

> 评估对象：`karpathy-wiki/frontend/src/views/Graph.vue` 及其后端数据链路（`api/src/routes/graph.ts`、`vault-service.buildLinkGraph`）
> 渲染栈：`vis-network@10.1.0` + `vis-data@8.0.4`（**Canvas 2D 渲染，无 WebGL**）
> 评估日期：2026-08-19

---

## 0. 现状速览（关键事实）

| 维度 | 现状 |
|---|---|
| 渲染技术 | vis-network Canvas 2D 力导向图（barnesHut 物理引擎，主线程运行） |
| 当前数据规模 | **235 个节点**（entities 58 / concepts 138 / comparisons 8 / queries 13 / qa 18 / solutions 0），边 = 解析后的 `[[wikilink]]` |
| 降级阈值 | `LARGE_THRESHOLD=200`、`HUGE_THRESHOLD=500` |
| ⚠️ 关键发现 | 235 ≥ 200 → **当前正处于 "large" 降级模式**：节点发光阴影 + 平滑曲边 **已被关闭**。即项目精心设计的"霓虹辉光"视觉在真实数据量下根本没生效 |
| 代码体量 | `Graph.vue` 单文件约 1200 行（含约 600 行 scoped CSS），所有图谱逻辑内联 |
| 测试覆盖 | **Graph.vue 无任何单元测试**（无 `*.test.ts`） |
| 共享基建 | `data-tip` 全局指令已正确注册（`directives/tip.ts` + `main.ts`），属良好复用 |

---

## 1. 性能表现

### 现状
- **渲染机制**：Canvas 2D 每帧重绘整张画布。这是性能天花板的核心——节点越多，单帧绘制成本线性上升。vis-network 无原生 WebGL 渲染器。
- **物理引擎**：barnesHut 近似 O(n log n)，但**在 JS 主线程运行**。稳定化（stabilization）动画期间会持续占用主线程，节点数上升时易与 UI 交互争抢帧。
- **降级策略**：200/500 两级降级（关阴影、关平滑边、关 hover、降迭代次数）方向合理，但 **200 阈值对实际 235 节点过于激进**，等于默认就关掉了视觉主体。
- **潜在浪费**：
  - `handleResize` 在每次 `resize` 事件直接 `network.redraw()`，**无防抖 / 无 rAF 合并**——拖拽窗口大小时高频重绘。
  - `buildNodes` 中每个节点都调用 `getThemeVar()` 读取 `getComputedStyle`（每次 `loadGraph` 重算一次；非每帧，但主题切换/重渲染时仍冗余）。
  - 每次过滤/刷新都 `network.destroy()` + `new Network(...)` 全量重建，**丢失相机位置、产生闪烁**。

### 扩展性判断
- 实际天花板：Canvas 2D + 主线程物理，流畅 60fps 的实用上限约 **1k–2k 节点**；超过后 fps 明显下滑。
- 结论：对**当前 235 节点**规模绰绰有余；只有当数据量增长一个数量级（导入外部语料、万级节点）时，才真正触及架构瓶颈。

---

## 2. 视觉效果

### 现状
- **布局**：barnesHut 力导向，按目录着色（语义化，合理）。但**无社区发现（community detection）、无边捆绑（edge bundling）**——节点增长后易出现"毛线团"可读性下降。
- **动画**：当前唯一的"动画"是力导向稳定化过程。无**边流光/粒子沿边运动**、无**相机缓动过渡**、无**节点悬停脉冲**。
- **标签**：超大图隐藏标签（防拥挤，合理），但无标签 LOD（按缩放级别渐进显示）。
- **主题**：颜色通过 CSS 变量读取，主题切换友好（优点）。
- **核心缺陷**：如上，`shadow`（霓虹辉光）在 ≥200 节点即关闭——**设计的视觉灵魂在真实场景被自动剥夺**。

### 改进空间
- 让辉光在典型规模可见（用更廉价的辉光手段或提高阈值）。
- 增加有"生命感"的动效（边流光、相机缓动、入场错峰淡入）。

---

## 3. 代码架构

### 现状（主要短板）
- **巨型单文件组件**：`Graph.vue` 把数据获取、过滤（`filterGraphData`）、节点/边构建（`buildNodes/buildEdges`）、布局配置（`buildGraphOptions`）、渲染（`renderGraph`）、交互（右键菜单、推荐侧栏）、列表降级全部内联。无 composable 拆分。
- **与 vis-network 强耦合**：`Network` / `DataSet` 实例直接挂在组件作用域，渲染器几乎不可替换。
- **降级逻辑散落**：`huge` / `large` 布尔参数层层透传到 `buildNodes/buildEdges/buildGraphOptions`，脆弱、难扩展（再加一档要改多处）。
- **状态分散**：十多个 `ref` 平铺，重载即全量重建，无相机状态保留。
- **零测试**：图谱视图无任何单测，回归风险高。

### 改进空间
- 抽出 `useVisGraph` composable（数据、布局、交互、生命周期各司其职）。
- 用配置表 / 策略模式替代布尔透传的降级逻辑。
- 建立 happy-dom + vis-network mock 的单测，覆盖过滤、降级分支、事件回调。

---

## 4. 用户交互

### 现状（优点）
- 缩放 / 拖拽：vis-network 内置，当前规模下**响应顺滑、准确**（力强项）。
- 左键点节点 → 打开推荐侧栏；右键节点 → 上下文菜单（打开笔记 / 查看推荐 / 关闭）；窄屏自动切列表视图——交互设计完整且实用。

### 现状（缺口）
- **无节点搜索 / 跳转定位**。
- **无邻居高亮**（hover/选中时高亮一阶邻居、淡出其余）——图谱探索最关键的能力缺失。
- **无小地图 / 概览导航**（大图画布易迷失）。
- **重载 / 过滤后相机归位**（未 `fit` 到内容，丢失浏览上下文）。
- **点空白处不取消选中 / 不关闭菜单**。
- `resize` 未防抖；`hover` 在超大图被禁用。

---

## 5. 结论：是否值得升级？

**值得做针对性升级，但不值得重写或换库。**

理由：
1. 当前实现**功能可用、对 235 节点规模性能充裕**，没有紧急故障。
2. 最大"性价比漏洞"是**视觉主体在真实规模被自动降级关闭** + **零测试 + 巨型单文件**导致后续迭代风险高。
3. 迁移到 WebGL 渲染器（sigma/cosmograph）属**过早优化**：为不存在的万级节点需求承担一次高风险重写，且会丢失 vis-network 已做好的缩放/拖拽/右键等交互。

一句话：**先修"该亮没亮"与"难维护"，再谈"换引擎"。**

---

## 6. 可行升级方向与方案对比

### 方案 A（推荐，P0/P1）：原地优化 + 视觉/动画回归 —— 保持 vis-network
- **改进点**：
  - 重构：拆分 `useVisGraph` composable；策略化降级配置；建立单测。
  - 视觉：重新校准降级阈值（让霓虹辉光在 ~235 节点生效，或用廉价辉光）、加边流光、相机缓动、节点脉冲、入场错峰淡入。
  - 性能：resize 防抖/rAF、`loadGraph` 时保留相机位置、主题色缓存。
- **预期效果**：恢复设计视觉、交互更"活"、维护性大幅提升、零回归风险。
- **工作量**：中（约 3–5 人日）。
- **风险**：低。同源库、不动数据层。

### 方案 B：切换 WebGL 渲染器（sigma.js + graphology，或 cosmograph）
- **改进点**：GPU 加速，可流畅渲染**数万级节点**；支持 off-main-thread 布局（web worker）。
- **预期效果**： scalability 数量级提升；可实现真正的"大数据图谱"。
- **工作量**：大（约 8–15 人日）。
- **风险**：高。需重写整个图谱视图、重新实现缩放/拖拽/右键/推荐联动；可能引入回归；vis-network 已验证的交互要重做。
- **适用前提**：数据量突破 ~2–3k 节点，或明确需要 3D/超大规模探索。

### 方案 C：混合渲染（小图 vis-network + 大图 WebGL）
- **改进点**：两全其美——常规规模用成熟稳定的 vis-network，超大规模自动切 WebGL。
- **预期效果**：兼顾稳定与扩展。
- **工作量**：超大（约 15+ 人日）。
- **风险**：极高。维护两条渲染链路、状态/相机在切换时对齐复杂，是当前阶段**过度设计**。

### 方案 D（P2，动画专项）：动效增强 + 交互补全
- **改进点**：邻居高亮、搜索/跳转、小地图、空白取消选中、边流光、相机缓动。
- **预期效果**：图谱可探索性质变。
- **工作量**：中（约 3–4 人日）。
- **风险**：中。邻居高亮/边流光在 vis-network 下需手动操作 DOM overlay 或 canvas 层，需注意性能。

---

## 7. 推荐实施顺序

| 优先级 | 方向 | 动作 | 收益 | 工作量 |
|---|---|---|---|---|
| **P0** | 架构 | 拆分 composable + 补单测 + resize 防抖 + 保留相机位置 | 维护性前置，消除回归风险 | 中 |
| **P1** | 视觉/动画 | 校准降级阈值让辉光生效 + 边流光/相机缓动/脉冲 | 恢复设计视觉、更有生命力 | 中 |
| **P2** | 交互 | 邻居高亮 + 搜索跳转 + 小地图 + 空白取消选中 | 图谱可探索性质变 | 中 |
| **P3（未来）** | 渲染 | 仅当数据突破 ~2–3k 节点或需 3D 时，评估方案 B/C | scalability 数量级提升 | 大/极高 |

> 一句话路线：**先让该亮的亮起来、让代码可测可维护（A），再把交互做厚（D）；引擎迁移（B/C）留作规模触顶时的后手，现在不动。**

---

## 8. 执行进度（2026-08-19）

### ✅ P0 架构重构（已完成）
- 新增 `composables/graphTheme.ts`（主题色/目录映射）、`composables/graphBuilders.ts`（纯函数：classifyScale/阈值/filterGraphData/buildNodes/buildEdges/buildGraphOptions，仅 `import type` 引用 vis-network 便于 node 单测）、`composables/useVisGraph.ts`（createGraphController：mount/update/destroy/on/redraw/getNodeAt）。
- `Graph.vue` 移除约 400 行内联逻辑，UI 行为 100% 保持；update 改 `setData` 保留相机位姿 + rAF 防抖 redraw。
- 新增 `test/graphBuilders.test.ts`（15 用例）。

### ✅ P1 视觉/动画回归（已完成）
- **阈值校准**：`LARGE_THRESHOLD` 200→350（当前 ~235 节点恢复 full 渲染，霓虹辉光/平滑曲边/hover 重新生效；350 对当前规模留 ~49% 余量）；降级提示文案改为常量动态渲染。
- **边流光**：新增 `composables/graphAnimation.ts`（shouldEnableFlow / edgeFlowPoint / edgeFlowAlpha 纯函数）；controller 在 `afterDrawing` 钩子画流动粒子（仅 normal 档 + 边数 ≤ 600），rAF 驱动、`stabilized`/`dragEnd` 后启动、页面隐藏暂停。
- **hover 脉冲**：hoverNode/blurNode 缓存 + afterDrawing 画扩张光环。
- **相机缓动**：`focusNode(id)`（vis-network focus + easeInOutQuad 450ms），左键点击节点 = 聚焦 + 打开推荐侧栏。
- 新增 `test/graphAnimation.test.ts`（11 用例）；`vue-tsc --noEmit` 0 新增错误（既有 3 个无关错误不在本报告范围）。

### ✅ P2 交互增强（已完成）
- **邻居高亮**：`graphTheme.ts` 新增 `fadeColor`、`graphBuilders.ts` 新增 `getNeighbors`；controller 新增 `setNodeHighlight(nodeId|null)`，hover/取消选中联动——高亮节点与其一阶邻居，其余节点淡化（fadeColor 0.12 + 关 shadow）、其余边 opacity 0.08。
- **搜索跳转**：图谱视图搜索框（按文件名过滤全量节点，≤20 条下拉），点击项 `focusNode` 相机缓动跳转。
- **空白取消选中**：点击画布空白清除邻居高亮 + 关闭右键菜单。
- **小地图（P2 二期，自绘缩略）**：`graphMinimap.ts` 纯函数（computeMinimapLayout/worldToMinimap/minimapToWorld）；controller 在右下角小 Canvas 上绘制 背景+边+节点色点+主图视口矩形（80ms 节流 + dpr 适配），点击小图缓动跳转、拖拽平移主图；stabilized/zoom/dragEnd/resize/主图重绘时联动刷新。
- 新增单测：getNeighbors 5 + fadeColor 4 + minimap 5；`vue-tsc --noEmit` 0 新增错误；vitest 40/40 passed。

### 🎉 升级路线执行状态
**P0 架构 + P1 视觉/动画 + P2 交互（含小地图）全部完成**。剩：① build/deploy 上线（按项目门禁）；② 既有 3 个类型错误排查（backup.ts/exportConversation.ts/Query.vue，与图谱无关）。


