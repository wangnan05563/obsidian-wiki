import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// §11.2 增量编译：基于 raw/ 文件内容哈希跳过已编译资料。
// 缓存文件 .harness/compile-cache.json 维护 { 内容哈希: rawPath } 映射。
// 同一内容重复投递时跳过编译，避免重复消耗 LLM token。

export class CompileCache {
  private readonly cacheFile: string;
  // cache 在 lookup/record 时写入，loaded 在 ensureLoaded 时翻转，均不可 readonly（S2933）
  private cache: Map<string, string> = new Map(); // NOSONAR
  private loaded = false; // NOSONAR

  constructor(cacheFile: string) {
    this.cacheFile = cacheFile;
  }

  // 懒加载缓存文件，首次调用时读取
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.cacheFile, 'utf8');
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        this.cache.set(k, v);
      }
    } catch {
      // 文件不存在或解析失败，空缓存开始
    }
    this.loaded = true;
  }

  // 计算内容 SHA-256 哈希（前 16 字符，足够区分，避免长字符串）
  static hash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  }

  // 检查内容哈希是否已编译过。命中返回 rawPath，未命中返回 null。
  async lookup(content: string): Promise<string | null> {
    await this.ensureLoaded();
    const hash = CompileCache.hash(content);
    return this.cache.get(hash) ?? null;
  }

  // 记录一次成功编译。hash → rawPath 映射持久化。
  async record(content: string, rawPath: string): Promise<void> {
    await this.ensureLoaded();
    const hash = CompileCache.hash(content);
    this.cache.set(hash, rawPath);
    await this.persist();
  }

  // 持久化到文件，幂等。目录不存在时自动创建。
  private async persist(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.cache) {
      obj[k] = v;
    }
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fs.writeFile(this.cacheFile, JSON.stringify(obj, null, 2), 'utf8');
  }
}
