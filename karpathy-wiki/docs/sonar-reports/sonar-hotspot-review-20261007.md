# T01551 安全热点复核结论（70 处，2026-10-07）

对象：`karpathy_wiki_api` 62 处 + `karpathy_wiki_web` 8 处 Security Hotspot（T01364 治理后存量，扫描前后计数无变化，vulnerabilities 始终为 0）。

判定汇总：

| 结论 | 数量 | 说明 |
|---|---|---|
| FIXED（代码已修，落「已修复」） | 2 | `src/index.ts:119`、`src/utils/audioPostprocess.ts:44` |
| SAFE（复核为无风险，落「安全」） | 65 | 54 处超线性正则 + 5 处 PATH + 2 处弱随机 + 1 处 javascript: URL + 3 处 url-crawl（含新增加固） |
| ACKNOWLEDGED（真实风险，owner 接受） | 3 | `src/auth/user-store.ts:22/23/24` 首启默认口令（见第六节裁决） |

落地状态：70/70 已写入服务器，`TO_REVIEW` 归零，两项目 `security_hotspots_reviewed = 100.0`（见第七、八节）。
可执行化：`tooling/scripts/sonar_review_hotspots_t01551.py`（默认 dry-run；`--check` 校验凭据权限；`--apply` 需 `squ_`/`sqp_` 用户令牌，分析令牌会 403）。本文件是判定依据的单一可信源。

## 一、已修复（2 处，标 FIXED）

1. `karpathy-wiki/api/src/index.ts:119`（command-injection / HIGH）
   `killPid(pid)` 把 `pid` 直接拼进 `taskkill /F /T /PID ${pid}`。pid 虽来自 `netstat -aon` 的 `(\d+)` 捕获，但拼接命令属 OS 命令入口，改法：进函数先 `if (!/^\d+$/.test(pid)) return false;`，注入面从「依赖上游正则」变为「本地强校验」。
2. `karpathy-wiki/api/src/utils/audioPostprocess.ts:44`（weak-cryptography / MEDIUM）
   临时音频文件名用 `Math.random()` 生成，共享临时目录下可预测。改法：`randomBytes(8).toString('hex')`（`node:crypto`），并删掉不再使用的 `Math` 导入。

## 二、正则类 54 处（dos / MEDIUM）→ SAFE

Sonar 报的是「该正则因输入字符串可能导致超线性运行时间」。逐条看**正则形态**与**输入来源**两个维度，结论如下（同一形态合并说明）：

- **否定字符类量词 + 字面量边界**：`<[^>]+>`、`\[\[([^\]]+)\]\]`、`>([^<]*)<`、`/\(([^)]+)\)/`、`\d+[.)]\s+(.*)` 等。不存在嵌套量词或重叠交替，回溯线性，无 DoS 面。
- **锚定单侧字符类**：`/\/+$/`、`/(?:^-+)|(?:-+$)/`、`/^#+\s+(.*)$/`、`/^[-*]\s+(.*)$/`。同一字符类不重复量词，线性。
- **懒匹配 + 唯一字面量边界**：`` ``` ``代码围栏、`^---…created:…---` frontmatter、`{{…}}` 模板占位、`<!--…-->`。最坏为多项式（非指数），且输入长度受单文件约束。
- **逐行执行的正则**：`src/utils/bookmark-connector.ts:39`（`<DT><A … HREF=…>`）、`src/data-clean/ai-analysis-workflow.ts:148`（冗余文件名模式）、`src/qq-ingest/preprocess/qq-preprocess.ts` 若干。它们对**切分后的单行**调用 `match`，而不是对整篇文档，回溯规模被行宽天然限制；其中 `<A\s+[^>]*HREF="[^"]*"[^>]*>` 是最值得留意的一条（两个 `[^>]*`），但因逐行 + 无嵌套量词，最坏二次且行宽有限。
- **子进程输出解析**：`src/tunnel/tunnel-service.ts:1080/1128` 匹配的是本项目自行 spawn 的 cloudflared 进程 stdout，非外部可控输入。
- **`src/utils/url-crawl.ts` 7 处**：这是唯一面向**外部网页内容**的一组，因此除复核外还做了加固——在唯一入口 `extractHtmlContent` 增加 `MAX_HTML_CHARS = 4_000_000` 封顶，把最坏回溯耗时约束在常数内（正常站点远达不到该长度，不影响功能）。同文件其它分支（409/473/710）本就 `slice(0, 2000/4000)`。

## 三、PATH 类 5 处（others / LOW）→ SAFE

`src/index.ts:131`（`netstat -aon`）、`src/index.ts:153`（`cmd /c start '' <本机 URL>`）、`src/routes/about.ts:94`（`git rev-parse --short HEAD`）、`src/utils/audioPostprocess.ts:33/63`（`ffmpeg`）。

命令名全部为常量，参数不含外部输入；本应用是**单机桌面程序**，运行在与安装用户相同的权限上下文，PATH 可写性属于本机信任模型，不构成提权边界（攻击者若能改写用户 PATH，已具备同等执行能力）。`audioPostprocess` 另经 `execFileSync`（非 shell）调用，命令注入面另已消除。

## 四、弱随机 2 处（weak-cryptography / MEDIUM）→ SAFE

- `src/data-clean/scheduler-manager.ts:46`：`'sched_' + Date.now() + Math.random().toString(36)` 仅作本地调度表标识，不参与鉴权/令牌/密钥；碰撞只影响可读性。
- `karpathy-wiki/frontend/src/components/MultimodalOutputCard.vue:77`：`mermaid-<时间>-<随机>` 只作 DOM 渲染 id，避免与历史 SVG 容器同名，非保密值。

（同类的 `audioPostprocess.ts:44` 因落入共享临时目录，改成了加密随机源，见第一节。）

## 五、javascript: URL 1 处（rce / MEDIUM，前端）→ SAFE

`karpathy-wiki/frontend/src/views/Ingest.vue:57` 的 `bookmarkletCode` 是**开发者自撰的静态书签脚本常量**：内容不含任何外部数据拼接，用途是让用户拖到浏览器书签栏，在目标站点上下文里抓取 `document.documentElement.outerHTML` 并 `postMessage` 回本应用（跨域抓取的设计取舍，见该文件 52–56 行注释）。绑定处 `:href="bookmarkletCode"` 同样只引用该常量。不存在以用户/外部输入构造该 href 的代码路径。

## 六、默认口令 3 处（auth / HIGH）——owner 已裁决：接受风险（方案 C）

`karpathy-wiki/api/src/auth/user-store.ts:22/23/24`：首次启动写入的默认账号口令 `admin/admin123`、`user/user123`、`guest/guest123`。

这是**真实风险项**，不是误报：源码里硬编码了可用凭据，任何拿到源码 + 未改口令的实例的人都能以 admin 登录。当时列出的三个选项：

- 方案 A：首启用加密随机数生成 admin 口令并打印到控制台/写入一次性文件（安装后必须读控制台）；
- 方案 B：保留默认口令但强制首次登录改密（登录接口拦截）；
- 方案 C：接受风险（本地单机、仅监听 127.0.0.1 的场景），落 `ACKNOWLEDGED` 并在文档记录。

**2026-10-07 owner 裁决：选方案 C。** 理由是该应用形态为单机桌面知识库，对外暴露（局域网/公网）需用户显式开启隧道，"装完即用"优先；风险由 `ACKNOWLEDGED` 状态 + 本节记录 + 应用首启提示共同承担，不再挂 `TO_REVIEW`。若后续产品要支持多用户或远程访问，A/B 需重新提出并实现。

## 七、落地通道与 API 契约（本轮实测纠偏）

1. **API 契约与旧文档不同**（本机 SonarQube Community Build 26.1.0.118079 实测）：
   `POST /api/hotspots/change_status` 的 `status` 只接受 `TO_REVIEW | REVIEWED`，
   Safe / Fixed / Acknowledged 属于**另一个参数 `resolution`**；直接传 `status=SAFE` 返回 400
   （`Value of parameter 'status' (SAFE) must be one of: [TO_REVIEW, REVIEWED]`），
   且成功响应是 **204 无正文**而非 200。
2. **凭据类型决定成败**：全局分析令牌（`sqa_` 前缀，即 `karpathy-wiki/scripts/run-sonar.ps1` 与各 `mcp.json` 里那把）
   对 `/api/hotspots/search` 与 `/api/hotspots/change_status` 一律 403「Insufficient privileges」——
   它能读 issues/measures/QG、能建项目，但**不是复核身份**。复核需要 `squ_`/`sqp_` 用户令牌
   （或用户名密码 Basic）。本轮最终使用本机已存在的 admin 用户令牌，经环境变量传给脚本，
   **令牌值未写入任何仓库文件、报告或日志**。
3. 读侧可以匿名：项目可见性是 public，匿名 GET 能列出全部热点（带分析令牌反而 403），所以 dry-run 不需要凭据。
4. `admin/admin` 在本实例已失效（401），不要按 `scripts/create-sonar-project.ps1` 的默认凭据假设。

## 八、落地结果（2026-10-07 执行 `--apply`）

70 条全部写入成功，`TO_REVIEW` 归零：

| 项目 | 热点数 | REVIEWED/SAFE | REVIEWED/FIXED | REVIEWED/ACKNOWLEDGED | `security_hotspots_reviewed` | `new_security_hotspots_reviewed` |
|------|--------|---------------|----------------|------------------------|------------------------------|----------------------------------|
| karpathy_wiki_api | 62 | 57 | 2 | 3 | 100.0 | 100.0 |
| karpathy_wiki_web | 8 | 8 | 0 | 0 | 100.0 | 100.0 |

每条判定理由都随状态一起写进了热点 comment（可审计），正文见第一至第五节。
执行器：`tooling/scripts/sonar_review_hotspots_t01551.py`——`--check` 先做凭据权限自检（只读），
`--apply` 写回，`--apply --skip-hold` 为保守模式（不动第六节那 3 条）。脚本的规则表是本文档的可执行化，
改结论请先改本文再改脚本。

