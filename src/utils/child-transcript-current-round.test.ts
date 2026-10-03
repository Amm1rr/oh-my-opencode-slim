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
  test('uses host timestamps when the array is not ascending', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        assistant('a-new', 30, 31, 'new-answer'),
        user('u-new', 29),
        assistant('a-old', 11, 12, 'OLD-SECRET'),
        user('u-old', 10, 'old ask'),
      ],
    });
    expect(round).toMatchObject({
      verdict: 'completed',
      text: 'new-answer',
      startedAt: 29,
      completedAt: 31,
    });
  });

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

  test('refuses when a message has no ordering timestamp', () => {
    const round = classifyCurrentDeliveredRound({
      data: [
        { info: { id: 'u', role: 'user', agent: 'fixer' }, parts: [] },
        assistant('a', 11, 12, 'answer'),
      ],
    });
    expect(round).toEqual({
      verdict: 'unreadable',
      reason: 'transcript order is not verifiable',
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

test('same-millisecond newest-first still completes via parentID and message id', () => {
  const created = 1790753027502;
  const round = classifyCurrentDeliveredRound({
    data: [
      {
        info: {
          id: 'msg_0f132b5bc001bSYsEdkTk2EPqW',
          role: 'assistant',
          parentID: 'msg_0f132b5ad001p3xUUtDS40Dg4Z',
          finish: 'stop',
          time: { created, completed: created },
        },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'LAB-MARKER' },
          { type: 'step-finish', reason: 'stop' },
        ],
      },
      {
        info: {
          id: 'msg_0f132b5ad001p3xUUtDS40Dg4Z',
          role: 'user',
          agent: 'fixer',
          time: { created },
        },
        parts: [{ type: 'text', text: 'ask' }],
      },
    ],
  });
  expect(round).toMatchObject({ verdict: 'completed', text: 'LAB-MARKER' });
});

test('an older pending tool does not block a later same-millisecond round', () => {
  const round = classifyCurrentDeliveredRound({
    data: [
      {
        info: {
          id: 'msg_v_new',
          role: 'assistant',
          parentID: 'msg_u_new',
          finish: 'stop',
          time: { created: 20, completed: 20 },
        },
        parts: [{ type: 'text', text: 'finished' }],
      },
      user('msg_u_new', 20, 'next'),
      {
        info: {
          id: 'msg_v_old',
          role: 'assistant',
          parentID: 'msg_u_old',
          finish: 'stop',
          time: { created: 10, completed: 10 },
        },
        parts: [{ type: 'tool', state: { status: 'running' } }],
      },
      user('msg_u_old', 10),
    ],
  });
  expect(round).toMatchObject({ verdict: 'completed', text: 'finished' });
});

test('equal timestamps without an id or parent link are unreadable', () => {
  const round = classifyCurrentDeliveredRound({
    data: [
      {
        info: {
          role: 'assistant',
          finish: 'stop',
          time: { created: 10, completed: 10 },
        },
        parts: [{ type: 'text', text: 'maybe' }],
      },
      {
        info: { role: 'user', agent: 'fixer', time: { created: 10 } },
        parts: [{ type: 'text', text: 'ask' }],
      },
    ],
  });
  expect(round).toEqual({
    verdict: 'unreadable',
    reason: 'transcript order is not verifiable',
  });
});

test('an equal-time parent link completes when the user id sorts after the reply', () => {
  const messages = [
    user('msg_z', 100),
    assistant('msg_a', 100, 100, 'answer', { parentID: 'msg_z' }),
  ];
  for (const data of [messages, [...messages].reverse()]) {
    expect(classifyCurrentDeliveredRound({ data })).toMatchObject({
      verdict: 'completed',
      text: 'answer',
    });
  }
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

test('an assistant that is actually earlier than its parent is unreadable', () => {
  const round = classifyCurrentDeliveredRound({
    data: [
      assistant('msg_a', 90, 90, 'early', { parentID: 'msg_z' }),
      user('msg_z', 100),
    ],
  });
  expect(round).toEqual({
    verdict: 'unreadable',
    reason: 'transcript order is not verifiable',
  });
});

test('duplicate message ids stay unreadable', () => {
  const round = classifyCurrentDeliveredRound({
    data: [user('msg_z', 100), assistant('msg_z', 101, 101, 'answer')],
  });
  expect(round.verdict).toBe('unreadable');
});

test('a third message in an equal-time bucket is not ordered by a reversed parent id', () => {
  const round = classifyCurrentDeliveredRound({
    data: [
      user('msg_z', 100),
      assistant('msg_a', 100, 100, 'answer', { parentID: 'msg_z' }),
      {
        info: { id: 'msg_m', role: 'system', time: { created: 100 } },
        parts: [],
      },
    ],
  });
  expect(round.verdict).toBe('unreadable');
});

test('a valid equal-time link keeps an error or interruption terminal', () => {
  const errored = classifyCurrentDeliveredRound({
    data: [
      assistant('msg_a', 100, 100, '', {
        parentID: 'msg_z',
        finish: 'error',
        error: { message: 'provider exploded' },
      }),
      user('msg_z', 100),
    ],
  });
  expect(errored.verdict).toBe('error');
  const interrupted = classifyCurrentDeliveredRound({
    data: [
      user('msg_z', 100),
      assistant('msg_a', 100, 100, 'partial', {
        parentID: 'msg_z',
        finish: 'aborted',
        error: { name: 'Aborted', message: 'aborted' },
      }),
    ],
  });
  expect(interrupted.verdict).toBe('interrupted');
});
