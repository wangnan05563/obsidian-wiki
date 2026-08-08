import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSpaRoot, resolveSpaAsset } from '../src/spa-resolver.js';

let tmp: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-resolver-'));
  // resolveSpaRoot 还会检查 process.cwd()/public 等绝对候选目录，
  // 桩掉 cwd 使测试与真实工程目录隔离，仅验证传入 apiDir 下的 public_live_* 选取逻辑。
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
});
afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeIndex(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
}

describe('resolveSpaRoot', () => {
  it('returns null when no candidate has index.html', () => {
    expect(resolveSpaRoot(tmp)).toBeNull();
  });

  it('picks the newest public_live_<ts> directory', () => {
    writeIndex(path.join(tmp, 'public_live_1000'));
    writeIndex(path.join(tmp, 'public_live_3000'));
    writeIndex(path.join(tmp, 'public_live_2000'));
    expect(resolveSpaRoot(tmp)).toBe(path.join(tmp, 'public_live_3000'));
  });

  it('ignores public_live_quarantine_* dirs (non-numeric suffix)', () => {
    writeIndex(path.join(tmp, 'public_live_quarantine_123'));
    writeIndex(path.join(tmp, 'public_live_5000'));
    expect(resolveSpaRoot(tmp)).toBe(path.join(tmp, 'public_live_5000'));
  });

  it('falls back to legacy public_live when no timestamped dir', () => {
    writeIndex(path.join(tmp, 'public_live'));
    expect(resolveSpaRoot(tmp)).toBe(path.join(tmp, 'public_live'));
  });

  it('prefers newest timestamped dir over legacy public_live', () => {
    writeIndex(path.join(tmp, 'public_live'));
    writeIndex(path.join(tmp, 'public_live_9000'));
    expect(resolveSpaRoot(tmp)).toBe(path.join(tmp, 'public_live_9000'));
  });

  it('tolerates non-directory entries named like live dirs without throwing', () => {
    fs.writeFileSync(path.join(tmp, 'public_live_notadir'), 'x');
    expect(() => resolveSpaRoot(tmp)).not.toThrow();
    expect(resolveSpaRoot(tmp)).toBeNull();
  });

  it('does not crash on a broken symlink entry', () => {
    try {
      fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(tmp, 'public_live_9999'));
    } catch {
      // symlink may be unsupported on some filesystems; skip silently
    }
    writeIndex(path.join(tmp, 'public_live_1000'));
    expect(() => resolveSpaRoot(tmp)).not.toThrow();
    expect(resolveSpaRoot(tmp)).toBe(path.join(tmp, 'public_live_1000'));
  });

  it('skips newest dir whose referenced asset is missing (interrupted deploy) and falls back to a complete one', () => {
    // 最新时间戳目录：index.html 存在但引用了磁盘上不存在的 JS —— 模拟「部署脚本复制途中被杀」的残缺包
    const broken = path.join(tmp, 'public_live_9000');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(
      path.join(broken, 'index.html'),
      '<html><script type="module" src="/wiki/assets/index-MISSING.js"></script></html>',
    );
    // 较旧但完整的目录（含被引用的资源文件）
    const good = path.join(tmp, 'public_live_5000');
    fs.mkdirSync(path.join(good, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(good, 'index.html'),
      '<html><script type="module" src="/wiki/assets/index-GOOD.js"></script></html>',
    );
    fs.writeFileSync(path.join(good, 'assets', 'index-GOOD.js'), 'console.log(1)');

    expect(resolveSpaRoot(tmp)).toBe(good);
  });

  it('treats a dir with index.html but no js/css refs as complete', () => {
    const dir = path.join(tmp, 'public_live_7000');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>minimal</body></html>');
    expect(resolveSpaRoot(tmp)).toBe(dir);
  });
});

describe('resolveSpaAsset', () => {
  let root: string;
  beforeEach(() => {
    root = path.join(tmp, 'spa');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'assets', 'styles.css'), 'body{}');
  });

  it('resolves a normal asset path to its relative form', () => {
    expect(resolveSpaAsset(root, '/assets/app.js')).toBe('assets/app.js');
    expect(resolveSpaAsset(root, 'assets/styles.css')).toBe('assets/styles.css');
  });

  it('resolves index.html with leading slash', () => {
    expect(resolveSpaAsset(root, '/index.html')).toBe('index.html');
  });

  it('returns null for a path that escapes the root via ..', () => {
    expect(resolveSpaAsset(root, '/../secret.json')).toBeNull();
    expect(resolveSpaAsset(root, '/assets/../../etc/passwd')).toBeNull();
  });

  it('returns null when the referenced file does not exist', () => {
    expect(resolveSpaAsset(root, '/assets/missing.js')).toBeNull();
  });

  it('returns null for a directory path (not a file)', () => {
    expect(resolveSpaAsset(root, '/assets')).toBeNull();
  });

  it('returns null for encoded traversal (%2e%2e) normalized away from root', () => {
    // path.resolve 会把 %2e 当普通文件名而非「.，但仍不允许越界：构造一个真实越界的绝对/相对串
    expect(resolveSpaAsset(root, '/..%2f..%2fetc%2fpasswd')).toBeNull();
  });
});

