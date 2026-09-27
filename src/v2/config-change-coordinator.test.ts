import { beforeEach, describe, expect, test } from 'bun:test';
import {
  notifyConfigChanged,
  registerConfigChangeListener,
  resetConfigChangeListeners,
} from './config-change-coordinator';

describe('config-change coordinator', () => {
  beforeEach(resetConfigChangeListeners);

  test('notifies listeners and reports success', async () => {
    let calls = 0;
    const unregister = registerConfigChangeListener('/tmp/project', () => {
      calls += 1;
      return { ok: true };
    });

    const result = await notifyConfigChanged('/tmp/project', 'preset-manager');

    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true });
    unregister();
  });

  test('reports a failing listener with its reason and still runs the rest', async () => {
    let secondRan = false;
    registerConfigChangeListener('/tmp/project', () => {
      throw new Error('config state unreadable');
    });
    registerConfigChangeListener('/tmp/project', () => {
      secondRan = true;
      return undefined;
    });

    const result = await notifyConfigChanged('/tmp/project', '/preset');

    expect(secondRan).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('config state unreadable');
    }
  });

  test('reports a listener-returned failure', async () => {
    registerConfigChangeListener('/tmp/project', () => ({
      ok: false,
      reason: 'profile refresh failed',
    }));

    const result = await notifyConfigChanged('/tmp/project', '/preset');

    expect(result).toEqual({ ok: false, reason: 'profile refresh failed' });
  });

  test('bounds a hanging listener and reports the timeout', async () => {
    registerConfigChangeListener(
      '/tmp/project',
      () => new Promise(() => undefined),
    );

    const result = await notifyConfigChanged('/tmp/project', '/preset', {
      timeoutMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      reason: '/preset: live refresh listener timed out',
    });
  });

  test('reports no-listener honestly instead of claiming a refresh', async () => {
    const result = await notifyConfigChanged('/tmp/project', '/preset');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('no live config-change listener');
    }
  });

  test('unregister is idempotent and isolates by directory', async () => {
    let calls = 0;
    const unregister = registerConfigChangeListener('/tmp/a', () => {
      calls += 1;
    });

    await notifyConfigChanged('/tmp/b', 'x');
    expect(calls).toBe(0);

    await notifyConfigChanged('/tmp/a', 'x');
    expect(calls).toBe(1);

    unregister();
    unregister();
    await notifyConfigChanged('/tmp/a', 'x');
    expect(calls).toBe(1);
  });

  test('trailing separators normalize to the same directory key', async () => {
    let calls = 0;
    registerConfigChangeListener('/tmp/project/', () => {
      calls += 1;
    });

    const result = await notifyConfigChanged('/tmp/project', 'x');

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });
});
