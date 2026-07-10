import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { TunnelConfig } from '../types.js';

// 二进制下载失败时抛出，附带手动放置指引供前端渲染下载链接。
// 这样前端可以引导用户手动下载并放到指定路径，而不是只能报错。
export class BinaryDownloadError extends Error {
  readonly manualPath: string;
  readonly downloadUrls: string[];
  constructor(message: string, manualPath: string, downloadUrls: string[]) {
    super(message);
    this.name = 'BinaryDownloadError';
    this.manualPath = manualPath;
    this.downloadUrls = downloadUrls;
  }
}

// Provider 抽象基类：封装"二进制管理 + 子进程启动 + URL 解析 + 停止"通用流程。
// 新增 provider 只需继承并实现 4 个抽象方法，无需改动 TunnelService。
abstract class TunnelProvider {
  protected proc: ChildProcess | null = null;
  protected publicUrl: string | null = null;
  protected exited = false;
  protected readonly binary: string;

  constructor(protected readonly localPort: number, protected readonly binaryPath: string) {
    // 优先用户手动放置路径（离线/下载失败场景），否则自动下载到 data/ 目录
    this.binary = binaryPath || path.resolve(process.cwd(), 'data', this.binaryName());
  }

  abstract binaryName(): string;
  abstract downloadUrls(): string[];
  abstract startCommand(): string[];
  abstract urlPattern(): RegExp;
  abstract providerName(): string;

  // 确保二进制存在；用户指定了路径但不存在时直接报错（不自动下载到别处）
  protected async ensureBinary(): Promise<void> {
    if (fs.existsSync(this.binary)) return;
    if (this.binaryPath) {
      throw new BinaryDownloadError(
        `指定的二进制文件不存在: ${this.binaryPath}`,
        this.binaryPath,
        this.downloadUrls(),
      );
    }
    await this.downloadBinary();
  }

  // 多镜像源 fallback 下载，全部失败才抛 BinaryDownloadError
  protected async downloadBinary(): Promise<void> {
    await fsp.mkdir(path.dirname(this.binary), { recursive: true });
    const urls = this.downloadUrls();
    let lastErr: Error | null = null;
    for (const url of urls) {
      try {
        await this.doDownload(url, this.binary);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new BinaryDownloadError(
      `${this.binaryName()} 所有下载源均失败: ${lastErr?.message ?? '未知错误'}`,
      this.binary,
      urls,
    );
  }

  // 默认直接下载；cpolar 覆写为"下载 zip + 解压"
  protected async doDownload(url: string, target: string): Promise<void> {
    await downloadFile(url, target);
  }

  // 子类钩子：启动前准备（如 cpolar 配置 authtoken）
  protected beforeStart(): void {}

  // 启动隧道子进程，等待公网 URL 出现（15 秒超时）
  async start(): Promise<void> {
    await this.ensureBinary();
    this.beforeStart();

    const args = this.startCommand();
    // windowsHide 等价于 Python 的 CREATE_NO_WINDOW，避免弹出黑窗
    this.proc = spawn(this.binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exited = false;

    // 监听 exit：子进程崩溃时更新状态（前端轮询可感知）
    this.proc.on('exit', () => {
      this.exited = true;
      this.publicUrl = null;
    });

    await this.waitForUrl(15000);
  }

  // 从 stdout/stderr 读取并匹配公网 URL
  private waitForUrl(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.proc) {
        return reject(new Error('子进程未启动'));
      }
      const proc = this.proc;
      const pattern = this.urlPattern();
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待公网 URL 超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);

      const handleData = (chunk: Buffer): void => {
        const match = chunk.toString().match(pattern);
        if (match) {
          this.publicUrl = match[0];
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`子进程异常退出，code=${code}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        proc.stdout?.removeListener('data', handleData);
        proc.stderr?.removeListener('data', handleData);
        proc.removeListener('error', onError);
        proc.removeListener('exit', onExit);
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);
      proc.on('error', onError);
      proc.on('exit', onExit);
    });
  }

  // 同步终止子进程（cloudflared/cpolar 被 kill 后立即退出，无需 graceful wait）
  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // 忽略 kill 失败（进程可能已退出）
    }
    this.proc = null;
    this.exited = true;
    this.publicUrl = null;
  }

  get status(): 'running' | 'stopped' {
    return this.proc && !this.exited ? 'running' : 'stopped';
  }

  get url(): string | null {
    return this.publicUrl;
  }
}

// Cloudflare quick tunnel：免注册，自动分配 trycloudflare 域名。
// 大陆访问可能不稳定，但开箱即用。
class CloudflareProvider extends TunnelProvider {
  binaryName(): string {
    return 'cloudflared.exe';
  }
  providerName(): string {
    return 'cloudflare';
  }
  downloadUrls(): string[] {
    // 主源 latest + 备源固定版本（均走 GitHub，大陆可能不稳定，失败时前端引导手动下载）
    return [
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      'https://github.com/cloudflare/cloudflared/releases/download/2024.12.2/cloudflared-windows-amd64.exe',
    ];
  }
  startCommand(): string[] {
    return ['tunnel', '--url', `http://localhost:${this.localPort}`, '--no-autoupdate'];
  }
  urlPattern(): RegExp {
    return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  }
}

// cpolar：国内推荐，需注册账号获取 authtoken。
// 下载的是 zip，需要解压后才能使用。
class CpolarProvider extends TunnelProvider {
  private readonly authtoken: string;

  constructor(localPort: number, binaryPath: string, authtoken: string) {
    super(localPort, binaryPath);
    this.authtoken = authtoken;
  }

  binaryName(): string {
    return 'cpolar.exe';
  }
  providerName(): string {
    return 'cpolar';
  }
  downloadUrls(): string[] {
    return [
      'https://www.cpolar.com/static/downloads/releases/cpolar-stable-windows-amd64.zip',
      'https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-windows-amd64.zip',
    ];
  }
  startCommand(): string[] {
    return ['http', String(this.localPort)];
  }
  urlPattern(): RegExp {
    return /https:\/\/[a-z0-9-]+\.cpolar\.(top|io|cn|com)/;
  }

  // cpolar 下载的是 zip，用 Windows 10 内置的 tar 解压（避免 PowerShell 中文路径编码问题）
  protected async doDownload(url: string, target: string): Promise<void> {
    const tmpZip = target + '.zip';
    await downloadFile(url, tmpZip);
    try {
      const dir = path.dirname(target);
      // execFileSync 不走 shell，参数数组传递避免路径转义问题
      execFileSync('tar', ['-xf', tmpZip, '-C', dir], { windowsHide: true, timeout: 30000 });
      // zip 内可能嵌套目录，递归查找 cpolar.exe
      const extracted = findFile(dir, 'cpolar.exe');
      if (!extracted) {
        throw new Error('zip 解压后未找到 cpolar.exe');
      }
      if (extracted !== target) {
        await fsp.rename(extracted, target);
      }
    } finally {
      try {
        await fsp.unlink(tmpZip);
      } catch {
        // 忽略临时文件清理失败
      }
    }
  }

  // 启动前配置 authtoken（幂等：重复配置会报错，忽略即可）
  protected beforeStart(): void {
    if (!this.authtoken) {
      throw new Error('cpolar 需要 authtoken，请到 https://dashboard.cpolar.com/signup 注册获取');
    }
    try {
      execFileSync(this.binary, ['authtoken', this.authtoken], {
        windowsHide: true,
        timeout: 10000,
      });
    } catch {
      // authtoken 已配置时重复执行会报错，忽略
    }
  }
}

// 通用文件下载：支持 https/http + 301/302 重定向（GitHub releases 会重定向到 CDN）
function downloadFile(url: string, target: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (location) {
          downloadFile(location, target).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(target);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve();
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    // 60 秒空闲超时（无数据传输），大文件下载只要持续有数据就不会触发
    req.setTimeout(60000, () => {
      req.destroy(new Error('下载超时'));
    });
  });
}

// 递归查找文件（cpolar zip 解压后可能嵌套目录）
function findFile(dir: string, name: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

// TunnelService：管理 provider 生命周期，薄封装委托给 provider。
// 由 index.ts 创建单例并注入到 tunnel 路由，符合项目依赖注入模式。
export class TunnelService {
  private provider: TunnelProvider | null = null;
  private currentConfig: TunnelConfig | null = null;

  // 端口解析优先级：tunnel.localPort > 0 则用 localPort，否则从 server.port 继承
  static resolvePort(tunnel: TunnelConfig, serverPort: number): number {
    return tunnel.localPort > 0 ? tunnel.localPort : serverPort;
  }

  async start(config: TunnelConfig, serverPort: number): Promise<void> {
    // 配置变更（provider/port/binaryPath/authtoken 任一变化）时重建 provider
    const configChanged =
      !this.currentConfig ||
      this.currentConfig.provider !== config.provider ||
      this.currentConfig.localPort !== config.localPort ||
      this.currentConfig.binaryPath !== config.binaryPath ||
      this.currentConfig.cpolarAuthtoken !== config.cpolarAuthtoken;

    if (configChanged) {
      if (this.provider) {
        this.provider.stop();
      }
      const port = TunnelService.resolvePort(config, serverPort);
      this.provider = createProvider(config, port);
    } else if (this.status === 'running') {
      // 配置未变且已在运行，跳过重复启动
      return;
    }

    // provider 可能在子进程崩溃后为 null，需重建
    if (!this.provider) {
      const port = TunnelService.resolvePort(config, serverPort);
      this.provider = createProvider(config, port);
    }

    await this.provider.start();
    this.currentConfig = config;
  }

  stop(): void {
    if (this.provider) {
      this.provider.stop();
    }
  }

  get status(): 'running' | 'stopped' {
    return this.provider?.status ?? 'stopped';
  }

  get publicUrl(): string | null {
    return this.provider?.url ?? null;
  }

  get providerName(): string {
    return this.currentConfig?.provider ?? '';
  }
}

// Provider 工厂：按 config.provider 创建对应实例
function createProvider(config: TunnelConfig, localPort: number): TunnelProvider {
  switch (config.provider) {
    case 'cloudflare':
      return new CloudflareProvider(localPort, config.binaryPath);
    case 'cpolar':
      return new CpolarProvider(localPort, config.binaryPath, config.cpolarAuthtoken);
    default:
      throw new Error(`不支持的 provider: ${config.provider}`);
  }
}
