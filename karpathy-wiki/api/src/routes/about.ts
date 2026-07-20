import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 关于页面路由：提供系统元信息与版本检查。
// 参考 17_xianyu 项目 about 模块设计，适配本项目 Fastify + 无外网发布的场景。
//   GET /api/about              返回版本号、构建日期、Git SHA、Node 版本、平台
//   GET /api/about/check-update 检查更新（首版无外网发布通道，固定返回 has_update=false）
//
// 设计取舍：
//   - 不发起外网请求，避免 SSRF 风险（参考闲鱼项目风险表 10.1）
//   - 版本号从 api/package.json 读取，构建日期取 package.json 修改时间
//   - Git SHA 通过 git rev-parse 获取，无 git 环境时返回 unknown
//   - check-update 后端 5 分钟缓存，避免前端高频调用

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.resolve(dirname, '..', '..', 'package.json');

// 5 分钟缓存：与闲鱼项目一致，避免前端轮询造成不必要计算
const CHECK_UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

let checkUpdateCache: { data: unknown; ts: number } | null = null;

// 读取 package.json 中的版本号。失败时回退 '0.0.0' 保证 UI 不崩。
async function readVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(PACKAGE_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// 读取 package.json 的 mtime 作为构建日期（ISO 8601 YYYY-MM-DD）。
// 为什么用 mtime 而非内置 build_info：本项目无构建脚本生成 _build_info，mtime 已足够。
async function readBuildDate(): Promise<string> {
  try {
    const stat = await fs.stat(PACKAGE_JSON_PATH);
    return stat.mtime.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

// 读取 Git SHA（7 位短哈希）。无 git 环境或非 git 仓库时返回 unknown。
function readGitSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function registerAboutRoute(app: FastifyInstance): void {
  // GET /api/about：返回系统元信息。所有字段失败时回退安全值，UI 不白屏。
  app.get('/api/about', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [version, buildDate] = await Promise.all([readVersion(), readBuildDate()]);
    const gitSha = readGitSha();

    return reply.send({
      product: 'Karpathy Wiki',
      version,
      build_date: buildDate,
      git_sha: gitSha,
      node: process.versions.node,
      platform: process.platform,
    });
  });

  // GET /api/about/check-update：检查更新。
  // 本项目无外网发布通道，固定返回 has_update=false；缓存 5 分钟减少重复读取。
  // 后续若接入外网发布，仅需修改此路由内部实现，前端无感。
  app.get('/api/about/check-update', async (_req: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    if (checkUpdateCache && (now - checkUpdateCache.ts) < CHECK_UPDATE_CACHE_TTL_MS) {
      return reply.send(checkUpdateCache.data);
    }

    const current = await readVersion();
    const data = {
      current,
      latest: current,
      has_update: false,
      release_url: '',
      published_at: '',
      checked_at: new Date().toISOString(),
      source: 'local' as const,
    };

    checkUpdateCache = { data, ts: now };
    return reply.send(data);
  });
}

// 工具函数：导出供测试或外部模块复用（按需调用，避免每次启动都执行 git 命令）
export function _readPackageJsonSync(): { version: string; exists: boolean } {
  try {
    if (!fsSync.existsSync(PACKAGE_JSON_PATH)) {
      return { version: '0.0.0', exists: false };
    }
    const raw = fsSync.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return { version: parsed.version ?? '0.0.0', exists: true };
  } catch {
    return { version: '0.0.0', exists: false };
  }
}
