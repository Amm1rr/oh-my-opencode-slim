import { describe, expect, mock, test } from 'bun:test';
import type { BackgroundJobEvictedSession } from './background-job-board';
import { pruneEvictedHostSession } from './evicted-session-prune';

const evicted = (
  overrides: Partial<BackgroundJobEvictedSession> = {},
): BackgroundJobEvictedSession => ({
  taskID: 'ses_child',
  parentSessionID: 'parent-1',
  agent: 'oracle',
  description: 'child',
  state: 'reconciled',
  background: true,
  provisional: false,
  pluginLaunched: true,
  externalOrigin: false,
  alias: 'ses_child',
  lastUsedAt: 1,
  ...overrides,
});

const hostSession = (data: unknown) => ({
  get: mock(async () => ({ data })),
  delete: mock(async () => ({})),
});

const run = (
  session: Parameters<typeof pruneEvictedHostSession>[0]['session'],
  entry = evicted(),
  readTimeoutMs = 1_000,
) =>
  pruneEvictedHostSession({
    session,
    directory: '/project',
    evicted: entry,
    readTimeoutMs,
  });

describe('pruneEvictedHostSession', () => {
  test('deletes a verified background child this plugin launched', async () => {
    const session = hostSession({ id: 'ses_child', parentID: 'parent-1' });
    expect(await run(session)).toBe('deleted');
    expect(session.get.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'ses_child' },
      query: { directory: '/project' },
    });
    expect(session.delete).toHaveBeenCalledTimes(1);
    expect(session.delete.mock.calls[0]?.[0]).toEqual({
      path: { id: 'ses_child' },
      query: { directory: '/project' },
    });
  });

  for (const [name, overrides] of [
    ['foreground', { background: false }],
    ['provisional', { provisional: true }],
    ['restored or adopted', { externalOrigin: true, pluginLaunched: false }],
    ['not plugin launched', { pluginLaunched: false }],
  ] as const) {
    test(`never reads or deletes a ${name} record`, async () => {
      const session = hostSession({ id: 'ses_child', parentID: 'parent-1' });
      expect(await run(session, evicted(overrides))).toBe('ineligible');
      expect(session.get).not.toHaveBeenCalled();
      expect(session.delete).not.toHaveBeenCalled();
    });
  }

  test('skips when the host parentID does not match the record parent', async () => {
    const session = hostSession({ id: 'ses_child', parentID: 'parent-2' });
    expect(await run(session)).toBe('parent-mismatch');
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('skips when the host session has no parentID', async () => {
    const session = hostSession({ id: 'ses_child' });
    expect(await run(session)).toBe('read-failed');
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('skips when the host returns a different session id', async () => {
    const session = hostSession({ id: 'ses_other', parentID: 'parent-1' });
    expect(await run(session)).toBe('read-failed');
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('skips when the read rejects, reports an error, or is missing', async () => {
    const rejecting = {
      get: mock(async () => {
        throw new Error('boom');
      }),
      delete: mock(async () => ({})),
    };
    expect(await run(rejecting)).toBe('read-failed');
    expect(rejecting.delete).not.toHaveBeenCalled();

    const erroring = {
      get: mock(async () => ({ error: { name: 'NotFound' } })),
      delete: mock(async () => ({})),
    };
    expect(await run(erroring)).toBe('read-failed');
    expect(erroring.delete).not.toHaveBeenCalled();

    const getless = { delete: mock(async () => ({})) };
    expect(await run(getless)).toBe('read-failed');
    expect(getless.delete).not.toHaveBeenCalled();
  });

  test('skips when the read times out and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const session = {
      get: mock(
        (request: { signal?: AbortSignal }) =>
          new Promise<unknown>(() => {
            signal = request.signal;
          }),
      ),
      delete: mock(async () => ({})),
    };
    expect(await run(session, evicted(), 5)).toBe('read-failed');
    expect(signal?.aborted).toBe(true);
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('a rejected delete resolves to delete-failed', async () => {
    const session = {
      get: mock(async () => ({
        data: { id: 'ses_child', parentID: 'parent-1' },
      })),
      delete: mock(async () => {
        throw new Error('gone');
      }),
    };
    expect(await run(session)).toBe('delete-failed');
  });
});
