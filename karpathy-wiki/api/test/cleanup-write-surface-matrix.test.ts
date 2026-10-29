// T02818 删除窗口外的写入入口普查 —— 入口矩阵与它的守护锁。
// ------------------------------------------------------------------
// 卡面要的不是"再补一处 await"，而是**让这张矩阵活下去**：下一个新增写入口必须被强制
// 归类（落在删除面内 → 接线；落在面外 → 写下凭什么），否则这道防线只是文档（卡面验收口径）。
// 所以本文件做三件事，每件都是可失败的断言：
//  1) 完整性：api/src 下任何带写盘调用的文件都必须在 MATRIX 里有一条，漏登记直接变红；
//  2) 分类可复现：判「面外」的条目用 utils/cleanup-surface 的 deletedSurfaceOf 实测（判定
//     来自生产口径，不是注释里的说法），判「面内」的条目必须真能命中那个面；
//  3) 前提锁：判定所依赖的事实（起跑点接线、mtime 窗口、先收集后删除、口径只有一个来源）
//     被改动时变红——尤其是「删掉一处 await」这一条卡面点名的场景。
// 判定逐条写明理由，改判定的人必须先改这里的理由。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_LOG_BASENAME,
  COMPILE_CACHE_BASENAME,
  compileCacheFileIn,
  logsDirIn,
  stateDirIn,
} from '../src/utils/harness-dirs.js';
import {
  getVaultRawDir,
  RAW_ARCHIVE_PATTERN,
  deletedSurfaceOf,
  type CleanupSurface,
} from '../src/utils/cleanup-surface.js';
import {
  ACTIVITY_DIR_BASENAME,
  CLEANUP_MARKER_BASENAME,
} from '../src/cleanup-cross-process.js';
import { evaluateCleanupGuard } from '../src/cleanup-guard.js';
import type { CleanupActiveState } from '../src/types.js';

const srcDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');
/** rel 相对 api 目录（与 cleanup-compile-mutex.test.ts 同一约定） */
function readSrc(rel: string): string {
  return readFileSync(path.join(srcDir, rel), 'utf8');
}

// 判定用的占位根：只关心路径形状（目录名 + 文件名），不碰真实磁盘
const DATA = path.resolve('X:/placeholder/data');
const VAULT = path.join(DATA, 'vault');
const HARNESS = path.join(DATA, '.harness');
const API = path.resolve('X:/placeholder/api');

type Verdict = 'wired' | 'outside' | 'timewindow' | 'none';

interface MatrixEntry {
  /** api/src 下的相对路径 */
  file: string;
  /** 写入点（函数/方法，便于定位） */
  writes: string;
  /**
   * 结论：
   *  - wired      = 落在删除面内，且已由起跑点/拦截规则闭合
   *  - outside    = 结构上就落在删除面外（位置或文件名）
   *  - timewindow = 位置与文件名都在面内，安全性只剩 days 过滤（新写入 mtime 必然新于 cutoff）
   *  - none       = 不构成被删风险（编排层/无写盘）
   */
  verdict: Verdict;
  /** 判定理由（卡面要求「明确判定为不需要也要写下理由」） */
  reason: string;
  /** outside：实测落在面外的样本路径；wired/timewindow：必须命中该面的样本路径 */
  samples?: string[];
  /** wired/timewindow：该样本预期命中的清理目标 */
  surface?: CleanupSurface;
}

const MATRIX: MatrixEntry[] = [
  // ───────────────────────── 落在删除面内：已闭合 ─────────────────────────
  {
    file: 'compile-cache.ts',
    writes: 'CompileCache.persist → fs.writeFile/mkdir',
    verdict: 'wired',
    surface: 'compile_cache',
    samples: [compileCacheFileIn(HARNESS)],
    reason:
      '编译结束时把整份内存映射写回，删除窗口内的缓存清理会被当场盖掉。闭合方式不是加 await'
      + '（写入发生在运行中期，起跑点等待救不到），而是 T02818 把 compile_cache 纳入 BLOCK_RULES'
      + '：有编译在跑就 409。起跑侧仍由 withCompileLock 先等清理（T02774/T02817）。',
  },
  {
    file: 'run-logger.ts',
    writes: 'RunLogger.ensureDir/log → fs.mkdir/appendFile',
    verdict: 'wired',
    surface: 'run_logs',
    samples: [path.join(logsDirIn(HARNESS), 'run-id.log')],
    reason:
      'T02897 起判 wired（原 timewindow）：日志按 runId 分文件、编译全程持续追加，写入发生在运行中期，'
      + '起跑点的等待救不到——唯一能闭合的是拦截规则。run_logs 已纳入 BLOCK_RULES（有编译在跑就 409），'
      + '与 compile_cache 的写回同族。前提锁：见「先收集后删除」与 mtime 两条用例（后者仍是 days 功能语义）。'
      + '真删到被占用的旧日志只会落 errors[]（Windows 上不允许多余打开句柄），不影响任务本身。',
  },
  {
    file: 'vault/vault-service.ts',
    writes: 'VaultService.writeFile/appendLine/appendLines/archiveRaw/mkdir',
    verdict: 'wired',
    surface: 'raw_archive',
    samples: [path.join(getVaultRawDir(VAULT), 'input-1730000000000.md')],
    reason:
      'archiveRaw 是 raw_archive 的正牌写入方（input-<ts>.md 命中前缀）。它的调用点 compileWorkflow'
      + ' 整体在 withCompileLock 内：起跑先等清理，执行期登记 compile 活跃使 raw_archive 被 409 拦。'
      + '其余 writeFile 落 vault 页面（concepts/qa/…），不在任何删除面内。',
  },
  {
    file: 'workflows/compile-workflow.ts',
    writes: 'compileWorkflow → vault.archiveRaw、bridgeHarnessToEvents → CompileCache/RunLogger',
    verdict: 'wired',
    samples: [],
    reason:
      '本身不直接拼删除面对象，但它是上面三者的唯一调用方，且全站经 adapter.compile 收进 withCompileLock'
      + '（routes/compile.ts 的 SSE 消费循环在锁内）。锁：见「编译链收口」用例。',
  },
  {
    file: 'engine/run-state-store.ts',
    writes: 'createRunStateStore → FileStateStore.save（经 harness 注入）',
    verdict: 'wired',
    surface: 'run_state',
    samples: [path.join(stateDirIn(HARNESS), 'run-id.json')],
    reason:
      'run_state 不带 days 过滤，是无差别删除 → 必须靠拦截。编译/问答两条链的 state 写入分别落在'
      + ' withCompileLock 与 StreamRunManager/内联问答的登记期内，二者都在起跑点先等清理（T02774/T02817）。'
      + '未登记流的写入见下面「harness 终端 save」条目。',
  },
  {
    // 卡面点名要查的一条：引擎侧 FileStateStore 的写入时机不看清理状态。
    // 通读 @wiki/harness/src/harness.ts 后判定为不需要接线，理由写在这里（可被反驳的事实依据）。
    file: 'workflows/podcast-workflow.ts',
    writes: 'new Harness(...).run（未注入 stateStore → 默认 FileStateStore 落 .harness/state）',
    verdict: 'none',
    reason:
      'media-generation / multimodal-output / clarify / gaps / health-check-fix 同此条。三点事实：'
      + '① harness 只在**终端态** save（harness.ts:131 run 结束、:221/:233 runStream 的 done/error），'
      + '没有"运行中每步写状态"的形态；② 清理侧先 readdir 收集再逐个 unlink，窗口内新写的文件不在'
      + '收集清单里，不会被删（本文件有源码锁）；③ 这些流没有 resume 入口，state 只作 trace/审计。'
      + '落点目录随进程 CWD 漂移属 T02772 的收敛范围，不在本单。',
  },

  // ───────────────────────── 落在删除面外：凭什么 ─────────────────────────
  {
    file: 'cleanup-cross-process.ts',
    writes: 'claim/releaseCleanupMarker、write/removeActivityRecord',
    verdict: 'outside',
    samples: [
      path.join(HARNESS, CLEANUP_MARKER_BASENAME),
      path.join(HARNESS, ACTIVITY_DIR_BASENAME, '12345.json'),
    ],
    reason:
      '协调文件若被删，守卫当场失明（比删用户文件更糟）。它安全是因为位置：cleanup.lock 是 .harness 直属'
      + '的 .lock 文件，登记记录在 .harness/activity/ 而不是 .harness/state/。两个目录名不同值这一点'
      + '必须由样本断言保住——把 activityDir 改成 state/ 的瞬间，本用例变红。',
  },
  {
    file: 'routes/cleanup.ts',
    writes: 'writeAudit → fs.appendFile(cleanup-audit.log)',
    verdict: 'outside',
    samples: [path.join(HARNESS, AUDIT_LOG_BASENAME)],
    reason:
      '审计是清理自己写的，且写在 finally 之后（不参与本轮判定）。它落在 .harness 根而不是 logs/ 子目录，'
      + '所以 run_logs 的 .log 匹配碰不到它。台账是"这次删除到底删了什么"的唯一凭据，被删就等于假回执。',
  },
  {
    file: 'routes/bookmark-ingest.ts',
    writes: 'POST /api/ingest/bookmarks → fs.mkdir(rawDir)/writeFile(bookmarks-<ts>.md)',
    verdict: 'outside',
    samples: [path.join(getVaultRawDir(VAULT), 'bookmarks-2026-10-22T10-12-33.md')],
    reason:
      '原先它自己拼 `vaultPath.replace(/[\\\\/]vault$/, "/raw")`，展开是 data/raw（vault 的兄弟目录），'
      + '与清理侧的 vault/raw 根本不是同一个目录——本机 data/raw 不存在即证据。T02818 改走 getVaultRawDir'
      + '把落点并回 vault/raw，此后安全性只剩一条：文件名不匹配 RAW_ARCHIVE_PATTERN（内部临时前缀白名单）。'
      + '这条靠样本断言 + 「不得再自拼 raw 目录」源码锁守住。',
  },
  {
    file: 'workflows/batch-fix-job.ts',
    writes: 'persistSnapshot/stats → fs.mkdir/writeFile/rename/rm',
    verdict: 'outside',
    samples: [
      path.join(HARNESS, 'batch-fix', 'job-id.json'),
      path.join(HARNESS, 'batch-fix', 'stats.json'),
    ],
    reason:
      '作业快照在 .harness/batch-fix/（routes/health-check.ts 的 jobsDir），既不是 state/ 也不是 logs/，'
      + '三个目录名不同值这点由样本守住。作业本体执行整批包在 withCompileLock 内（vault 写入纪律不变）。',
  },
  {
    file: 'routes/compile.ts',
    writes: '上传件落临时文件 fs.writeFile(tmp)、结束 fs.unlink(tmp)',
    verdict: 'outside',
    samples: [path.join(os.tmpdir(), 'wiki-compile-1730000000000-42-note.md')],
    reason:
      '文件名命中 RAW_ARCHIVE_PATTERN（wiki-compile- 前缀），但目录是 os.tmpdir() 而不是 vault/raw/，'
      + '清理只扫 vault/raw/。所以「内部前缀」单独不足以判为面内——deletedSurfaceOf 要求父目录为 raw，'
      + '这条正是那个复合条件的反例。',
  },
  {
    file: 'utils/audioPostprocess.ts',
    writes: 'writeTemp → fs.writeFileSync(os.tmpdir)、cleanupTemp → unlinkSync',
    verdict: 'outside',
    samples: [path.join(os.tmpdir(), 'tts_42_1730000000000_deadbeef.wav')],
    reason: '同上：临时目录，不在 vault/raw 也不在 .harness。',
  },
  {
    file: 'config.ts',
    writes: 'saveConfig 等 → fs.writeFile(configPath)、.bak',
    verdict: 'outside',
    samples: [path.join(API, 'config.json'), path.join(API, 'config.json.bak')],
    reason: '配置不在清理目标里；写它也不需要等清理。',
  },
  {
    file: 'index.ts',
    writes: 'setupLoggerStream → fs.createWriteStream(logFilePath, flags:a)',
    verdict: 'outside',
    samples: [path.resolve(API, '..', 'logs', 'server.log')],
    reason:
      '日志目录是仓库根的 logs/（由 logging.logFilePath 相对 apiDir 上一级展开），与 .harness/logs 不同值。'
      + '若有人把 logFilePath 配成 .harness/logs/server.log，它就被写进 run_logs 面内——样本断言的父目录'
      + '条件（grand 必须是 .harness）因此是这条判定的实质。',
  },
  {
    file: 'auth/audit-log.ts',
    writes: 'appendAudit → fs.appendFile、initAuditLog → mkdir/writeFile',
    verdict: 'outside',
    samples: [path.join(DATA, 'audit.log')],
    reason: '权限审计落 data/audit.log，不在 .harness/logs/。它是安全台账，被清掉等于抹掉越权记录。',
  },
  {
    file: 'auth/user-store.ts',
    writes: 'saveUsers → fs.writeFile(users.json)、mkdir',
    verdict: 'outside',
    samples: [path.join(DATA, 'users.json')],
    reason: '用户表不在删除面内。',
  },
  {
    file: 'data-clean/scheduler-manager.ts',
    writes: 'save → fs.writeFile(data-clean-schedules.json)',
    verdict: 'outside',
    samples: [path.join(DATA, 'data-clean-schedules.json')],
    reason: '计划表在数据目录根，不在 .harness 的任何子目录。',
  },
  {
    file: 'data-clean/quality-scanner.ts',
    writes: 'archiveBadPages → fs.mkdir/rename/unlink、vault.writeFile',
    verdict: 'outside',
    samples: [
      path.resolve(VAULT, '..', 'archive', '2026-10-22', 'wiki-batch-old.md'),
      path.join(VAULT, 'concepts', 'note.md'),
    ],
    reason:
      '数据清洗的归档目录是 vault 的兄弟 archive/<date>/：文件名可以命中内部前缀（样本即如此），'
      + '但父目录不是 raw → 不会被 raw_archive 删。注意 fs.rename 保留原 mtime，所以"靠 days 过滤保护新鲜写入"'
      + '对 rename 不成立，安全性完全来自目录不同值——这一点由样本断言守住，别把归档目标改成 raw/。',
  },
  {
    file: 'data-clean/misplaced-pages.ts',
    writes: 'movePage → vault.writeFile + fs.unlink',
    verdict: 'outside',
    samples: [path.join(VAULT, 'entities', 'misplaced.md')],
    reason: '页面搬家只在 vault 内部移动，目标不是 raw/。',
  },
  {
    file: 'engine/harness-adapter.ts',
    writes: 'markKnowledgeReviewed → vault.writeFile',
    verdict: 'outside',
    samples: [path.join(VAULT, 'concepts', 'dated-note.md')],
    reason: '只改 frontmatter 的页面写回；调用点（routes/health-check.ts）在 withCompileLock 内。',
  },
  {
    file: 'engine/thread-memory-store.ts',
    writes: 'safeWriteJSON → fs.writeFile、rm threads 目录',
    verdict: 'outside',
    samples: [path.join(DATA, 'threads', 'thread-id', 'memory.json')],
    reason: '会话记忆在 data/threads/，不在 .harness。',
  },
  {
    file: 'mcp/tools.ts',
    writes: 'write_page/edit_page/create_page → vault.writeFile、ingest_raw → vault.archiveRaw',
    verdict: 'wired',
    surface: 'raw_archive',
    samples: [path.join(VAULT, 'raw', 'input-by-mcp.md')],
    reason:
      'MCP 写页工具能用任意相对路径落盘，包括 vault/raw/input-*.md（样本就是这种最坏形状：目录与文件名'
      + '两条条件全命中）。T02897 起判 wired（原 timewindow）：接线在 routes/mcp-route.ts 的 tools/call '
      + '分发处——所有 write:true 工具在执行前 await awaitCleanupIdle()（T02774 同款起跑点等待），'
      + '删除窗口内的写入不再依赖 days 过滤。样本覆盖 ingest_raw（archiveRaw → raw/ 正牌写入方）。',
  },
  {
    file: 'qq-ingest/qq-extract-workflow.ts',
    writes: 'writeDraft → vault.writeFile(drafts/…)',
    verdict: 'outside',
    samples: [path.join(VAULT, 'drafts', 'qa-12345678.md')],
    reason: '草稿在 vault/drafts/；调用方 routes/qq-ingest.ts 的抽取与批量编译都在 withCompileLock 内。',
  },
  {
    file: 'routes/conversations.ts',
    writes: 'saveRecord → fs.writeFile、unlink',
    verdict: 'outside',
    samples: [path.join(DATA, 'conversations', 'conv-id.json')],
    reason: '会话记录在 data/conversations/，与 .harness/state 不同目录（同为 *.json，靠目录名区分）。',
  },
  {
    file: 'uploads/upload-store.ts',
    writes: 'save → fs.mkdir + fs.writeFile(blob)、fs.writeFile(meta.json)、失败回滚 fs.rm',
    verdict: 'outside',
    samples: [
      path.join(DATA, 'uploads', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'blob'),
      path.join(DATA, 'uploads', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'meta.json'),
    ],
    // T03611 投递原件留存。判 outside 的实测依据：deletedSurfaceOf 对 data/uploads/ 下的
    // blob 与 meta.json 都返回 null（既不匹配 raw_archive 的目录/文件名口径，也不在
    // .harness 的 state/logs/compile_cache 面内），所以任何清理目标都不会碰到它。
    // 语义上它也不该被清理：原件是用户自己投递的数据，删除只能由用户侧显式发起。
    reason: '原件在 data/uploads/<uuid>/{blob,meta.json}，位置与文件名都不在任何删除面内；用户数据不参与清理。',
  },
  {
    file: 'routes/files.ts',
    writes: 'PUT 页面保存 → awaitCleanupIdle 后 vault.writeFile(query.path)',
    verdict: 'wired',
    surface: 'raw_archive',
    samples: [path.join(VAULT, 'raw', 'input-9999999999999.md')],
    reason:
      'Browse/编辑器能往任意 vault 路径写，含 raw/input-*.md。T02897 起判 wired（原 timewindow）：'
      + 'PUT handler 在写盘前 await awaitCleanupIdle()（T02774 同款起跑点等待），保存与清理互斥，'
      + '不再依赖「刚保存的文件 mtime 必然新于 cutoff」这条时间边界。'
      + '卡面问的「保存时顺手往 raw/ 落临时件」的答案就在这里——**存在**这样的路径（任意路径 + 内部前缀名），'
      + '但保存会先等清理做完，不会落在删除窗口内。',
  },
  {
    file: 'routes/prompts.ts',
    writes: 'save/rollback → fs.writeFile(PROMPTS_DIR/<name>)',
    verdict: 'outside',
    samples: [path.join(API, 'src', 'prompts', 'compile.md')],
    reason: '提示词在源码树 api/src/prompts/（SEA 下是 exe 同级 prompts/），试运行本身在 withCompileLock 内。',
  },
  {
    file: 'routes/query.ts',
    writes: 'saveAnswerPage → vault.writeFile',
    verdict: 'outside',
    samples: [path.join(VAULT, 'queries', 'answer.md')],
    reason: '问答归档页不在删除面内；该路由本身是三个起跑点之二（内联登记 query、可恢复路径交 StreamRunManager）。',
  },
  {
    file: 'routes/schema.ts',
    writes: 'PUT SCHEMA → fs.writeFile(full)',
    verdict: 'outside',
    samples: [path.join(VAULT, 'SCHEMA.md')],
    reason: 'SCHEMA.md 是编译必读输入，从不清理。',
  },
  {
    file: 'routes/tunnel.ts',
    writes: 'saveTunnelConfig → fsp.writeFile(configPath)',
    verdict: 'outside',
    samples: [path.join(DATA, 'tunnel-config.json')],
    reason: '内网穿透配置不在删除面内。',
  },
  {
    file: 'search/sqlite-index.ts',
    writes: 'ensureDbDir → fs.mkdirSync(dataDir)、prepare 语句',
    verdict: 'outside',
    samples: [path.join(DATA, 'wiki-index.db')],
    reason: '索引库是 data/wiki-index.db；清理不碰它（`.db` 也不匹配任何 pattern）。',
  },
  {
    file: 'skill/skill-service.ts',
    writes: 'install/import → fs.mkdir/writeFile/rm',
    verdict: 'outside',
    samples: [path.join(DATA, 'skills', 'a-skill', 'SKILL.md')],
    reason: '技能包在 data/skills/。它自己会 rm -rf 目录，但那是显式卸载动作，不参与清理互斥。',
  },
  {
    file: 'tunnel/tunnel-service.ts',
    writes: 'download/extract → mkdir/rename/unlink/createWriteStream',
    verdict: 'outside',
    samples: [path.join(DATA, 'cloudflared.exe')],
    reason: '二进制落数据目录根，不在删除面内。',
  },
  {
    file: 'utils/runtime.ts',
    writes: 'getUserDataDir → fs.mkdirSync',
    verdict: 'outside',
    samples: [path.join(DATA, 'vault')],
    reason: '只是建目录，且建的是数据目录本身（.harness 的父目录不在删除面内——删除只针对 .harness 里的具体产物）。',
  },
  {
    file: 'data-clean/diff-engine.ts',
    writes: '（注释提及 vault.writeFile，无写调用）',
    verdict: 'none',
    reason: '纯比较逻辑；扫描器剥注释后不再命中，保留此条为回归哨兵。',
  },
  {
    file: 'workflows/discover-workflow.ts',
    writes: 'mergeSource/Target → vault.writeFile',
    verdict: 'outside',
    samples: [path.join(VAULT, 'concepts', 'merged.md')],
    reason: '页面合并写回 vault 页面，不在删除面内。',
  },
  {
    file: 'workflows/health-check-fix-workflow.ts',
    writes: 'fixPage → writePageSafely（vault/page-write-guard）、new Harness().run',
    verdict: 'outside',
    samples: [path.join(VAULT, 'concepts', 'fixed.md')],
    reason:
      '修复写页在 withCompileLock 内（routes/health-check.ts 与 batch-fix-job 都把整批包进锁）；'
      + '其 harness 终端 state 写入按「podcast-workflow」同条判定。',
  },
  {
    file: 'vault/page-write-guard.ts',
    writes: 'writePageSafely → vault.writeFile、vault.appendLog',
    verdict: 'outside',
    samples: [path.join(VAULT, 'concepts', 'fixed.md'), path.join(VAULT, 'log.md')],
    reason:
      'T02923 新增：修复工具的唯一落盘入口，只写 vault 页面（概念/实体等目录）与 log.md 审计行，'
      + '两者都不在任何删除面内；调用链仍在 withCompileLock 内（同 health-check-fix-workflow 条）。',
  },
  {
    file: 'workflows/media-generation-workflow.ts',
    writes: '下载图片/视频 → vault.writeFile、归档 md',
    verdict: 'outside',
    samples: [
      path.join(VAULT, 'queries', 'media-1.png'),
      path.join(VAULT, 'queries', 'media-1.md'),
    ],
    reason: '媒体归档写 vault/queries/，不在删除面内；终端 state 见「podcast-workflow」条。',
  },
  {
    file: 'workflows/podcast-workflow.ts 之外的同族流',
    writes: 'multimodal-output-workflow、clarify/ambiguity-detector、gaps-workflow',
    verdict: 'none',
    reason: '与 podcast-workflow 同判（终端 save + 先收集后删除 + 无 resume 入口）。',
  },
  {
    file: 'workflows/pptx-renderer.ts',
    writes: 'render → vault.writeFile(archivePath)',
    verdict: 'outside',
    samples: [path.join(VAULT, 'queries', 'deck.pptx')],
    reason: '渲染产物在 vault 页面目录。',
  },
  {
    file: 'workflows/tag-suggest-workflow.ts',
    writes: 'suggest/confirmTag → vault.writeFile(pagePath)',
    verdict: 'outside',
    samples: [path.join(VAULT, 'concepts', 'tagged.md')],
    reason: '标签建议改页面 frontmatter，不在删除面内。',
  },
  {
    file: 'cleanup-mutex.ts / activity.ts / compile-queue.ts / cleanup-guard.ts',
    writes: '（无直接写盘，经 cleanup-cross-process 落协调文件）',
    verdict: 'none',
    reason: '互斥与登记的编排层；协调文件本身见 cleanup-cross-process 条目。',
  },
];

// ───────────────────────── 扫描器：矩阵必须覆盖所有写盘文件 ─────────────────────────

const WRITE_CALL =
  /\b(?:fs|fsp|fsSync|fsPromises|this\.vault|vault)\s*\.\s*(?:writeFile|appendFile|createWriteStream|mkdir|mkdirSync|writeFileSync|appendFileSync|rm|rmSync|unlink|unlinkSync|rename|copyFile|cp)\s*\(/g;

/** 去掉行注释与块注释后的源码（注释里的 `vault.writeFile` 不算写入口）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function listTsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listTsFiles(abs, rel));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

function matrixFiles(): Set<string> {
  const set = new Set<string>();
  // 一条目可以并写同族多文件（见「同族流」），按空白/顿号切词，但**不能**切路径里的斜杠
  for (const entry of MATRIX) {
    for (const token of entry.file.split(/[\s,、]+/)) {
      if (token.endsWith('.ts')) set.add(token);
    }
  }
  return set;
}

describe('T02818 入口矩阵完整性（新增写入口不得无声绕过）', () => {
  it('api/src 下每个写盘调用点都在矩阵里登记', () => {
    const registered = matrixFiles();
    const offenders: string[] = [];
    for (const rel of listTsFiles(path.join(srcDir, 'src'))) {
      if (rel.endsWith('.test.ts')) continue;
      const code = stripComments(readSrc(`src/${rel}`));
      WRITE_CALL.lastIndex = 0;
      if (WRITE_CALL.test(code) && !registered.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      `以下文件有写盘调用但不在矩阵里：${offenders.join(', ')}。`
        + '请判它落在哪个删除面（用 utils/cleanup-surface.ts 的 deletedSurfaceOf 实测），'
        + '面内就接线、面外就写下凭什么。',
    ).toEqual([]);
  });

  it('矩阵引用的源码文件都存在（防止条目随重构烂掉）', () => {
    const missing = [...matrixFiles()].filter((rel) => !existsSync(path.join(srcDir, 'src', rel)));
    expect(missing).toEqual([]);
  });
});

describe('T02818 分类可复现：判定为「面外」的写入必须实测落在删除面外', () => {
  const outside = MATRIX.filter((e) => e.verdict === 'outside');
  for (const entry of outside) {
    it(`${entry.file} 的落点不被任何清理目标命中`, () => {
      expect(entry.samples?.length, `${entry.file} 判 outside 却没给样本路径`).toBeGreaterThan(0);
      for (const sample of entry.samples ?? []) {
        expect(deletedSurfaceOf(sample), `${sample} 实际落在 ${deletedSurfaceOf(sample)} 面内，判定失效`).toBeNull();
      }
    });
  }
});

describe('T02818 分类可复现：判定为「面内但靠 days 过滤」的写入必须真能命中那个面', () => {
  const timed = MATRIX.filter((e) => e.verdict === 'timewindow');
  // T02897：timewindow 类清零——「安全只剩时间」不是机制，是押注删除条件永远看 mtime。
  // 三个原 timewindow 条目全部升级为 wired（拦截规则 / 起跑点等待），再有新增写入口
  // 不许判回 timewindow，必须接线或落到面外。
  it('timewindow 类已清零：出现新条目即红', () => {
    expect(timed.map((e) => e.file)).toEqual([]);
  });
  for (const entry of timed) {
    it(`${entry.file} 的落点命中 ${entry.surface}（保护只剩时间，见 mtime 锁）`, () => {
      expect(entry.surface, `${entry.file} 判 timewindow 却没写命中的面`).toBeTruthy();
      for (const sample of entry.samples ?? []) {
        expect(deletedSurfaceOf(sample)).toBe(entry.surface);
      }
    });
  }
});

describe('T02818 分类可复现：判定为「面内」的写入必须真能命中那个面', () => {
  const wired = MATRIX.filter((e) => e.verdict === 'wired');
  for (const entry of wired) {
    it(`${entry.file} 的落点命中 ${entry.surface}`, () => {
      if (!entry.surface) return; // 经别人写入的编排方（compile-workflow）不给独立样本
      for (const sample of entry.samples ?? []) {
        expect(deletedSurfaceOf(sample)).toBe(entry.surface);
      }
    });
  }
});

describe('T02818 互斥接线锁（删掉一处 await / 拆掉一条规则就变红）', () => {
  it('compile_cache 已纳入拦截：有编译在跑就不许删缓存', () => {
    const snapshot = (compile: number): CleanupActiveState => ({
      compile,
      query: 0,
      blockedTargets: [],
      blockedReasons: [],
    });
    const verdict = evaluateCleanupGuard('compile_cache', snapshot(1));
    expect(verdict.blocked).toEqual(['compile_cache']);
    expect(verdict.reasons[0]).toContain('写回');
    expect(evaluateCleanupGuard('compile_cache', snapshot(0)).blocked).toEqual([]);
    // 源码里也必须真有这条规则，否则上面的纯函数用例只是测了个孤立快照
    expect(readSrc('src/cleanup-guard.ts')).toContain("target: 'compile_cache'");
  });

  it('编译链收口：消费 adapter.compile 发生在 withCompileLock 内', () => {
    const src = readSrc('src/routes/compile.ts');
    expect(src).toContain('await withCompileLock(async () => {');
    expect(src.indexOf('await withCompileLock(')).toBeLessThan(src.indexOf('adapter.compile('));
    // 单文件与批量两条链都要有锁（批量原先最容易漏：它在锁内自己再循环）
    expect((src.match(/withCompileLock\(async \(\) => \{/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('三个起跑点各自先等清理再登记活跃（T02774 口径，漏一处整套互斥失效）', () => {
    for (const rel of ['src/compile-queue.ts', 'src/routes/query.ts', 'src/workflows/stream-run-manager.ts']) {
      const src = readSrc(rel);
      const wait = src.indexOf('await awaitCleanupIdle()');
      const begin = src.indexOf('beginActivity(');
      expect(wait, `${rel} 丢了 await awaitCleanupIdle()`).toBeGreaterThan(-1);
      expect(begin, `${rel} 丢了活跃登记`).toBeGreaterThan(-1);
      expect(wait).toBeLessThan(begin);
    }
  });

  it('run_logs 与 raw_archive 的删除必须先判 mtime（新鲜写入靠它保护）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    // mcp/tools.ts 与 routes/files.ts 两条 outside 判定的全部依据就是这条过滤；去掉它判定即失效
    expect((src.match(/stat\.mtimeMs < cutoffMs/g) ?? []).length).toBe(2);
    // days 有下限，cutoff 不可能等于 now（否则"新文件删不到"变成"新文件全删"）
    expect(src).toContain('Math.max(1');
  });

  it('删除必须先收集后执行（窗口内新写的文件不能被本轮抓走）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    for (const fn of ['cleanupRunState', 'cleanupRunLogs', 'cleanupRawArchive']) {
      const start = src.indexOf(`async function ${fn}(`);
      expect(start, `找不到 ${fn}`).toBeGreaterThan(-1);
      const end = src.indexOf('async function ', start + 10);
      const body = src.slice(start, end === -1 ? src.length : end);
      const collect = body.indexOf('listFiles(');
      // run_state 走 cleanupFile 助手（内含 fs.unlink）；run_logs 走 cleanupOldLog 助手（同一删除口径）；
      // raw_archive 直接 unlink：三种写法都算"执行删除"
      const del = [body.indexOf('fs.unlink'), body.indexOf('await cleanupFile('), body.indexOf('await cleanupOldLog(')]
        .filter((i) => i >= 0)
        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
      expect(collect, `${fn} 不再先收集`).toBeGreaterThan(-1);
      expect(Number.isFinite(del), `${fn} 找不到删除调用`).toBe(true);
      expect(del).toBeGreaterThan(collect);
    }
  });

  it('书签导入不得再自拼 raw 目录（它曾算到 vault 之外）', () => {
    const src = stripComments(readSrc('src/routes/bookmark-ingest.ts'));
    expect(src).toContain('getVaultRawDir(vaultPath)');
    expect(src).not.toMatch(/replace\(\/\[\\\\\/\]vault\$\//);
    // 落回 vault/raw 之后，它的安全性只剩文件名一条：bookmarks- 前缀必须在白名单之外
    expect(RAW_ARCHIVE_PATTERN.test('bookmarks-2026-10-22T10-12-33.md')).toBe(false);
  });

  it('删除面的文件名/正则只有一个来源（不许再抄第二份内联字面量）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    // 原先这里同一批字面量出现两份（统计一份、删除一份）：改一处就让「卡面数量」与
    // 「真正删掉的集合」分叉。现在只准引 utils/cleanup-surface 的常量。
    expect(src).not.toMatch(/\/\^\(wiki-batch-\|/);
    expect(src).not.toMatch(/\/\\\.(?:json|log)\$\//);
    expect(src).toContain('RAW_ARCHIVE_PATTERN');
    expect(src).toContain('getVaultRawDir(vaultPath)');
    // 产物名由 harness-dirs 定义，surface 判定转引它，两处不许各写一份
    expect(readSrc('src/utils/cleanup-surface.ts')).toContain('COMPILE_CACHE_BASENAME');
    expect(COMPILE_CACHE_BASENAME).toBe('compile-cache.json');
  });

  it('T02897 接线锁：run_logs 纳入编译期拦截 + 任意路径写盘的起跑点先等清理', () => {
    // run-logger 条目的闭合方式：拦截规则（写入在运行中期，等待救不到）
    const guard = readSrc('src/cleanup-guard.ts');
    expect((guard.match(/target: 'run_logs'/g) ?? []).length).toBe(1);
    // mcp 写工具与编辑器保存的闭合方式：起跑点等待（写盘前 awaitCleanupIdle）。
    // 锁定完整语句行而非子串——被 if(false) 之类守卫短路的残骸不应通过锁
    // （T02897 探针实测：indexOf 子串匹配会被这类变异骗过）。
    const mcp = readSrc('src/routes/mcp-route.ts');
    const mcpWait = mcp.search(/^\s*if \(tool\?\.write\) await awaitCleanupIdle\(\);\s*$/m);
    expect(mcpWait, 'mcp-route 丢了写工具的清理等待').toBeGreaterThan(-1);
    expect(mcpWait).toBeLessThan(mcp.indexOf('await callTool('));
    expect(mcp).toMatch(/tool\?\.write/);
    const files = readSrc('src/routes/files.ts');
    const filesWait = files.search(/^\s*await awaitCleanupIdle\(\);\s*$/m);
    expect(filesWait, 'files.ts 丢了保存前的清理等待').toBeGreaterThan(-1);
    expect(filesWait).toBeLessThan(files.indexOf('await vault.writeFile'));
  });
});
