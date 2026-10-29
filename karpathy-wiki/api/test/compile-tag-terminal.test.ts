// T03613 / T03615（由 T03610 的根因 C、E 派生）后端行为验证。
//
// T03613：generate_tags 阶段既无聚合终态、done 又早于 tag 阶段推送
//   → 时间线留下一条永不收口的「运行中」，与「编译完成」并存。
//   本文件验证事件序列：tag 阶段以聚合终态收口，done 是整条流的最后一个事件。
// T03615：afterStep 对每次 write_file 无条件 push 页面路径，同页覆写会被 tag 阶段处理两次，
//   且第二次建议整段覆盖第一次 → 验证去重 + ai_tags 合并。
//
// LLM 传输层是原生 fetch（wiki-harness/src/llm/openai-compatible.ts），
// 这里整体 stub：带 tools 的请求判为 harness 主循环，不带的判为 tag 建议单轮调用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { FileStateStore, type HarnessConfig, type RunState } from '@wiki/harness';

import { VaultService } from '../src/vault/vault-service.js';
import { compileWorkflow, resumeCompileWorkflow } from '../src/workflows/compile-workflow.js';
import { suggestTagsForPage } from '../src/workflows/tag-suggest-workflow.js';
import type { AppConfig, ProgressEvent } from '../src/types.js';

// 页面内容带各自标题，只为断言可读。
// 曾经这里是一条隐性依赖：gray-matter 以「整段内容字符串」为键做进程内缓存，且 matter(str).data
// 就是缓存对象本体，tag 阶段就地改写 parsed.data 会把字段写回缓存——用例间复用同一段内容时，
// 前一个用例产生的 ai_tags 会凭空出现在后一个用例的文件里（当时表现为「单跑通过、整文件失败」）。
// T03647 已把写入口改为 parsePage/stringifyPage（副本脱钩），该规避不再是必需的；
// 跨页串字段的行为由 api/test/frontmatter-cache-isolation.test.ts 直接断言并守住。
function pageMarkdown(title: string): string {
  return ['---', `title: ${title}`, 'type: concept', '---', '', `正文见 [[${title}]]。`].join('\n');
}

function chatResponse(content: string, toolCalls?: unknown[]) {
  return {
    choices: [
      {
        message: {
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// tag 建议走 OpenAI 兼容的单轮调用：结果在 choices[0].message.content 里，是 JSON 字符串
function tagResponse(tags: string[]) {
  return chatResponse(JSON.stringify({ ai_tags: tags }));
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('T03613 编译事件序：tag 阶段收口在 done 之前', () => {
  let tmpDir = '';
  let vault: VaultService;
  let harnessConfig: HarnessConfig;
  let appConfig: AppConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 't03613-'));
    vault = new VaultService(path.join(tmpDir, 'vault'));
    await vault.init();
    const llm = { provider: 'glm', baseUrl: 'http://localhost:9/v1', apiKey: 'test-key', model: 'test-model' };
    harnessConfig = {
      llm,
      tools: [],
      stateStore: new FileStateStore(path.join(tmpDir, 'state')),
    };
    appConfig = { llm } as unknown as AppConfig;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function collect(iter: AsyncIterable<ProgressEvent>): Promise<ProgressEvent[]> {
    const out: ProgressEvent[] = [];
    for await (const ev of iter) out.push(ev);
    return out;
  }

  it('done 是最后一个事件，且 tag 阶段带聚合终态', async () => {
    let harnessTurn = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { tools?: unknown };
        if (body.tools) {
          harnessTurn += 1;
          if (harnessTurn === 1) {
            return jsonResponse(
              chatResponse('', [toolCall('c1', 'write_file', { path: 'concepts/a.md', content: pageMarkdown('结算页A') })]),
            );
          }
          if (harnessTurn === 2) {
            return jsonResponse(
              chatResponse('', [toolCall('c2', 'append_index', { pageName: '结算页A', summary: 's' })]),
            );
          }
          return jsonResponse(chatResponse('编译完毕'));
        }
        return jsonResponse(tagResponse(['票据', '测试']));
      }),
    );

    const events = await collect(
      compileWorkflow(harnessConfig, vault, { type: 'text', content: '原始内容-唯一-A' }, appConfig),
    );

    const doneEvents = events.filter((e) => e.step === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].status).toBe('done');
    // 收口顺序：done 必须排在最后一个 generate_tags 事件之后
    const lastTagIndex = events.map((e) => e.step).lastIndexOf('generate_tags');
    expect(lastTagIndex).toBeGreaterThan(-1);
    expect(events.indexOf(doneEvents[0])).toBe(events.length - 1);
    expect(events.indexOf(doneEvents[0])).toBeGreaterThan(lastTagIndex);

    // 聚合终态存在：阶段以 done + 「M/N 个页面」收口，而不是停在 running
    const tagEvents = events.filter((e) => e.step === 'generate_tags');
    expect(tagEvents[0].status).toBe('running');
    const aggregate = tagEvents[tagEvents.length - 1];
    expect(aggregate.status).toBe('done');
    expect(aggregate.message).toContain('AI tag 建议已生成 1/1 个页面');
    expect(tagEvents.some((e) => e.status === 'running' && e === aggregate)).toBe(false);
  });

  it('编译失败时不追加 tag 阶段，终态仍收口为 error', async () => {
    let turn = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { tools?: unknown };
        if (!body.tools) return jsonResponse(tagResponse(['x']));
        turn += 1;
        if (turn === 1) {
          return jsonResponse(
            chatResponse('', [toolCall('c1', 'write_file', { path: 'concepts/fail2.md', content: pageMarkdown('失败页B') })]),
          );
        }
        throw new Error('LLM API error 500: upstream unavailable');
      }),
    );

    const events = await collect(
      compileWorkflow(harnessConfig, vault, { type: 'text', content: '原始内容-唯一-B' }, appConfig),
    );

    const done = events[events.length - 1];
    expect(done.step).toBe('done');
    expect(done.status).toBe('error');
    // 编译本身失败 → 不再为半成品页面消耗 tag 调用
    expect(events.some((e) => e.step === 'generate_tags')).toBe(false);
  });

  it('回归：resume 路径同样收到终态 done（终态改返回值后需显式补发）', async () => {
    const stateStore = harnessConfig.stateStore!;
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const state: RunState = {
      runId,
      task: '恢复测试',
      events: [{ type: 'user', content: '恢复测试', ts: new Date().toISOString() }],
      step: 2,
      tokenUsed: 100,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await stateStore.save(runId, state);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(chatResponse('恢复完成'))),
    );

    const events = await collect(resumeCompileWorkflow(harnessConfig, vault, runId));
    const last = events[events.length - 1];
    expect(last.step).toBe('done');
    expect(last.status).toBe('done');
    expect(events.filter((e) => e.step === 'done')).toHaveLength(1);
  });
});

describe('T03615 同页覆写只跑一次 tag 建议，且 ai_tags 合并', () => {
  let tmpDir = '';
  let vault: VaultService;
  let harnessConfig: HarnessConfig;
  let appConfig: AppConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 't03615-'));
    vault = new VaultService(path.join(tmpDir, 'vault'));
    await vault.init();
    const llm = { provider: 'glm', baseUrl: 'http://localhost:9/v1', apiKey: 'test-key', model: 'test-model' };
    harnessConfig = { llm, tools: [], stateStore: new FileStateStore(path.join(tmpDir, 'state')) };
    appConfig = { llm } as unknown as AppConfig;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('同一路径 write_file 两次：tag 阶段只调用一次，时间线无重复行', async () => {
    let harnessTurn = 0;
    let tagCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { tools?: unknown };
        if (body.tools) {
          harnessTurn += 1;
          if (harnessTurn === 1) {
            return jsonResponse(
              chatResponse('', [
                toolCall('c1', 'write_file', { path: 'concepts/dup.md', content: pageMarkdown('覆写页C') }),
                // LLM 覆写同页（修订标题）：去重前这里会让 tag 阶段多跑一次并覆盖第一次建议
                toolCall('c2', 'write_file', { path: 'concepts/dup.md', content: pageMarkdown('覆写页C（修订）') }),
              ]),
            );
          }
          return jsonResponse(chatResponse('编译完毕'));
        }
        tagCalls += 1;
        return jsonResponse(tagResponse(['票据']));
      }),
    );

    const events: ProgressEvent[] = [];
    for await (const ev of compileWorkflow(
      harnessConfig,
      vault,
      { type: 'text', content: '原始内容-唯一-C' },
      appConfig,
    )) {
      events.push(ev);
    }

    expect(tagCalls).toBe(1);
    const aggregate = events.filter((e) => e.step === 'generate_tags').at(-1);
    expect(aggregate?.message).toContain('1/1 个页面');
    // 逐页明细不出现同路径重复行
    const pageRows = events.filter((e) => e.step === 'generate_tags' && e.data?.path === 'concepts/dup.md');
    expect(pageRows).toHaveLength(1);
  });

  it('重复建议合并去重，不整段覆盖历史 ai_tags', async () => {
    await vault.writeFile('concepts/merge.md', pageMarkdown('合并页D'));
    const turns: string[][] = [['票据'], ['清算', '票据']];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => {
        const tags = turns[Math.min(call, turns.length - 1)] ?? [];
        call += 1;
        return jsonResponse(tagResponse(tags));
      }),
    );

    const first = await suggestTagsForPage(vault, 'concepts/merge.md', appConfig);
    expect(first).toEqual(['票据']);
    const second = await suggestTagsForPage(vault, 'concepts/merge.md', appConfig);
    expect(second).toEqual(['票据', '清算']);

    const raw = await vault.readFile('concepts/merge.md');
    const data = matter(raw).data as { ai_tags?: string[]; title?: string };
    expect(data.ai_tags).toEqual(['票据', '清算']);
    // 「仅建议不覆盖」：原有字段不受影响
    expect(data.title).toBe('合并页D');
  });

  it('已确认的 tags 字段不受 tag 建议影响', async () => {
    const withTags = ['---', 'title: 测试页A', 'type: concept', 'tags:', '  - 已确认', '---', '', '正文'].join('\n');
    await vault.writeFile('concepts/keep.md', withTags);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(tagResponse(['新建议']))));

    await suggestTagsForPage(vault, 'concepts/keep.md', appConfig);

    const data = matter(await vault.readFile('concepts/keep.md')).data as {
      tags?: string[];
      ai_tags?: string[];
    };
    expect(data.tags).toEqual(['已确认']);
    expect(data.ai_tags).toEqual(['新建议']);
  });
});
