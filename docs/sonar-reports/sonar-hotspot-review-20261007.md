# T01551 安全热点复核结论（70 处，2026-10-07）

对象：`karpathy_wiki_api` 62 处 + `karpathy_wiki_web` 8 处 Security Hotspot（T01364 治理后存量，扫描前后计数无变化，vulnerabilities 始终为 0）。

判定汇总：

| 结论 | 数量 | 说明 |
|---|---|---|
| FIXED（代码已修，落「已修复」） | 2 | `src/index.ts:119`、`src/utils/audioPostprocess.ts:44` |
| SAFE（复核为无风险，落「安全」） | 65 | 54 处超线性正则 + 5 处 PATH + 2 处弱随机 + 1 处 javascript: URL + 3 处 url-crawl（含新增加固） |
| TO_REVIEW（保持待审，交 owner 决策） | 3 | `src/auth/user-store.ts:22/23/24` 首启默认口令 |

可执行化：`tooling/scripts/sonar_review_hotspots_t01551.py`（默认 dry-run，`--apply` 需具备复核权限的凭据）。本文件是判定依据的单一可信源。

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

## 六、保持待审 3 处（auth / HIGH）——需 owner 决策

`karpathy-wiki/api/src/auth/user-store.ts:22/23/24`：首次启动写入的默认账号口令 `admin/admin123`、`user/user123`、`guest/guest123`。

这是**真实风险项**，不是误报：源码里硬编码了可用凭据，任何拿到源码 + 未改口令的实例的人都能以 admin 登录。是否落「安全/已修复」取决于产品决策：

- 方案 A：首启用加密随机数生成 admin 口令并打印到控制台/写入一次性文件（安装后必须读控制台）；
- 方案 B：保留默认口令但强制首次登录改密（登录接口拦截）；
- 方案 C：接受风险（本地单机、仅监听 127.0.0.1 的场景），落 `ACKNOWLEDGED` 并在文档记录。

我不替 owner 落这个状态，因此这 3 条保持 `TO_REVIEW`，质量门禁的 `new_security_hotspots_reviewed` 会停在 95%（67/70）。选定方案后我可以继续实现 A/B。

## 七、落地限制

本环境的分析令牌（PROJECT_ANALYSIS）对 `/api/hotspots/search` 返回 403、`change_status` 更不可用；浏览器里 SonarQube 会话未登录（`/api/developers/search_events` 401，页面显示「登录」），且 `admin/admin` 已失效（项目可见性为 public，所以匿名 GET 能读到热点列表——这正是本文档能产出的原因）。因此上面 65+2 条判定已全部备好，只差一个具备复核权限的凭据来执行 `--apply`。
