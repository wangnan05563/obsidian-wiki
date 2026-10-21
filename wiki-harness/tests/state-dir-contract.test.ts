import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileStateStore,
  STATE_DIR_ENV,
  resolveStateDir,
} from '../src/state/file-state-store.js';
import { Harness } from '../src/harness.js';
import type { HarnessConfig } from '../src/types.js';

// T02811：包内治理——状态目录不再有「相对进程 CWD 的 .harness/state」隐式默认。
// 本文件的用例即因果锁：把目录解析改回旧的默认值，第 1/2/3/5 组全部变红。

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  delete process.env[STATE_DIR_ENV];
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function llmConfig(): HarnessConfig['llm'] {
  return { provider: 'deepseek', baseUrl: 'http://x', apiKey: 'k', model: 'm' };
}

const UUID = '11111111-2222-3333-4444-555555555555';

describe('resolveStateDir 目录解析契约', () => {
  it('既无实参也无环境变量 → 构造期抛错，且点名环境变量', () => {
    delete process.env[STATE_DIR_ENV];
    assert.throws(() => resolveStateDir(), (err: Error) =>
      err.message.includes(STATE_DIR_ENV) && err.message.includes('绝对'),
    );
    assert.throws(() => new FileStateStore(), /WIKI_HARNESS_STATE_DIR/);
  });

  it('相对路径一律拒收（实参与环境变量同规则）', () => {
    assert.throws(() => new FileStateStore('.harness/state'), /必须是绝对路径/);
    process.env[STATE_DIR_ENV] = 'state/relative';
    assert.throws(() => new FileStateStore(), /必须是绝对路径/);
  });

  it('环境变量通道：不传实参也能落进指定目录，save 真的写在那', async () => {
    const envDir = mkTmp('wiki-harness-env-state-');
    process.env[STATE_DIR_ENV] = envDir;
    const store = new FileStateStore();
    await store.save(UUID, { runId: UUID, step: 1, messages: [], tokenUsed: 0 } as never);
    assert.ok(fs.existsSync(path.join(envDir, `${UUID}.json`)), '状态应写进环境变量目录');
  });

  it('显式实参优先于环境变量', async () => {
    const argDir = mkTmp('wiki-harness-arg-state-');
    const envDir = mkTmp('wiki-harness-env2-state-');
    process.env[STATE_DIR_ENV] = envDir;
    const store = new FileStateStore(argDir);
    await store.save(UUID, { runId: UUID, step: 1, messages: [], tokenUsed: 0 } as never);
    assert.ok(fs.existsSync(path.join(argDir, `${UUID}.json`)));
    assert.deepEqual(fs.readdirSync(envDir), [], '环境变量目录不该被写');
  });
});

describe('Harness 未注入 stateStore 时的落点契约', () => {
  it('不注入 store 也不给目录 → 构造即失败，且不在进程 CWD 留下 .harness', () => {
    // 把 CWD 换成临时目录再验证：旧实现下 Harness 构造后一旦 run 就会在 CWD 造 .harness/state，
    // 新实现根本不给它「先写下来再说」的机会。
    const fakeCwd = mkTmp('wiki-harness-fake-cwd-');
    const realCwd = process.cwd();
    process.chdir(fakeCwd);
    try {
      assert.throws(
        () => new Harness({ llm: llmConfig(), tools: [] }),
        /WIKI_HARNESS_STATE_DIR/,
      );
      assert.equal(fs.existsSync(path.join(fakeCwd, '.harness')), false,
        'CWD 下不得出现 .harness 产物目录');
    } finally {
      process.chdir(realCwd);
    }
  });

  it('不注入 store 但给了环境变量 → 可用，且状态写进环境变量目录', async () => {
    const envDir = mkTmp('wiki-harness-harness-env-');
    process.env[STATE_DIR_ENV] = envDir;
    const harness = new Harness({ llm: llmConfig(), tools: [] });
    assert.ok(harness, '环境变量通道下构造不应抛错');
    const store = new FileStateStore();
    await store.save(UUID, { runId: UUID, step: 1, messages: [], tokenUsed: 0 } as never);
    assert.equal(fs.readdirSync(envDir).length, 1);
  });
});
