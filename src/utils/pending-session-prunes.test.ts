import { describe, expect, test } from 'bun:test';
import {
  pendingSessionPrune,
  registerPendingSessionPrune,
} from './pending-session-prunes';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pending session prunes', () => {
  test('register → visible → settles → gone', async () => {
    let resolvePrune: (() => void) | undefined;
    registerPendingSessionPrune(
      'ses_gc',
      new Promise((resolve) => {
        resolvePrune = resolve;
      }),
    );
    expect(pendingSessionPrune('ses_gc')).toBeInstanceOf(Promise);
    resolvePrune?.();
    await settle();
    expect(pendingSessionPrune('ses_gc')).toBeUndefined();
  });

  test('a rejecting prune settles silently; the registry never rejects', async () => {
    registerPendingSessionPrune('ses_boom', Promise.reject(new Error('boom')));
    await settle();
    expect(pendingSessionPrune('ses_boom')).toBeUndefined();
  });
});
