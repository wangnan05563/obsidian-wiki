import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, classifyError } from '../src/retry/retry-policy.js';
import type { RetryConfig } from '../src/types.js';

const fastRetry: RetryConfig = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, retryOn: ['timeout', 'rate_limit'] };

describe('classifyError', () => {
  it('should classify timeout errors', () => {
    assert.equal(classifyError(new Error('request timeout')), 'timeout');
  });

  it('should classify rate_limit errors', () => {
    assert.equal(classifyError(new Error('429 rate limit exceeded')), 'rate_limit');
  });

  it('should classify unknown errors', () => {
    assert.equal(classifyError(new Error('something else')), 'unknown');
  });
});

describe('withRetry', () => {
  it('should return result on first success', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'success';
    }, fastRetry);
    assert.equal(result, 'success');
    assert.equal(calls, 1);
  });

  it('should retry on timeout and eventually succeed', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error('timeout');
      return 'success';
    }, fastRetry);
    assert.equal(result, 'success');
    assert.equal(calls, 2);
  });

  it('should not retry on non-retryable errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('validation error');
      }, fastRetry),
      /validation error/,
    );
    assert.equal(calls, 1);
  });

  it('should exhaust retries and throw', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('timeout');
      }, fastRetry),
      /timeout/,
    );
    assert.equal(calls, 4); // 1 initial + 3 retries
  });

  it('should not retry when retryOn is empty', async () => {
    let calls = 0;
    const noRetry: RetryConfig = { ...fastRetry, retryOn: [] };
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('timeout');
      }, noRetry),
    );
    assert.equal(calls, 1);
  });
});
