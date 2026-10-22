// 受控重启通道前端单测（T02622 / PRD §10 C1，A 方案）
// 锁住三条容易退化的口径：
//   1) 只有 202 + bootId 才算「已接受」，缺 bootId 必须报错而不是乐观成功；
//   2) 409 的结构化 active 要原样透出（不把「有任务在跑」简化成一句抱歉）；
//   3) 成功只认 /health 的 bootId 变化，超时必须返回 timeout，由界面如实说「没重启」。
import { describe, it, expect, vi } from 'vitest';
import {
  RESTART_URL,
  blockedSummary,
  requestRestart,
  waitForBootChange,
  type Send,
} from '../src/utils/restartService';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('requestRestart：把服务端三种回答翻成界面动作', () => {
  it('202 → accepted，带上 mode/bootId，并显式发送 confirm:true', async () => {
    const send = vi.fn(async () =>
      jsonResponse(202, {
        ok: true,
        mode: 'packaged',
        bootId: 'boot-old',
        delayMs: 300,
        note: '新实例正在拉起',
      }),
    ) as unknown as Send;

    const result = await requestRestart(send);

    expect(result).toEqual({
      kind: 'accepted',
      mode: 'packaged',
      bootId: 'boot-old',
      delayMs: 300,
      note: '新实例正在拉起',
    });
    const [url, init] = (send as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(RESTART_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ confirm: true });
  });

  it('409 → blocked，编译/问答计数与拒绝原因一个不丢', async () => {
    const send = vi.fn(async () =>
      jsonResponse(409, {
        code: 'restart_blocked_by_active_task',
        error: '有 1 个编译任务正在进行，已拒绝重启',
        active: { compile: 1, query: 2, blockedReasons: ['1 个编译任务'] },
      }),
    ) as unknown as Send;

    const result = await requestRestart(send);

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.message).toContain('1 个编译任务');
    expect(result.active).toEqual({ compile: 1, query: 2, blockedReasons: ['1 个编译任务'] });
    expect(blockedSummary(result.active)).toBe('1 个编译任务、2 个问答');
  });

  it('400 → error：确认缺失等参数问题走错误态，而不是当成已接受', async () => {
    const send = vi.fn(async () =>
      jsonResponse(400, { code: 'restart_confirm_required', error: '重启会中断所有连接：请在确认后调用（confirm: true）' }),
    ) as unknown as Send;

    const result = await requestRestart(send);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toContain('confirm: true');
  });

  it('202 但没有 bootId → error：没有比对基准就不能宣称重启成功', async () => {
    const send = vi.fn(async () => jsonResponse(202, { ok: true, mode: 'dev-watch' })) as unknown as Send;

    const result = await requestRestart(send);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toContain('bootId');
  });

  it('网络失败 → error，文案里保留底层原因', async () => {
    const send = vi.fn(async () => {
      throw new Error('Failed to fetch');
    }) as unknown as Send;

    const result = await requestRestart(send);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toContain('Failed to fetch');
  });
});

describe('waitForBootChange：只认 bootId 变化', () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it('重启窗口内的连接失败不影响判定，换进程后返回 changed', async () => {
    const answers = [
      () => Promise.reject(new Error('ECONNREFUSED')),
      async () => jsonResponse(200, { ok: true, bootId: 'boot-old' }),
      async () => jsonResponse(200, { ok: true, bootId: 'boot-new' }),
    ];
    let i = 0;
    const send = vi.fn(() => answers[Math.min(i++, answers.length - 1)]()) as unknown as Send;
    const { now, sleep } = clock();

    const result = await waitForBootChange('boot-old', send, { timeoutMs: 10_000, intervalMs: 1_000, now, sleep });

    expect(result).toEqual({ kind: 'changed', bootId: 'boot-new' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('bootId 一直没变 → timeout，并带上最后看到的 bootId', async () => {
    const send = vi.fn(async () => jsonResponse(200, { ok: true, bootId: 'boot-old' })) as unknown as Send;
    const { now, sleep } = clock();

    const result = await waitForBootChange('boot-old', send, { timeoutMs: 3_000, intervalMs: 1_000, now, sleep });

    expect(result).toEqual({ kind: 'timeout', lastSeen: 'boot-old' });
    // 0/1/2/3 秒各探一次：3 秒超时不是「只探 3 次」，而是探到 deadline 为止
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('全程连不上 → timeout 且 lastSeen 为 null（界面据此说「没检测到重启」）', async () => {
    const send = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as Send;
    const { now, sleep } = clock();

    const result = await waitForBootChange('boot-old', send, { timeoutMs: 2_000, intervalMs: 1_000, now, sleep });

    expect(result).toEqual({ kind: 'timeout', lastSeen: null });
  });
});

describe('blockedSummary：零计数不出现「0 个编译」', () => {
  it('只有问答在跑时只报问答', () => {
    expect(blockedSummary({ compile: 0, query: 1, blockedReasons: [] })).toBe('1 个问答');
  });

  it('完全没有计数时给保守措辞而不是空串', () => {
    expect(blockedSummary({ compile: 0, query: 0, blockedReasons: [] })).toBe('未知任务');
  });
});
