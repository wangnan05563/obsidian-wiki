// T02802 前后端手工镜像类型的通用契约守护。
// ------------------------------------------------------------------
// 结构性缺陷的形状（T02773 实测）：api 与 frontend 各有一份手写镜像类型，两侧 tsconfig 的
// include 都只有自己的 src/**/*，跨服务契约的字段名错配 **编译器永远看不见**，测试也不覆盖，
// 于是缺陷以「功能正常、显示被吃掉」的形态长期潜伏（后端 totalFreedMb / 前端 total_freed_mb）。
// T02773 只在清理那一条链路上锁了 CleanupResult；本单把同一件事做成通用规则：
//   · 两侧 types.ts 里每一个同名类型都必须在 docs/mirror-types.json 显式判定
//     ——对齐（aligned）或有意裁剪（*-superset / unrelated），新增未登记直接红；
//   · 判定结果逐字比对，多一个字段少一个字段都要红；
//   · 字符串字面量联合另按成员集合比对（少一档权威度同样是分叉）。
//
// 解析口径用 TypeScript Compiler API 而不是正则：T02773 排查时那段临时正则把
// CleanupStorageStatus 误判成「后端缺 runState/runLogs」（实际就在，是解析器被嵌套对象带偏），
// 所以「4 个类型漂移」这种数字只能当线索。本文件放在 api/test，理由是它同时读两份源码——
// 任一侧改名都会红，与「哪个包的 CI 先跑」无关。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const API_TYPES_PATH = path.join(REPO_ROOT, 'api', 'src', 'types.ts');
const FE_TYPES_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'types.ts');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'mirror-types.json');

const VERDICTS = ['aligned', 'frontend-superset', 'api-superset', 'unrelated'] as const;
type Verdict = (typeof VERDICTS)[number];

interface TypeShape {
  /** 顶层字段名（含 extends 链与交叉类型成员；索引签名记作 [index]） */
  fields: string[];
  /** 字符串字面量联合的成员集合（非联合类型时为空） */
  literals: string[];
  /** 解析过程中遇到的、无法结构化展开的情况——出现即说明登记表需要人工复核 */
  notes: string[];
}

interface RegistryEntry {
  /** 两侧同名镜像类型的登记键 */
  name?: string;
  /** 跨名镜像（同一契约两侧起名不同）的两端类型名 */
  api?: string;
  frontend?: string;
  verdict: Verdict;
  frontendOnly?: string[];
  apiOnly?: string[];
  reason: string;
}

interface RegistryFile {
  types: RegistryEntry[];
  pairs: RegistryEntry[];
}

const K = ts.SyntaxKind;

function sortedUnique(names: string[]): string[] {
  return [...new Set(names)].sort();
}

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return name.getText();
}

function membersOfObjectLike(members: ts.NodeArray<ts.TypeElement>): string[] {
  const out: string[] = [];
  for (const m of members) {
    if (m.kind === K.PropertySignature || m.kind === K.MethodSignature) {
      const n = propertyName((m as ts.PropertySignature).name);
      if (n) out.push(n);
    } else if (m.kind === K.IndexSignature) {
      out.push('[index]');
    }
  }
  return out;
}

function literalTexts(node: ts.TypeNode): string[] | null {
  const parts = node.kind === K.UnionType ? (node as ts.UnionTypeNode).types : [node];
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind !== K.LiteralType) return null;
    const lit = (p as ts.LiteralTypeNode).literal;
    if (!ts.isStringLiteral(lit)) return null;
    out.push(lit.text);
  }
  return out;
}

/** 解析一份 types.ts：返回「类型名 -> 形状」。类型引用可解析到本文件内的声明则内联展开。 */
export function parseTypeFile(file: string): Map<string, TypeShape> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const decls = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const st of source.statements) {
    if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name) {
      decls.set(st.name.text, st);
    }
  }

  function shapeOfNode(node: ts.TypeNode, seen: Set<string>): TypeShape {
    if (node.kind === K.TypeLiteral) {
      return { fields: membersOfObjectLike((node as ts.TypeLiteralNode).members), literals: [], notes: [] };
    }
    if (node.kind === K.IntersectionType) {
      const parts = (node as ts.IntersectionTypeNode).types.map((t) => shapeOfNode(t, seen));
      return {
        fields: sortedUnique(parts.flatMap((p) => p.fields)),
        literals: [],
        notes: parts.flatMap((p) => p.notes),
      };
    }
    const lits = literalTexts(node);
    if (lits) return { fields: [], literals: sortedUnique(lits), notes: [] };
    if (node.kind === K.UnionType) {
      // 联合的对象分支：公共字段才是两侧都能依赖的契约面；差异另由 notes 交给人工判定
      const parts = (node as ts.UnionTypeNode).types.map((t) => shapeOfNode(t, seen));
      const [first, ...rest] = parts;
      const common = (first?.fields ?? []).filter((n) => rest.every((p) => p.fields.includes(n)));
      return {
        fields: sortedUnique(common),
        literals: [],
        notes: [`union(${parts.length} 分支) 只取公共字段`, ...parts.flatMap((p) => p.notes)],
      };
    }
    if (node.kind === K.TypeReference && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      if (!decls.has(name)) return { fields: [], literals: [], notes: [`引用外部/内置类型 ${name}`] };
      if (seen.has(name)) return { fields: [], literals: [], notes: [`循环引用 ${name}`] };
      const r = shapeOfDecl(name);
      seen.add(name);
      return r;
    }
    if (node.kind === K.ArrayType || node.kind === K.TupleType || node.kind === K.MappedType) {
      return { fields: [], literals: [], notes: [`非对象形状 ${K[node.kind]}`] };
    }
    return { fields: [], literals: [], notes: [`未能结构化解析 ${K[node.kind]}`] };
  }

  function shapeOfDecl(name: string): TypeShape {
    const decl = decls.get(name);
    if (!decl) return { fields: [], literals: [], notes: [`声明缺失 ${name}`] };
    const seen = new Set<string>([name]);
    if (ts.isInterfaceDeclaration(decl)) {
      const acc: TypeShape = { fields: membersOfObjectLike(decl.members), literals: [], notes: [] };
      for (const clause of decl.heritageClauses ?? []) {
        for (const base of clause.types) {
          const baseName = base.expression.getText();
          if (!decls.has(baseName)) {
            acc.notes.push(`extends 外部类型 ${baseName}`);
            continue;
          }
          const r = shapeOfDecl(baseName);
          acc.fields.push(...r.fields);
          acc.notes.push(...r.notes.map((n) => `[via ${baseName}] ${n}`));
        }
      }
      acc.fields = sortedUnique(acc.fields);
      return acc;
    }
    return shapeOfNode(decl.type, seen);
  }

  const shapes = new Map<string, TypeShape>();
  for (const name of decls.keys()) shapes.set(name, shapeOfDecl(name));
  return shapes;
}

const apiShapes = parseTypeFile(API_TYPES_PATH);
const feShapes = parseTypeFile(FE_TYPES_PATH);

function loadRegistry(): RegistryFile {
  expect(existsSync(REGISTRY_PATH), `镜像类型契约登记表缺失：${REGISTRY_PATH}`).toBe(true);
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
}

const REGISTRY = loadRegistry();

/** 两侧 types.ts 里同名类型的集合——登记必须与它一一对应，多一条少一条都红 */
function sameNameMirrorTypes(): string[] {
  return sortedUnique([...apiShapes.keys()].filter((n) => feShapes.has(n)));
}

function shapeOf(side: Map<string, TypeShape>, label: string, name: string): TypeShape {
  const s = side.get(name);
  expect(s, `${label} 侧不存在类型 ${name}（登记表已过期，或该侧改名/删除了镜像）`).toBeTruthy();
  return s as TypeShape;
}

/** 一条登记 + 两份实际形状 -> 违规清单。抽成纯函数，好让反向用例能喂合成形状。 */
export function violationsFor(
  label: string,
  api: TypeShape,
  fe: TypeShape,
  entry: Pick<RegistryEntry, 'verdict' | 'apiOnly' | 'frontendOnly'>,
): string[] {
  const apiOnly = sortedUnique(api.fields.filter((f) => !fe.fields.includes(f)));
  const feOnly = sortedUnique(fe.fields.filter((f) => !api.fields.includes(f)));
  const wantApiOnly = sortedUnique(entry.apiOnly ?? []);
  const wantFeOnly = sortedUnique(entry.frontendOnly ?? []);
  const out: string[] = [];

  switch (entry.verdict) {
    case 'aligned':
      if (apiOnly.length || feOnly.length) {
        out.push(
          `${label} 判定为「对齐」，但字段集合已分叉：仅后端有 ${JSON.stringify(apiOnly)}、仅前端有 ${JSON.stringify(feOnly)}`,
        );
      }
      break;
    case 'frontend-superset':
      if (apiOnly.length) out.push(`${label} 判定为「前端裁剪超集」，却出现仅后端有的字段：${JSON.stringify(apiOnly)}`);
      if (JSON.stringify(feOnly) !== JSON.stringify(wantFeOnly)) {
        out.push(`${label} 前端独有字段与登记不一致：实际 ${JSON.stringify(feOnly)}，登记 ${JSON.stringify(wantFeOnly)}`);
      }
      break;
    case 'api-superset':
      if (feOnly.length) out.push(`${label} 判定为「后端裁剪超集」，却出现仅前端有的字段：${JSON.stringify(feOnly)}`);
      if (JSON.stringify(apiOnly) !== JSON.stringify(wantApiOnly)) {
        out.push(`${label} 后端独有字段与登记不一致：实际 ${JSON.stringify(apiOnly)}，登记 ${JSON.stringify(wantApiOnly)}`);
      }
      break;
    case 'unrelated':
      if (JSON.stringify(apiOnly) !== JSON.stringify(wantApiOnly) || JSON.stringify(feOnly) !== JSON.stringify(wantFeOnly)) {
        out.push(
          `${label} 判定为「同名不同契约」，但差异集合与登记不一致：实际 仅后端 ${JSON.stringify(apiOnly)} / 仅前端 ${JSON.stringify(feOnly)}，登记 ${JSON.stringify(wantApiOnly)} / ${JSON.stringify(wantFeOnly)}`,
        );
      }
      break;
  }

  const litApiOnly = sortedUnique(api.literals.filter((l) => !fe.literals.includes(l)));
  const litFeOnly = sortedUnique(fe.literals.filter((l) => !api.literals.includes(l)));
  if (litApiOnly.length || litFeOnly.length) {
    out.push(`${label} 字面量联合成员已分叉：仅后端 ${JSON.stringify(litApiOnly)}、仅前端 ${JSON.stringify(litFeOnly)}`);
  }
  return out;
}

describe('T02802 前后端镜像类型通用契约守护', () => {
  it('两侧 types.ts 都能被 AST 解析出类型（守护不是空跑）', () => {
    expect(apiShapes.size, 'api/src/types.ts 解析出的类型数').toBeGreaterThanOrEqual(60);
    expect(feShapes.size, 'frontend/src/types.ts 解析出的类型数').toBeGreaterThanOrEqual(120);
    const mirror = sameNameMirrorTypes();
    expect(mirror.length, '两侧同名镜像类型数').toBeGreaterThanOrEqual(25);
    // 比对面不能退化成空集：登记表里所有同名类型的字段总数要有量级
    const totalFields = mirror.reduce((sum, n) => sum + shapeOf(apiShapes, 'api', n).fields.length, 0);
    expect(totalFields, '参与比对的字段总数').toBeGreaterThanOrEqual(120);
  });

  it('AST 口径复核 T02773 踩过的正则坑（解析器不能被嵌套对象带偏）', () => {
    const storage = shapeOf(apiShapes, 'api', 'CleanupStorageStatus');
    // 临时正则当时误报「后端缺 runState/runLogs」，实际就在——这条锁住解析口径本身
    expect(storage.fields).toContain('runState');
    expect(storage.fields).toContain('runLogs');
    expect(sameNameMirrorTypes()).toContain('CleanupStorageStatus');

    const cleanup = [shapeOf(apiShapes, 'api', 'CleanupResult'), shapeOf(feShapes, 'frontend', 'CleanupResult')];
    for (const s of cleanup) {
      expect(s.fields).toContain('total_freed_mb');
      expect(s.fields).not.toContain('totalFreedMb');
    }
    expect(cleanup[0].fields).toEqual(cleanup[1].fields);
  });

  it('登记表条目形状自审：判定合法、理由必填、差异集合只在非对齐时出现', () => {
    const entries = [...REGISTRY.types, ...REGISTRY.pairs];
    expect(entries.length).toBeGreaterThan(0);
    for (const e of REGISTRY.types) {
      expect(e.name, 'types 条目必须有 name').toBeTruthy();
      expect(apiShapes.has(e.name as string) && feShapes.has(e.name as string), `${e.name} 并非两侧同名类型`).toBe(true);
    }
    for (const p of REGISTRY.pairs) {
      const pairLabel = `${p.api ?? '?'}<->${p.frontend ?? '?'}`;
      expect(!!p.api && !!p.frontend, `pairs 条目 ${pairLabel} 必须同时给出 api 与 frontend 类型名`).toBe(true);
      expect(apiShapes.has(p.api as string), `api 侧不存在 ${p.api}`).toBe(true);
      expect(feShapes.has(p.frontend as string), `frontend 侧不存在 ${p.frontend}`).toBe(true);
    }
    const names = entries.map((e) => `${e.name ?? `${e.api}<->${e.frontend}`}`);
    expect(new Set(names).size, '登记表存在重复条目').toBe(names.length);
    for (const e of entries) {
      expect(VERDICTS as readonly string[], `${names} 的 verdict 非法：${e.verdict}`).toContain(e.verdict);
      expect(e.reason?.trim(), `${e.name ?? `${e.api}<->${e.frontend}`} 未写理由`).not.toBe('');
      if (e.verdict === 'aligned') {
        expect(e.apiOnly ?? [], 'aligned 不应登记 apiOnly').toEqual([]);
        expect(e.frontendOnly ?? [], 'aligned 不应登记 frontendOnly').toEqual([]);
      } else {
        const registered = (e.apiOnly?.length ?? 0) + (e.frontendOnly?.length ?? 0);
        expect(registered, `${e.name ?? e.api} 判定为 ${e.verdict} 却没登记差异字段集合`).toBeGreaterThan(0);
      }
    }
  });

  it('两侧同名镜像类型与登记表一一对应（新增未登记即红，登记失效也红）', () => {
    const mirror = sameNameMirrorTypes();
    const registered = sortedUnique(REGISTRY.types.map((t) => t.name as string));
    expect(
      registered,
      `登记表与代码不同源：未登记=${JSON.stringify(mirror.filter((m) => !registered.includes(m)))}，已失效=${JSON.stringify(
        registered.filter((r) => !mirror.includes(r)),
      )}`,
    ).toEqual(mirror);
  });

  it('逐条按判定比对字段集合（对齐/裁剪二选一，全部锁死）', () => {
    const violations: string[] = [];
    for (const e of REGISTRY.types) {
      violations.push(...violationsFor(e.name as string, shapeOf(apiShapes, 'api', e.name as string), shapeOf(feShapes, 'frontend', e.name as string), e));
    }
    for (const p of REGISTRY.pairs) {
      violations.push(
        ...violationsFor(`${p.api}↔${p.frontend}`, shapeOf(apiShapes, 'api', p.api as string), shapeOf(feShapes, 'frontend', p.frontend as string), p),
      );
    }
    expect(violations, `镜像类型契约漂移：\n${violations.join('\n')}`).toEqual([]);
  });

  it('本单修掉的两处分叉保持修好状态（回退锁）', () => {
    // BatchFixRequest：api 原先缺 issueKeys，靠路由就地 `& { issueKeys?: string[] }` 补
    const req = [shapeOf(apiShapes, 'api', 'BatchFixRequest'), shapeOf(feShapes, 'frontend', 'BatchFixRequest')];
    for (const s of req) expect(s.fields).toContain('issueKeys');
    // McpServerEntry：懒加载两键只有后端镜像有，前端 JSON 模式往返会把它清掉
    const mcp = [shapeOf(apiShapes, 'api', 'McpServerEntry'), shapeOf(feShapes, 'frontend', 'McpServerEntry')];
    for (const s of mcp) {
      expect(s.fields).toContain('triggerKeywords');
      expect(s.fields).toContain('placeholderTools');
    }
  });

  it('反向用例：任一侧改一个字段名，本守护必须红（合成形状，不靠注释自称有效）', () => {
    const base = { fields: ['a', 'b', 'c'], literals: [], notes: [] };
    const renamed = { fields: ['a', 'b', 'c_renamed'], literals: [], notes: [] };
    // 1) 判定为对齐时改名 → 红，且点名两侧差异字段
    const aligned = violationsFor('X', base, { ...renamed, fields: ['a', 'b', 'cX'] }, { verdict: 'aligned' });
    expect(aligned.length).toBe(1);
    expect(aligned[0]).toContain('仅前端有');
    // 2) 前端裁剪超集：裁剪面变了必须重新登记 → 红
    expect(
      violationsFor('Y', base, { fields: ['a', 'b', 'c', 'extra'], literals: [], notes: [] }, { verdict: 'frontend-superset', frontendOnly: ['extra'] })
        .length,
    ).toBe(0);
    expect(
      violationsFor('Y', base, { fields: ['a', 'b', 'c', 'extra2'], literals: [], notes: [] }, { verdict: 'frontend-superset', frontendOnly: ['extra'] })
        .length,
    ).toBe(1);
    // 3) 后端侧多出未登记的字段 → 红（frontend-superset 不接受后端反向多字段）
    expect(
      violationsFor('Z', { fields: ['a', 'b', 'c', 'srv'], literals: [], notes: [] }, base, { verdict: 'frontend-superset', frontendOnly: [] })
        .length,
    ).toBe(1);
    // 4) 字面量联合少一档 → 红（这条不比对字段名，专门比对成员集合）
    const lit = violationsFor(
      'KnowledgeStatus',
      { fields: [], literals: ['ok', 'stale', 'unknown'], notes: [] },
      { fields: [], literals: ['ok', 'stale'], notes: [] },
      { verdict: 'aligned' },
    );
    expect(lit[0]).toContain('字面量联合成员已分叉');
    // 5) 真实形状复核：字面量联合确实在比对面内，而不是被解析成两个空集
    expect(shapeOf(apiShapes, 'api', 'KnowledgeStatus').literals).toEqual(['ok', 'stale', 'unknown']);
    expect(shapeOf(feShapes, 'frontend', 'KnowledgeStatus').literals).toEqual(['ok', 'stale', 'unknown']);
    expect(shapeOf(apiShapes, 'api', 'RefAuthority').literals).toEqual(['high', 'low', 'medium', 'unknown']);
  });
});
