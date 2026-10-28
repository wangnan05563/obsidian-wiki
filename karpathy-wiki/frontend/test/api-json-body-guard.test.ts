import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 前端「点击恢复报 HTTP 400」的根因是 POST 声明了 Content-Type: application/json
// 却不发 body——Fastify 在进路由前就以 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝。
// 这里做成全量守护：任何带 body 语义的请求声明 JSON 就必须给 body，避免同类问题在别处复发。

const SRC_DIR = path.resolve(__dirname, '../src');
const BODY_METHODS = /\bmethod:\s*['"](POST|PUT|PATCH|DELETE)['"]/i;

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (/\.(ts|vue)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** 取 `(` 起配平的调用表达式；找不到配对返回 null */
function callAt(src: string, openParen: number): string | null {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return null;
}

describe('API 请求体形态守护（恢复 400 回归）', () => {
  it('声明 application/json 的 POST/PUT/PATCH/DELETE 必须携带 body', () => {
    const offenders: string[] = [];
    for (const file of collectFiles(SRC_DIR)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/\b(?:apiFetch|fetch)\s*\(/g)) {
        const call = callAt(src, match.index + match[0].length - 1);
        if (!call) continue;
        if (!call.includes('application/json')) continue;
        if (!BODY_METHODS.test(call)) continue;
        if (/\bbody\s*:/.test(call)) continue;
        const line = src.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(SRC_DIR, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
