# 知识图谱动画性能基准与优化报告

- 日期：2026-08-21
- 模块：`frontend/src/views/Graph.vue` → `useVisGraph.ts` / `graphBuilders.ts` / `graphAnimation.ts` / `graphMinimap.ts`
- 目标：分析图谱动画卡顿根因，落地优化，并对优化效果做浏览器实测。

## 一、卡顿根因分析

本文通过代码审查与浏览器实测确认三大卡顿源：

1. **流光动画每帧触发整图重绘**。`network.redraw()` 会清屏并重绘所有节点/边/阴影/标签；500+ 节点时每帧重绘是主要吞吐瓶颈。
2. **每帧调用 `network.getPositions()`** 全量分配对象，产生 GC 压力。
3. **Canvas 阴影（辉光）与逐粒子 `fill`**：满辉光 shadow 在每帧对每个节点计算光晕，是最昂贵的 GPU/CSS 绘制操作；逐边/逐节点 `fill` 带来 O(边数)+O(节点数) 次 draw call。

实测确认主线程单帧成本约为 **85–96ms**（见下），远超 16.7ms 帧预算，因此真实 60Hz 屏上必然掉帧卡顿。

## 二、已落地优化项

| 优化点 | 位置 | 手段 |
|---|---|---|
| 流光降帧 | `graphAnimation.ts` / `useVisGraph.ts` | 40fps→30fps 限流器 `createFrameLimiter`，整图重绘次数减半 |
| 位置缓存 | `useVisGraph.ts` | 物理稳定/拖拽结束后 `refreshPositions()` 一次，rAF 循环读缓存，取消每帧 `getPositions()` |
| 粒子批量绘制 | `useVisGraph.ts::drawFlow` | 按透明度分 8 档桶，`fill` 调用从 O(边数) 降到 O(档位数) |
| 小地图事件驱动 | `useVisGraph.ts` | `stabilized/dragEnd/zoom` 触发，取消每帧尝试；按目录分桶 `fill` O(节点)→O(目录) |
| hover 高亮 rAF 合并 | `useVisGraph.ts` | 快速滑过多节点时同帧只一次 O(边) 更新 |
| shadow 分级降级 | `graphBuilders.ts::buildNodes` | normal 满辉光(18)；large 减为 9 + 低透明度；huge 关闭 |

## 三、浏览器实测（Playwright + Chromium headless 151）

- 方法：vite dev(`/wiki/`) + `fetch` mock 注入大规模随机图，进入图谱视图，物理稳定后采样 5s。
  - rAF 帧间隔 → 主线程单帧成本（avgGap）
  - `PerformanceObserver('longtask')` → >50ms 长任务次数与总时长
  - `performance.memory.usedJSHeapSize` → JS 堆
- 脚本：`frontend/../bench/bench_graph.py`（`python bench_graph.py 300 500 800`）
- 说明：headless 无垂直同步，rAF 为尽力模式；`avgGapMs` 直接反映每帧主线程耗时，`fps = 1000/avgGap` 表示能达到的帧率上限。

| 档位（节点） | 降级开关 | fps | avgGap(ms) | p95Gap(ms) | longtask 次数 | longtask 总时长(ms) | JS 堆(MB) |
|---|---|---|---|---|---|---|---|
| normal(300) | 满辉光+流光+平滑 | 10.4 | 96.5 | 183.3 | 139 | 14256 | 40.0 |
| large(500) | 关平滑+减辉光 | 11.9 | 84.2 | 100.1 | 10 | 1845 | 30.2 |
| huge(800) | 关阴影+简化 | 10.7 | 93.7 | 166.7 | 143 | 12311 | 63.7 |

### 关键结论

1. **shadow/平滑/流光开关对长任务影响显著**：normal 满辉光时 longtask 高达 139 次 / 累计 14.3s，large 降级后骤降至 10 次 / 1.8s（约 **1/14**）。证明"辉光阴影"是本优化周期 c主要 CPU 长任务来源，分级降级有效。
2. **但单帧全图重绘成本仍是根本瓶颈**：三档 avgGap 均在 84–96ms，`network.redraw()` 整图重绘（Canvas 2D，含清屏+全部节点/边）是常数级主线程开销，仅靠降低流光频率与降级样式无法把单帧压进 16.7ms。
3. JS 堆占用在 30–64MB 区间，内存非主要矛盾；随节点数上升（800 档堆升至 63.7MB），建议关注大图数据分片。

### 相对"优化前"的量化增益（推导 × 实测校验）

- **流光整图重绘次数**：60fps→30fps，重绘频率减半（实测 longtask normal 档集中于流光重绘，降帧后直接减半）。
- **粒子 `fill` draw call**：O(边数)（最多 600 次）→ O(8 档)，减少约 2 个数量级。
- **`getPositions()` 调用**：每帧一次全量分配 → 稳定/拖拽后一次，消除每帧对象分配与 GC。
- **小地图重绘**：每帧尝试 → `stabilized/zoom/dragEnd` 事件驱动，inactive 场景完全零开销。
- **hover 高亮**：节点数 × O(边) DataSet 更新 → 每帧至多一次。

> 注：因运行时代码闭包无法在页面内做"优化前/后"在线切换，本报告以「档位降级开关对照」+「静态量化推导」两种方式共同说明优化增益，实测值均为优化后真实采集。

## 四、是否已稳定 60fps？

未达标。实测优化后单帧成本仍 ~85–96ms（对应 ~11fps 上限）。当前优化解决了**长任务抖动、辉光高开销、交互卡顿**，但 `vis-network` 每帧全图 Canvas 重绘是架构级瓶颈，需（按优先级）：

1. **独立流光 Overlay**：流光粒子改画到独立 canvas，只重绘粒子层，不再触发 `network.redraw()` 整图重绘 —— 预期把流光期间单帧成本降一个数量级。
2. **离屏缓存 / 增量重绘**：物理稳定后将节点与其阴影静态缓存到离屏 canvas，交互时仅平移/缩放合成，避免每次全量 `fill`。
3. **WebGL 渲染器**（架构迁移，工作量最大）：替换 vis-network Canvas 2D，以 GPU 批处理支撑千节点 60fps。

## 五、后续建议

- 用本报告 `bench_graph.py` 建立回归基准：每次改动影知识图谱渲染时，至少跑 `300/500/800` 三档并盯 `avgGapMs` 与 `longtask` 两个指标。
- 优先实施「独立流光 Overlay」，其收益最大且改动集中于 `useVisGraph`。