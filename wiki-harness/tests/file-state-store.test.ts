import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileStateStore } from '../src/state/file-state-store.js';
import type { RunState } from '../src/types.js';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('FileStateStore', () => {
  it('should save and load state round-trip', async () => {
    const store = new FileStateStore(tmpDir);
    const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const state: RunState = {
      runId,
      task: 'test task',
      messages: [{ role: 'user', content: 'hello' }],
      step: 5,
      tokenUsed: 1000,
      status: 'done',
      startedAt: '2026-01-01T00:00:00.000Z',
    };

    await store.save(runId, state);
    const loaded = await store.load(runId);

    assert.ok(loaded);
    assert.equal(loaded!.runId, runId);
    assert.equal(loaded!.task, 'test task');
    assert.equal(loaded!.step, 5);
    assert.equal(loaded!.tokenUsed, 1000);
    assert.equal(loaded!.status, 'done');
    assert.deepEqual(loaded!.messages, [{ role: 'user', content: 'hello' }]);
  });

  it('should return null for non-existent runId', async () => {
    const store = new FileStateStore(tmpDir);
    const loaded = await store.load('00000000-0000-0000-0000-000000000000');
    assert.equal(loaded, null);
  });

  it('should reject invalid runId format (path traversal protection)', async () => {
    const store = new FileStateStore(tmpDir);

    await assert.rejects(
      store.save('../../../etc/passwd', {} as RunState),
      /Invalid runId format/,
    );
    await assert.rejects(
      store.load('../../../etc/passwd'),
      /Invalid runId format/,
    );
  });

  it('should list saved run IDs', async () => {
    const store = new FileStateStore(tmpDir);
    const runId1 = '11111111-1111-1111-1111-111111111111';
    const runId2 = '22222222-2222-2222-2222-222222222222';

    await store.save(runId1, { runId: runId1, task: '', messages: [], step: 0, tokenUsed: 0, status: 'done', startedAt: '' });
    await store.save(runId2, { runId: runId2, task: '', messages: [], step: 0, tokenUsed: 0, status: 'done', startedAt: '' });

    const list = await store.list();
    assert.ok(list.includes(runId1));
    assert.ok(list.includes(runId2));
  });
});
