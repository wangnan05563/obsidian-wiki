// 把传入路径解析为 vault 内的绝对路径，并阻止越权访问 vault 之外的文件。
// 前端 data-clean 页传的是 vault 相对路径（如 concepts/foo.md），后端需拼回绝对路径才能
// fs.unlink / fs.rename；若传入已是绝对路径则原样使用（path.join 会忽略前面的 base）。
// T02797 起对外导出：错位页归位同样需要 unlink 原路径，这道防线只留一份实现
//   （再抄一遍 `startsWith(base + path.sep)` 就是「两处判断、漏一处越权」的同源缺陷）。
// T02843 从 quality-scanner.ts 移入本模块：预检要引用错位页检测结果才能与「索引不到」那块同口径，
//   而检测又要用这道防线，两边都留在 quality-scanner 里就成了
//   quality-scanner → misplaced-pages → quality-scanner 的循环依赖。中立模块是唯一的破环位置：
//   口径仍然只有一份，且不靠「谁也不许调用谁」这种约定维持。
import path from "node:path";
import type { VaultService } from "../vault/vault-service.js";

export function resolveVaultPath(vault: VaultService, p: string): string {
  const base = path.resolve(vault.getVaultPath());
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes vault root: ${p}`);
  }
  return abs;
}
