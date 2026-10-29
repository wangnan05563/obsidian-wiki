// T02931：MCP 编译/问答与朗读的活跃登记必须真的被「一键重启」守卫看见。
// 锁住的退化点：登记写在了别的对象上（例如只包 HTTP 路由），或只加计数却不参与
// restartRefusal 的 running 判定——两种都能让用例「看起来有计数」但重启照样放行。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { callTool } from '../src/mcp/tools.js';
import { registerConfigRoute, type RestartController } from '../src/routes/config.js';
import { registerTtsRoute } from '../src/routes/tts.js';
import { __resetActivitiesForTest, activeActivities, activeTtsCount } from '../src/activity.js';
import { queuedCompileCount } from '../src/compile-queue.js';
import { setCoordinationPaths } from '../src/cleanup-cross-process.js';
import { pollUntil, NO_TIMER_CHAIN } from './helpers/waitForProgress.js';
import type { IsolationGuards } from '../src/middleware/auth.js';
import type { HarnessAdapter } from '../src/engine/harness-adapter.js';
import type { AppConfig, AnswerChunk, EngineAdapter, ProgressEvent } from '../src/types.js';
import type { McpToolContext } from '../src/mcp/tools.js';
import type { RestartMode } from '../src/restart.js';

// TTS 的合成要真实等待网络，测试用一次性闸门把它挂住，才能在中途打重启接口。
// 每个用例前重置：闸门一旦被放行就是 resolved，跨用例复用会让后面的合成瞬间结束。
const ttsGate = vi.hoisted(() => {
  let release!: () => void;
  let opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    get opened(): Promise<void> {
      return opened;
    },
    release(): void {
      release();
    },
    reset(): void {
      opened = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
});

vi.mock('../src/utils/edgeTtsClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/edgeTtsClient.js')>(
    '../src/utils/edgeTtsClient.js',
  );
  return {
    ...actual,
    synthesizeEdgeTts: vi.fn(async () => {
      await ttsGate.opened;
      return Buffer.from([0xff, 0xf3, 0x00, 0x00]);
    }),
  };
});

vi.mock('../src/utils/audioPostprocess.js', () => ({
  applyAudioPostprocess: vi.fn(async (buf: Buffer) => buf),
}));

const passThrough: IsolationGuards['requireAuth'] = (_req, _reply, done) => done();
const guards: IsolationGuards = { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };

function gate(): { opened: Promise<void>; release: () => void } {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

function makeAdapter(hooks: { onCompile?: () => Promise<void>; onQuery?: () => Promise<void> }): EngineAdapter {
  const unsupported = () => {
    throw new Error('本用例不应调用该适配器方法');
  };
  return {
    async *compile(): AsyncIterable<ProgressEvent> {
      await hooks.onCompile?.();
      yield { status: 'done', message: 'ok' } as ProgressEvent;
    },
    async *query(): AsyncIterable<AnswerChunk> {
      await hooks.onQuery?.();
      yield { text: 'answer' } as AnswerChunk;
    },
    resumeCompile: unsupported,
    healthCheck: unsupported,
    healthCheckFix: unsupported,
    markKnowledgeReviewed: unsupported,
    updateConfig: unsupported,
    podcast: unsupported,
    generateVideo: unsupported,
    pollVideoTask: unsupported,
  } as unknown as EngineAdapter;
}

function makeContext(adapter: EngineAdapter): McpToolContext {
  return { vault: {} as McpToolContext['vault'], adapter, config: {} as AppConfig };
}

const RESTART = { method: 'POST' as const, url: '/api/restart', payload: { confirm: true } };

describe('T02931：MCP / 朗读进行中，一键重启必须被拒绝', () => {
  let app: FastifyInstance;
  let afterRestart: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetActivitiesForTest();
    ttsGate.reset();
    setCoordinationPaths({ markerFile: null, activityDir: null, instance: 'test' });
    afterRestart = vi.fn();
    app = Fastify({ logger: false });
    const controller: RestartController = {
      bootId: () => 'boot-test',
      afterRestart,
      perform: () => 'packaged' as RestartMode,
    };
    registerConfigRoute(app, {} as HarnessAdapter, controller, guards);
    registerTtsRoute(app);
    await app.ready();
  });

  afterEach(async () => {
    ttsGate.release();
    __resetActivitiesForTest();
    await app.close();
  });

  async function expectRefusedWith(word: string): Promise<void> {
    const res = await app.inject(RESTART);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('restart_blocked_by_active_task');
    expect(body.error).toContain(word);
    expect(afterRestart).not.toHaveBeenCalled();
  }

  async function expectAccepted(): Promise<void> {
    const res = await app.inject(RESTART);
    expect(res.statusCode).toBe(202);
    expect(res.json().bootId).toBe('boot-test');
  }

  it('MCP vault_compile 进行中 → 409 点名编译；结束后放行', async () => {
    const hold = gate();
    const adapter = makeAdapter({ onCompile: () => hold.opened });
    const pending = callTool('vault_compile', { content: '# 标题\n正文' }, makeContext(adapter));

    await pollUntil('MCP 编译登记为活跃', () => activeActivities().compile, (n) => n === 1, {
      ...NO_TIMER_CHAIN,
      progress: () => `compile=${activeActivities().compile}`,
    });
    await expectRefusedWith('编译');

    hold.release();
    const result = await pending;
    expect(result.isError).toBe(false);

    // 计数与排队数都归零后才算真结束（排队数在链尾扣减，可能晚一个微任务）
    await pollUntil(
      'MCP 编译结束且队列清空',
      () => ({ active: activeActivities().compile, queued: queuedCompileCount() }),
      (v) => v.active === 0 && v.queued === 0,
      { ...NO_TIMER_CHAIN, progress: () => `active=${activeActivities().compile} queued=${queuedCompileCount()}` },
    );
    await expectAccepted();
  });

  it('MCP llm_query 进行中 → 409 点名问答；结束后放行', async () => {
    const hold = gate();
    const adapter = makeAdapter({ onQuery: () => hold.opened });
    const pending = callTool('llm_query', { question: '什么是知识库' }, makeContext(adapter));

    await pollUntil('MCP 问答登记为活跃', () => activeActivities().query, (n) => n === 1, {
      ...NO_TIMER_CHAIN,
      progress: () => `query=${activeActivities().query}`,
    });
    await expectRefusedWith('问答');

    hold.release();
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('answer');

    await pollUntil('MCP 问答释放活跃', () => activeActivities().query, (n) => n === 0, {
      ...NO_TIMER_CHAIN,
      progress: () => `query=${activeActivities().query}`,
    });
    await expectAccepted();
  });

  it('朗读合成进行中 → 409 点名朗读；音频返回后放行', async () => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      payload: { text: '这是一段用于测试的朗读文本' },
    });

    await pollUntil('朗读登记为活跃', activeTtsCount, (n) => n === 1, {
      ...NO_TIMER_CHAIN,
      progress: () => `tts=${activeTtsCount()}`,
    });
    await expectRefusedWith('朗读');

    ttsGate.release();
    const audio = await pending;
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/mpeg');

    await pollUntil('朗读释放活跃', activeTtsCount, (n) => n === 0, {
      ...NO_TIMER_CHAIN,
      progress: () => `tts=${activeTtsCount()}`,
    });
    await expectAccepted();
  });
});
