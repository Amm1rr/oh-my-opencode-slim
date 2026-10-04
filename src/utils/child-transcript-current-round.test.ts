import { describe, expect, test } from 'bun:test';
import { classifyCurrentDeliveredRound } from './child-transcript';

function user(id: string, created: number, text = 'ask', agent = 'fixer') {
  return {
    info: { id, role: 'user', agent, time: { created } },
    parts: [{ type: 'text', text }],
  };
}

function assistant(
  id: string,
  created: number,
  completed: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    info: {
      id,
      role: 'assistant',
      finish: 'stop',
      time: { created, completed },
      ...extra,
    },
    parts: [
      { type: 'step-start' },
      { type: 'text', text },
      { type: 'step-finish', reason: 'stop' },
    ],
  };
}

describe('classifyCurrentDeliveredRound', () => {
  test('does not reuse an older answer after a newer user', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        user('u-old', 10),
        assistant('a-old', 11, 12, 'OLD-SECRET'),
        user('u-new', 20, 'next'),
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(round.text).toBeUndefined();
    expect(JSON.stringify(round)).not.toContain('OLD-SECRET');
  });

  test('an older pending tool does not block a later completed round', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        user('u-old', 10),
        {
          info: {
            id: 'a-old',
            role: 'assistant',
            finish: 'stop',
            time: { created: 11, completed: 12 },
          },
          parts: [{ type: 'tool', state: { status: 'running' } }],
        },
        user('u-new', 20),
        assistant('a-new', 21, 22, 'finished'),
      ],
    });
    expect(round).toMatchObject({ verdict: 'completed', text: 'finished' });
  });

  test('a pending tool in the latest round is not completed', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        user('u', 10),
        {
          info: {
            id: 'a',
            role: 'assistant',
            finish: 'tool-calls',
            time: { created: 11, completed: 12 },
          },
          parts: [{ type: 'text', text: 'partial' }],
        },
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(round.text).toBeUndefined();
  });

  test('an aborted assistant is interrupted, not completed', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        user('u', 10),
        assistant('a', 11, 12, 'partial', {
          finish: 'aborted',
          error: { name: 'Aborted', message: 'aborted' },
        }),
      ],
    });
    expect(round.verdict).toBe('interrupted');
    expect(round.text).toBeUndefined();
  });

  test('a provider error stays an error', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        user('u', 10),
        assistant('a', 11, 12, '', {
          finish: 'error',
          error: { message: 'provider exploded' },
        }),
      ],
    });
    expect(round).toMatchObject({
      verdict: 'error',
      text: expect.stringContaining('provider exploded'),
    });
  });

  test('v1 step parts do not hide a completed text turn', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        user('msg_user', 1790753027502, 'ask', 'fixer'),
        assistant('msg_turn', 1790753027516, 1790753027711, 'LAB-MARKER'),
      ],
    });
    expect(round).toMatchObject({
      verdict: 'completed',
      text: 'LAB-MARKER',
      startedAt: 1790753027502,
      completedAt: 1790753027711,
    });
  });
});

test('a reply parented to an older user does not complete the newer round', () => {
  const round = classifyCurrentDeliveredRound({
    data: [
      user('msg_old', 90),
      user('msg_new', 100, 'next'),
      assistant('msg_zreply', 100, 100, 'OLD-SECRET', { parentID: 'msg_old' }),
    ],
  });
  expect(round.verdict).toBe('incomplete');
  expect(round.text).toBeUndefined();
  expect(JSON.stringify(round)).not.toContain('OLD-SECRET');
});

test('a declared parent is unreadable when the latest user has no id', () => {
  const round = classifyCurrentDeliveredRound({
    data: [
      {
        info: { role: 'user', agent: 'fixer', time: { created: 90 } },
        parts: [{ type: 'text', text: 'ask' }],
      },
      assistant('msg_a', 100, 100, 'answer', { parentID: 'msg_missing' }),
    ],
  });
  expect(round).toEqual({
    verdict: 'unreadable',
    reason: 'assistant parent is not the latest user',
  });
});

test('a same-millisecond user and reply complete in host order without a parent link', () => {
  const round = classifyCurrentDeliveredRound({
    data: [user('msg_z', 100), assistant('msg_a', 100, 101, 'answer')],
  });
  expect(round).toMatchObject({ verdict: 'completed', text: 'answer' });
});
