// 运行时路径解析工具
// 解决 SEA（Single Executable Application）模式下 import.meta.url 指向构建时 bundle.cjs
// 而非 exe 路径的问题，统一开发模式与打包模式的资源路径解析。
//
// 核心问题：esbuild 打包时通过 --define 将 import.meta.url 替换为 __import_meta_url，
// banner 中定义为 require('url').pathToFileURL(__filename).href。
// 在 SEA exe 中 __filename 仍指向构建时的 .build/bundle.cjs，用户机器上该文件不存在，
// 导致所有基于 import.meta.url 派生的路径（prompts/、llm-presets.json 等）解析失败。
//
// 解决方案：
// 1. esbuild banner 检测 __filename 是否存在，不存在则用 process.execPath（exe 路径）
// 2. 本工具基于 IS_SEA 标志，在两种模式下返回正确的资源路径
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// SEA 模式检测：__filename 在 SEA exe 中指向构建时的 bundle.cjs，用户机器上不存在
// 为什么用 existsSync：最直接可靠，不依赖 process.pkg（仅传统 pkg 有）等非通用标志
// 为什么用 typeof 而非 globalThis：__filename 在 CJS 中是模块包装函数的局部参数，
//   不是 globalThis 的属性，globalThis.__filename 永远是 undefined。
//   typeof 操作符对未声明变量不会抛 ReferenceError，能安全检测：
//   开发模式（ESM + tsx）：typeof __filename === 'undefined' → IS_SEA = false
//   SEA 模式（CJS bundle）：typeof __filename === 'string'，值为 bundle.cjs 路径
//     → existsSync 返回 false（用户机器不存在）→ IS_SEA = true
// 为什么用 declare：TypeScript ESM 模式不认识 __filename，需声明类型避免编译报错
declare const __filename: string | undefined;
const cjsFilename = typeof __filename !== 'undefined' ? __filename : undefined;
export const IS_SEA = cjsFilename === process.execPath || (cjsFilename ? !fs.existsSync(cjsFilename) : false);

// 源码目录
// 开发模式：各文件自己的源码目录（如 api/src/routes/、api/src/workflows/）
// SEA 模式：exe 所在目录（esbuild banner 已将 import.meta.url 指向 exe 路径）
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

// api 根目录缓存（避免重复向上查找）
let _apiDir: string | null = null;

// 获取 api 根目录
// 开发模式：api/ 目录（包含 llm-presets.json、package.json、src/prompts/）
// SEA 模式：exe 目录（包含 llm-presets.json、package.json、prompts/）
// 为什么用向上查找：不同源文件位于不同子目录（routes/workflows/skill），回退层级不同，
// 用 llm-presets.json 作为锚点最稳健
export function getApiDir(): string {
  if (_apiDir !== null) return _apiDir;
  if (IS_SEA) {
    _apiDir = SRC_DIR;
    return _apiDir;
  }
  // 开发模式：向上查找包含 llm-presets.json 的目录
  let dir = SRC_DIR;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'llm-presets.json'))) {
      _apiDir = dir;
      return _apiDir;
    }
    dir = path.resolve(dir, '..');
  }
  // fallback：回退两级（多数源文件位于 api/src/xxx/ 下）
  _apiDir = path.resolve(SRC_DIR, '..', '..');
  return _apiDir;
}

// 获取 prompts 目录
// 开发模式：api/src/prompts/
// SEA 模式：exe/prompts/（build-exe.ps1 将 api/src/prompts/ 复制到 exe/prompts/）
export function getPromptsDir(): string {
  if (IS_SEA) return path.join(SRC_DIR, 'prompts');
  return path.resolve(getApiDir(), 'src', 'prompts');
}

// 获取指定 prompt 文件路径
export function getPromptPath(name: string): string {
  return path.join(getPromptsDir(), name);
}

// 获取资源文件路径（llm-presets.json、package.json 等位于 api 根目录的文件）
export function getResourcePath(filename: string): string {
  return path.join(getApiDir(), filename);
}

// 获取 data 目录（用户数据：skills、conversations、users.json、audit.log 等）
// 开发模式：karpathy-wiki/data/（api/ 的上一级）
// SEA 模式：用户数据根目录下的 data/（见 getUserDataDir）
export function getDataDir(): string {
  if (IS_SEA) return path.join(getUserDataDir(), 'data');
  return path.resolve(getApiDir(), '..', 'data');
}

// 用户数据根目录（可写配置 / vault / data / .env 等）
// 为什么需要独立目录：
//   打包(SEA)模式下，exe 安装在 Program Files（或其他需管理员目录），普通用户对该目录
//   无写权限，且卸载时会一并清除。若把 config.json / vault / data 放在 exe 同级，
//   应用的"保存配置"会静默失败，且重装/卸载丢失全部用户数据。
//   正确做法：可写用户数据落到每个用户自己的 %LOCALAPPDATA%\KarpathyWiki，
//   由应用首次运行时自动创建，普通用户可写、不受卸载影响、多用户互不干扰。
// 开发模式：沿用既有布局（api/ 目录），行为不变。
// 为什么用 LOCALAPPDATA：按用户隔离、无需管理员；回退顺序 APPDATA → HOME 兼容非常规环境。
let _userDataDir: string | null = null;
export function getUserDataDir(): string {
  if (_userDataDir !== null) return _userDataDir;
  if (IS_SEA) {
    const base =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      os.homedir();
    _userDataDir = path.join(base, 'KarpathyWiki');
  } else {
    // 开发模式：用户数据根目录 = api 目录（config.json 在 api/，data 在 api/..）
    _userDataDir = getApiDir();
  }
  // 确保目录存在（首次运行自动创建）
  try {
    fs.mkdirSync(_userDataDir, { recursive: true });
  } catch {
    // 创建失败时退回原值，后续读写会报错由调用方处理
  }
  return _userDataDir;
}

// 用户数据目录下的具体文件路径（如 config.json / .env）
export function getUserDataPath(filename: string): string {
  return path.join(getUserDataDir(), filename);
}

