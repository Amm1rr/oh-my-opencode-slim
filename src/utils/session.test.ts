import { describe, expect, mock, test } from 'bun:test';
import {
  abortSessionWithTimeout,
  OperationTimeoutError,
  sessionAbortFailure,
  withTimeout,
} from './session';

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('session utilities', () => {
  test('withTimeout resolves without waiting for the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 50, 'too slow');

    expect(result).toBe('ok');
  });

  test('withTimeout rejects with OperationTimeoutError when operation hangs', async () => {
    await expect(withTimeout(never(), 5, 'too slow')).rejects.toThrow(
      OperationTimeoutError,
    );
  });

  test('abortSessionWithTimeout rejects if abort hangs', async () => {
    const client = {
      session: {
        abort: mock(() => never()),
      },
    } as any;

    await expect(abortSessionWithTimeout(client, 's1', 5)).rejects.toThrow(
      'Session abort timed out after 5ms',
    );
  });

  test('abortSessionWithTimeout rejects resolved error envelopes', async () => {
    const client = {
      session: {
        abort: mock(() => Promise.resolve({ error: 'session busy' })),
      },
    } as any;

    await expect(abortSessionWithTimeout(client, 's1')).rejects.toThrow(
      'session abort rejected: session busy',
    );
  });

  test('sessionAbortFailure reads both SDK envelopes', () => {
    expect(sessionAbortFailure({ error: 'boom' })).toBe(
      'session abort rejected: boom',
    );
    expect(sessionAbortFailure({ error: { message: 'nope' } })).toBe(
      'session abort rejected: {"message":"nope"}',
    );
    expect(sessionAbortFailure(false)).toBe('session abort returned false');
    expect(sessionAbortFailure(undefined)).toBeNull();
    expect(sessionAbortFailure({ data: { ok: true } })).toBeNull();
    expect(sessionAbortFailure(null)).toBeNull();
  });
});
