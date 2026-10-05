import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { createCancelTaskTool } from '../../tools/cancel-task';
import { createTaskResultTool } from '../../tools/task-result';
import { createTaskReviveTool } from '../../tools/task-revive';
import { createTaskStatusTool } from '../../tools/task-status';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { BackgroundJobBoard as FixtureBoard } from '../../utils/background-job-fixture';
import { getSuppressionTombstone } from '../../utils/background-job-persistence';
import {
  getBackgroundJobLifecycleLedger,
  recordBackgroundJobSuppression,
} from '../../utils/background-job-store';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import * as opencodeClient from '../../utils/opencode-client';
import { createRevivedRunTracker } from './revived-run-tracker';
import {
  appendChildRefSuffix,
  createAliasAuthority,
  createSessionRecovery,
  readAuthoritativeChildRef,
} from './session-recovery';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const context = { sessionID: PARENT, agent: 'orchestrator' };

function childMessages(text = 'LAB-MARKER') {
  return [
    {
      info: {
        id: 'msg_user',
        role: 'user',
        agent: 'fixer',
        time: { created: 1790753027502 },
      },
      parts: [{ type: 'text', text: 'ask' }],
    },
    {
      info: {
        id: 'msg_turn',
        role: 'assistant',
        finish: 'stop',
        time: { created: 1790753027516, completed: 1790753027711 },
      },
      parts: [
        { type: 'step-start' },
        { type: 'text', text },
        { type: 'step-finish', reason: 'stop' },
      ],
    },
  ];
}

function taskOutput(sessionID = CHILD, body = 'LAB-MARKER') {
  return `<task id="${sessionID}" state="completed">\n<task_result>\n${body}\n</task_result>\n</task>`;
}

function parentMessages(output = taskOutput()) {
  return [
    {
      info: {
        id: 'msg_parent_user',
        role: 'user',
        agent: 'orchestrator',
        time: { created: 1790753027027 },
      },
      parts: [{ type: 'text', text: 'create a fixer' }],
    },
    {
      info: {
        id: 'msg_parent_assistant',
        role: 'assistant',
        time: { created: 1790753027058, completed: 1790753027730 },
      },
      parts: [
        {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            input: {
              subagent_type: 'fixer',
              description: 'Run one foreground fixer',
              prompt: 'ask',
              background: false,
            },
            output,
            time: { start: 1790753027488, end: 1790753027722 },
          },
        },
      ],
    },
  ];
}

function host(options?: {
  get?: (id: string) => unknown;
  messages?: (id: string) => unknown;
  omitMessages?: boolean;
  status?: () => Promise<unknown> | unknown;
  promptAsync?: () => Promise<unknown>;
}) {
  const promptAsync = mock(options?.promptAsync ?? (async () => ({})));
  const abort = mock(async () => ({}));
  const status = mock(
    options?.status ?? (async () => ({ data: {} as Record<string, unknown> })),
  );
  const get = mock(async (args: { path: { id: string } }) => {
    if (options?.get) return options.get(args.path.id);
    if (args.path.id !== CHILD) {
      return { error: { message: 'NotFound' } };
    }
    return {
      data: {
        id: CHILD,
        parentID: PARENT,
        agent: 'fixer',
        time: { created: 1790753027495 },
      },
    };
  });
  const messages = mock(async (args: { path: { id: string } }) => {
    if (options?.messages) return options.messages(args.path.id);
    if (args.path.id === CHILD) return { data: childMessages() };
    if (args.path.id === PARENT) return { data: parentMessages() };
    return { error: { message: 'NotFound' } };
  });
  const input = {
    directory: '/test/project',
    client: {
      session: {
        get,
        messages: options?.omitMessages ? undefined : messages,
        status,
        promptAsync,
        abort,
      },
    },
  };
  return { input, promptAsync, abort, status, get };
}

afterEach(() => {
  mock.restore();
  jest.useRealTimers();
});

function installClient() {
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client as never,
  );
}

describe('master adoption and retained-round integration', () => {
  function reviveHost(
    options?: Parameters<typeof host>[0] & { hostFlavor?: string },
  ) {
    installClient();
    const hosted = host(options);
    const board = new BackgroundJobBoard();
    const recover = createSessionRecovery({
      input: hosted.input as never,
      backgroundJobBoard: board,
      ...(options?.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
    });
    const register = mock(() => {});
    const tools = createTaskReviveTool({
      input: hosted.input as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      recoverRetainedSession: recover,
      revivedRunTracker: {
        captureBaseline: async () => 'baseline',
        register,
        probe: async () => {},
      } as never,
    });
    return { ...hosted, board, recover, register, revive: tools.task_revive };
  }

  test('public revive keeps every non-adoptable host probe byte-identical', async () => {
    const outcomes = [
      () => ({ data: { id: CHILD, parentID: 'foreign', agent: 'fixer' } }),
      () => ({}),
      () => ({ error: { message: 'private API failure' } }),
      () => {
        throw new Error('private transport failure');
      },
    ];
    const errors: string[] = [];
    for (const get of outcomes) {
      const fixture = reviveHost({ get });
      try {
        await fixture.revive.execute(
          { task_id: CHILD, prompt: 'continue' },
          context as never,
        );
        throw new Error('expected refusal');
      } catch (error) {
        errors.push((error as Error).message);
      }
      expect(fixture.promptAsync).not.toHaveBeenCalled();
      expect(fixture.abort).not.toHaveBeenCalled();
    }
    expect(new Set(errors).size).toBe(1);
    expect(errors[0]).toContain('Tracking does not survive a host restart');
  });

  test('a persisted terminal result wins before transcript import and retains its epoch', async () => {
    const fixture = reviveHost();
    recordBackgroundJobSuppression(fixture.board, CHILD, {
      state: 'completed',
      resultSummary: 'saved old answer',
    });
    const ledger = getBackgroundJobLifecycleLedger(fixture.board);
    const epoch = ledger.deletionEpochs.get(CHILD);
    await expect(
      fixture.revive.execute(
        { task_id: CHILD, prompt: 'continue' },
        context as never,
      ),
    ).rejects.toThrow('recorded result: saved old answer');
    expect(fixture.board.get(CHILD)).toBeUndefined();
    expect(ledger.tombstones.has(CHILD)).toBe(false);
    expect(ledger.deletionEpochs.get(CHILD)).toBe(epoch);
    expect(fixture.promptAsync).not.toHaveBeenCalled();
    const output = await fixture.revive.execute(
      { task_id: CHILD, prompt: 'continue' },
      context as never,
    );
    expect(output).toContain('started');
    expect(fixture.register).toHaveBeenCalledTimes(1);
    expect(fixture.promptAsync).toHaveBeenCalledTimes(1);
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(fixture.board.get(CHILD)?.taskGeneration).toBe(2);
  });

  // #1387 P2: GC removes the host session, so on v2 the only remaining
  // evidence of the result is the persisted tombstone. The tombstone has
  // no parentID, so the NotFound leg names the ending but stays result-FREE.
  test('v2 revive after GC surfaces a result-free tombstone refusal', async () => {
    const fixture = reviveHost({
      hostFlavor: 'v2',
      get: () => ({ error: { message: 'NotFound' } }),
      messages: () => ({ error: { message: 'NotFound' } }),
    });
    recordBackgroundJobSuppression(fixture.board, CHILD, {
      state: 'completed',
      resultSummary: 'saved old answer',
    });
    const message = await fixture.revive
      .execute({ task_id: CHILD, prompt: 'continue' }, context as never)
      .catch((error: Error) => error.message);
    expect(message).toContain('completed');
    expect(message).toContain('no longer available on the host');
    expect(message).not.toContain('saved old answer');
    expect(fixture.promptAsync).not.toHaveBeenCalled();
    expect(fixture.abort).not.toHaveBeenCalled();
    // At-most-once: the tombstone is consumed by the first revive.
    expect(getSuppressionTombstone(CHILD)).toBeUndefined();
    await expect(
      fixture.revive.execute(
        { task_id: CHILD, prompt: 'continue' },
        context as never,
      ),
    ).rejects.toThrow('Tracking does not survive a host restart');
  });

  test('v2 revive after GC without a tombstone keeps the generic advice', async () => {
    const fixture = reviveHost({
      hostFlavor: 'v2',
      get: () => ({ error: { message: 'NotFound' } }),
      messages: () => ({ error: { message: 'NotFound' } }),
    });
    await expect(
      fixture.revive.execute(
        { task_id: CHILD, prompt: 'continue' },
        context as never,
      ),
    ).rejects.toThrow('Tracking does not survive a host restart');
    expect(fixture.promptAsync).not.toHaveBeenCalled();
    expect(fixture.abort).not.toHaveBeenCalled();
  });

  // 'no transcript' runs task_revive's legacy v1 adoption.
  test.each(['completed round', 'no transcript'])(
    '%s provenance stays non-abortable across pre-send refusal and retry',
    async (kind) => {
      let calls = 0;
      let busy = false;
      const fixture = reviveHost({
        ...(kind === 'no transcript' ? { messages: () => ({ data: [] }) } : {}),
        status: async () => {
          calls += 1;
          if (calls === (kind === 'no transcript' ? 2 : 3)) busy = true;
          return { data: { [CHILD]: { type: busy ? 'busy' : 'idle' } } };
        },
      });
      await expect(
        fixture.revive.execute(
          { task_id: CHILD, prompt: 'continue' },
          context as never,
        ),
      ).rejects.toThrow('executing at the host');
      expect(fixture.board.get(CHILD)).toBeDefined();
      expect(fixture.promptAsync).not.toHaveBeenCalled();
      expect(fixture.abort).not.toHaveBeenCalled();
      busy = false;
      await fixture.revive.execute(
        { task_id: CHILD, prompt: 'retry now idle' },
        context as never,
      );
      expect(fixture.promptAsync).toHaveBeenCalledTimes(1);
      expect(fixture.abort).not.toHaveBeenCalled();
      expect(fixture.register).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['messages capability absent', 'valid empty transcript'])(
    '%s preserves exact adoption and sends one prompt in one new generation',
    async (kind) => {
      const fixture = reviveHost({
        omitMessages: kind === 'messages capability absent',
        messages: () => ({ data: [] }),
      });
      const recovered = await fixture.recover({
        parentSessionID: PARENT,
        requested: CHILD,
        purpose: 'revive',
        allowExactAdoption: true,
      });
      expect(recovered).toMatchObject({ kind: 'adoptable', taskID: CHILD });
      expect(fixture.board.get(CHILD)).toBeUndefined();
      const output = await fixture.revive.execute(
        { task_id: CHILD, prompt: 'continue' },
        context as never,
      );
      expect(output).toContain(`task_id: ${CHILD}`);
      expect(output).toContain('started');
      expect(fixture.promptAsync).toHaveBeenCalledTimes(1);
      expect(fixture.abort).not.toHaveBeenCalled();
      expect(fixture.register).toHaveBeenCalledTimes(1);
      expect(fixture.board.list(PARENT)).toHaveLength(1);
      expect(fixture.board.get(CHILD)).toMatchObject({
        alias: CHILD,
        taskGeneration: 2,
      });
    },
  );

  // v1 session.messages; 'parent' is legacy adoption's read. Reads stay complete.
  test.each(['child', 'parent'])(
    'a held %s transcript read refuses revive at its deadline, unsent',
    async (held) => {
      let reading: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const fixture = reviveHost({
        messages: (id) => {
          if (id !== (held === 'parent' ? PARENT : CHILD)) return { data: [] };
          reading();
          return new Promise(() => {});
        },
      });
      jest.useFakeTimers();
      const pending = fixture.revive.execute(
        { task_id: CHILD, prompt: 'continue' },
        context as never,
      );
      await started;
      jest.advanceTimersByTime(5_000);
      // A plain await: `.rejects` on a never-settling promise spins forever.
      expect(await pending.catch((error: Error) => error.message)).toBe(
        `Task ${CHILD} transcript could not be read (${held} transcript read timed out); no prompt was sent`,
      );
      expect(fixture.promptAsync).not.toHaveBeenCalled();
      expect(fixture.board.get(CHILD)).toBeUndefined();
    },
    1_000,
  );

  test.each(['agent conflict', 'malformed transcript', 'transcript API error'])(
    '%s cannot fall back to upstream weaker adoption',
    async (kind) => {
      const fixture = reviveHost({
        ...(kind === 'agent conflict'
          ? {
              get: () => ({
                data: { id: CHILD, parentID: PARENT, agent: 'oracle' },
              }),
            }
          : {}),
        messages: (id) =>
          kind === 'malformed transcript'
            ? { data: 'invalid' }
            : kind === 'transcript API error'
              ? { error: { message: 'failed' } }
              : {
                  data:
                    id === CHILD
                      ? childMessages().map((message) => ({
                          ...message,
                          info: { ...message.info, agent: 'oracle' },
                        }))
                      : parentMessages(),
                },
      });
      await expect(
        fixture.revive.execute(
          { task_id: CHILD, prompt: 'continue' },
          context as never,
        ),
      ).rejects.toThrow();
      expect(fixture.board.get(CHILD)).toBeUndefined();
      expect(fixture.promptAsync).not.toHaveBeenCalled();
      expect(fixture.abort).not.toHaveBeenCalled();
    },
  );
});

describe('session recovery', () => {
  test('exact id imports a completed child from an empty status map', async () => {
    installClient();
    const { input } = host();
    const board = new BackgroundJobBoard();
    const recover = createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
      stopConfirmationBudgetMs: 0,
    });
    const result = await recover({ parentSessionID: PARENT, requested: CHILD });
    expect(result).toEqual({ kind: 'recovered', taskID: CHILD });
    expect(board.get(CHILD)).toMatchObject({
      state: 'completed',
      agent: 'fixer',
      alias: CHILD,
      parentSessionID: PARENT,
      resultSummary: 'LAB-MARKER',
      launchedAt: 1790753027502,
      completedAt: 1790753027711,
      background: false,
    });
    expect(board.isRunning(PARENT)).toBe(false);
  });

  // task_cancel stores the argument as typed; its output names the task.
  test.each([
    ['an alias', 'fix-1', CHILD, 'cancelled', 'cancelled'],
    [
      'an alias of another task',
      'fix-1',
      'ses_other',
      'cancelled',
      'completed',
    ],
    ['an alias, stale', 'fix-1', CHILD, 'completed', 'completed'],
  ])('a parent task_cancel by %s', async (_, argument, named, said, state) => {
    installClient();
    const cancel = {
      info: {
        id: 'msg_cancel',
        role: 'assistant',
        time: { created: 1790753027800 },
      },
      parts: [
        {
          type: 'tool',
          tool: 'task_cancel',
          state: {
            status: 'completed',
            input: { task_id: argument },
            output: `task_id: ${named}\nstate: ${said}\n\n<task_error>\ncancelled\n</task_error>`,
            time: { start: 1790753027800, end: 1790753027810 },
          },
        },
      ],
    };
    const { input } = host({
      messages: (id) => ({
        data: id === CHILD ? childMessages() : [...parentMessages(), cancel],
      }),
    });
    const board = new BackgroundJobBoard();
    expect(
      await createSessionRecovery({
        input: input as never,
        backgroundJobBoard: board,
        stableStoppedMs: 0,
      })({ parentSessionID: PARENT, requested: CHILD }),
    ).toMatchObject({ kind: 'recovered' });
    expect(board.get(CHILD)?.state).toBe(state);
  });

  test('a manual compaction round does not replace the specialist result', async () => {
    installClient();
    // Shapes written by opencode's session/compaction.ts.
    const compaction = [
      {
        info: { id: 'msg_compact', role: 'user', time: { created: 20 } },
        parts: [{ type: 'compaction', auto: false }],
      },
      {
        info: {
          id: 'msg_summary',
          role: 'assistant',
          parentID: 'msg_compact',
          agent: 'compaction',
          summary: true,
          finish: 'stop',
          time: { created: 21, completed: 22 },
        },
        parts: [{ type: 'text', text: 'COMPACTION-SUMMARY' }],
      },
    ];
    const { input } = host({
      messages: (id) => ({
        data:
          id === CHILD ? [...childMessages(), ...compaction] : parentMessages(),
      }),
    });
    const board = new BackgroundJobBoard();
    await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
      stopConfirmationBudgetMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    expect(board.get(CHILD)?.resultSummary).toBe('LAB-MARKER');
  });

  test('wrong parent, missing child, busy, and a broken status map do not import', async () => {
    installClient();
    const cases = [
      host({
        get: () => ({
          data: { id: CHILD, parentID: 'ses_other', agent: 'fixer' },
        }),
      }),
      host({ get: () => ({ error: { message: 'NotFound' } }) }),
      host({ status: async () => ({ data: { [CHILD]: { type: 'busy' } } }) }),
      host({ status: async () => ({ data: undefined }) }),
      host({ status: async () => ({ data: { type: 'idle' } }) }),
    ];
    for (const fixture of cases) {
      const board = new BackgroundJobBoard();
      const recover = createSessionRecovery({
        input: fixture.input as never,
        backgroundJobBoard: board,
        stableStoppedMs: 0,
      });
      const result = await recover({
        parentSessionID: PARENT,
        requested: CHILD,
      });
      expect(result.kind).toBe('refused');
      expect(board.get(CHILD)).toBeUndefined();
      expect(fixture.promptAsync).not.toHaveBeenCalled();
    }
  });

  test('parent history is optional when the child user names the agent', async () => {
    installClient();
    const { input } = host({
      get: () => ({
        data: { id: CHILD, parentID: PARENT, time: { created: 10 } },
      }),
      messages: (id) => {
        if (id === CHILD) return { data: childMessages() };
        throw new Error('parent compacted');
      },
    });
    const board = new BackgroundJobBoard();
    const result = await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    expect(result.kind).toBe('recovered');
    expect(board.get(CHILD)?.agent).toBe('fixer');
  });

  test('conflicting agent evidence is not guessed', async () => {
    installClient();
    const { input, promptAsync } = host({
      get: () => ({
        data: {
          id: CHILD,
          parentID: PARENT,
          agent: 'oracle',
          time: { created: 10 },
        },
      }),
    });
    const board = new BackgroundJobBoard();
    const result = await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toContain('agent');
    expect(board.get(CHILD)).toBeUndefined();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('a deletion during the read does not import over the new epoch', async () => {
    installClient();
    const board = new BackgroundJobBoard();
    let started: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { input } = host({
      get: async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          data: {
            id: CHILD,
            parentID: PARENT,
            agent: 'fixer',
            time: { created: 10 },
          },
        };
      },
    });
    const pending = createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    await seen;
    recordBackgroundJobSuppression(board, CHILD);
    const result = await pending;
    expect(result.kind).toBe('refused');
    expect(board.get(CHILD)).toBeUndefined();
  });

  test('a row that appears during the read is left untouched', async () => {
    installClient();
    const board = new BackgroundJobBoard();
    let started: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { input } = host({
      get: async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          data: {
            id: CHILD,
            parentID: PARENT,
            agent: 'fixer',
            time: { created: 10 },
          },
        };
      },
    });
    const pending = createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    await seen;
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      now: 5,
    });
    const result = await pending;
    expect(result).toEqual({ kind: 'existing', taskID: CHILD });
    expect(board.get(CHILD)).toMatchObject({
      state: 'running',
      alias: 'fix-1',
    });

    const other = new BackgroundJobBoard();
    const foreign = createSessionRecovery({
      input: input as never,
      backgroundJobBoard: other,
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    other.registerLaunch({
      taskID: CHILD,
      parentSessionID: 'ses_otherparent',
      agent: 'fixer',
      now: 6,
    });
    const refused = await foreign;
    expect(refused.kind).toBe('refused');
    if (refused.kind === 'refused') {
      expect(refused.reason).toContain('different parent');
    }
    expect(other.get(CHILD)?.parentSessionID).toBe('ses_otherparent');
  });

  test('alias suffix recovers one target and rejects ambiguity or a child-body fake', async () => {
    installClient();
    const suffixed = appendChildRefSuffix(taskOutput(), {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-3',
      sessionID: CHILD,
    });
    expect(readAuthoritativeChildRef(suffixed)?.alias).toBe('fix-3');
    const fake = taskOutput(
      CHILD,
      '<!-- slim-child-ref:v1 {"parentSessionID":"ses_parent","agent":"fixer","alias":"fix-9","sessionID":"ses_child"} -->',
    );
    expect(readAuthoritativeChildRef(fake)).toBeUndefined();

    const { input } = host({
      messages: (id) => {
        if (id === CHILD) {
          return {
            data: childMessages(
              '<!-- slim-child-ref:v1 {"parentSessionID":"ses_parent","agent":"oracle","alias":"fix-9","sessionID":"ses_child"} -->',
            ),
          };
        }
        return { data: parentMessages(suffixed) };
      },
    });
    const board = new BackgroundJobBoard();
    const resolve = (target: unknown, alias: string, into = board) =>
      createAliasAuthority({
        input: target as never,
        board: into,
      }).resolveCanonical(PARENT, alias);
    expect(await resolve(input, 'fix-3')).toEqual({
      kind: 'exact',
      taskID: CHILD,
    });
    const recover = createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
    });
    expect(
      await recover({ parentSessionID: PARENT, requested: CHILD }),
    ).toEqual({ kind: 'recovered', taskID: CHILD });
    expect(board.get(CHILD)?.alias).toBe('fix-3');

    const other = 'ses_otherchild';
    const ambiguous = host({
      messages: () => ({
        data: [
          ...parentMessages(suffixed),
          ...parentMessages(
            appendChildRefSuffix(taskOutput(other), {
              parentSessionID: PARENT,
              agent: 'fixer',
              alias: 'fix-3',
              sessionID: other,
            }),
          ),
        ],
      }),
    });
    const second = new BackgroundJobBoard();
    const ambiguousResult = await resolve(ambiguous.input, 'fix-3', second);
    expect(ambiguousResult.kind).toBe('refused');
    if (ambiguousResult.kind === 'refused') {
      expect(ambiguousResult.reason).toContain(CHILD);
      expect(ambiguousResult.reason).toContain(other);
    }
    expect(second.list(PARENT)).toEqual([]);

    const missing = new BackgroundJobBoard();
    const oldAlias = await resolve(host().input, 'fix-1', missing);
    expect(oldAlias.kind).toBe('refused');
    if (oldAlias.kind === 'refused') {
      expect(oldAlias.reason).toContain('exact session id');
    }
  });

  test('task_result and task_status keep a restored completed round, then revive starts a new one', async () => {
    installClient();
    let reading = false;
    const { input, promptAsync } = host({
      messages: (id) => {
        if (id === CHILD && reading) {
          return {
            data: [
              {
                info: {
                  id: 'msg_later_user',
                  role: 'user',
                  agent: 'fixer',
                  time: { created: 1790753027800 },
                },
                parts: [{ type: 'text', text: 'unanswered' }],
              },
            ],
          };
        }
        if (id === CHILD) return { data: childMessages() };
        if (id === PARENT) return { data: parentMessages() };
        return { error: { message: 'NotFound' } };
      },
    });
    const board = new BackgroundJobBoard();
    const recover = createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
    });
    expect(
      await recover({ parentSessionID: PARENT, requested: CHILD }),
    ).toEqual({ kind: 'recovered', taskID: CHILD });
    const restored = board.get(CHILD);
    expect(restored).toMatchObject({
      state: 'completed',
      resultSummary: 'LAB-MARKER',
      verifiedRetainedRound: true,
    });
    reading = true;
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      input: input as never,
    });
    const result = await createTaskResultTool({
      input: input as never,
      backgroundJobBoard: board,
      terminalGate: gate,
    }).task_result.execute({ task_id: CHILD }, context);
    const status = await createTaskStatusTool({
      input: input as never,
      backgroundJobBoard: board,
    }).task_status.execute({ task_id: CHILD }, context);
    expect(result).toBe('LAB-MARKER');
    expect(String(status)).toContain('state: completed');
    expect(String(status)).not.toContain('stopped');
    expect(board.get(CHILD)).toMatchObject({
      state: 'completed',
      resultSummary: 'LAB-MARKER',
      generation: restored?.generation,
      terminalRevision: restored?.terminalRevision,
    });
    const tools = createTaskReviveTool({
      input: input as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      terminalGate: gate,
      revivedRunTracker: createRevivedRunTracker({
        input: input as never,
        backgroundJobBoard: board,
        terminalGate: gate,
      }),
      baselineTimeoutMs: 1000,
    });
    await tools.task_revive.execute(
      { task_id: CHILD, prompt: 'new round' },
      context,
    );
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(board.get(CHILD)?.generation).toBe((restored?.generation ?? 0) + 1);
    expect(board.get(CHILD)?.state).toBe('running');
    expect(board.get(CHILD)?.resultSummary).toBeUndefined();
    expect(board.get(CHILD)?.verifiedRetainedRound).not.toBe(true);
  });

  test('task_revive continues a recovered session once and does not keep the old result', async () => {
    installClient();
    const { input, promptAsync } = host();
    const board = new BackgroundJobBoard();
    const terminalGate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      input: input as never,
    });
    const tools = createTaskReviveTool({
      input: input as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      terminalGate,
      revivedRunTracker: createRevivedRunTracker({
        input: input as never,
        backgroundJobBoard: board,
        terminalGate,
      }),
      recoverRetainedSession: createSessionRecovery({
        input: input as never,
        backgroundJobBoard: board,
        stableStoppedMs: 0,
      }),
      baselineTimeoutMs: 1000,
    });
    const output = await tools.task_revive.execute(
      { task_id: CHILD, prompt: 'continue without the marker' },
      context,
    );
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      path: { id: string };
      body: { agent: string; parts: Array<{ text: string }> };
    };
    expect(call.path.id).toBe(CHILD);
    expect(call.body.agent).toBe('fixer');
    expect(call.body.parts[0]?.text).toBe('continue without the marker');
    expect(board.get(CHILD)).toMatchObject({ state: 'running' });
    expect(board.get(CHILD)?.resultSummary).toBeUndefined();
    expect(String(output)).not.toContain('LAB-MARKER');
    expect(board.list(PARENT)).toHaveLength(1);
  });

  test('task_revive continues a known unreconciled completed session without task_result', async () => {
    installClient();
    const { input, promptAsync } = host();
    const board = new FixtureBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      now: 10,
    });
    board.updateStatus({
      taskID: CHILD,
      state: 'completed',
      resultSummary: 'first round',
    });
    expect(board.get(CHILD)?.terminalUnreconciled).toBe(true);
    const terminalGate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      input: input as never,
    });
    const tools = createTaskReviveTool({
      input: input as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      terminalGate,
      revivedRunTracker: createRevivedRunTracker({
        input: input as never,
        backgroundJobBoard: board,
        terminalGate,
      }),
    });
    await tools.task_revive.execute(
      { task_id: CHILD, prompt: 'second round' },
      context,
    );
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(board.get(CHILD)).toMatchObject({ state: 'running' });
    expect(board.get(CHILD)?.resultSummary).toBeUndefined();
  });

  test('task_cancel reports a recovered terminal session and does not abort it', async () => {
    installClient();
    const { input, abort } = host();
    const board = new BackgroundJobBoard();
    const tools = createCancelTaskTool({
      input: input as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      recoverRetainedSession: createSessionRecovery({
        input: input as never,
        backgroundJobBoard: board,
        stableStoppedMs: 0,
      }),
    });
    const output = await tools.task_cancel.execute({ task_id: CHILD }, context);
    expect(String(output)).toContain('state: completed');
    expect(String(output)).toContain('not running');
    expect(abort).not.toHaveBeenCalled();
    expect(board.get(CHILD)?.state).toBe('completed');
  });

  test('busy recovery is not cancelled', async () => {
    installClient();
    const { input, abort } = host({
      status: async () => ({ data: { [CHILD]: { type: 'busy' } } }),
    });
    const board = new BackgroundJobBoard();
    const tools = createCancelTaskTool({
      input: input as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      recoverRetainedSession: createSessionRecovery({
        input: input as never,
        backgroundJobBoard: board,
        stableStoppedMs: 0,
      }),
    });
    const output = await tools.task_cancel.execute({ task_id: CHILD }, context);
    expect(String(output)).toContain('no prompt was sent');
    expect(abort).not.toHaveBeenCalled();
    expect(board.get(CHILD)).toBeUndefined();
  });
});

describe('native task refusal and child ref suffix', () => {
  test('an unknown v1 id points at task_revive and is not dropped', async () => {
    const board = new BackgroundJobBoard();
    const args = {
      subagent_type: 'fixer',
      task_id: CHILD,
      prompt: 'continue',
      description: 'continue',
    };
    await expect(
      handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'call_4' },
        { args },
        {
          shouldManageSession: () => true,
          backgroundJobBoard: board,
          pendingCallTracker: {
            add() {},
            take: () => undefined,
            pendingCallId: () => 'call_4',
          },
          taskContextTracker: { pendingManagedTaskIds: new Set() },
        },
      ),
    ).rejects.toThrow(/task_revive\(task_id: "ses_child"/);
    expect(args.task_id).toBe(CHILD);
  });

  test('v2 keeps the omit-to-start-a-new-session refusal', async () => {
    await expect(
      handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'call_4' },
        {
          args: {
            subagent_type: 'fixer',
            task_id: CHILD,
            prompt: 'continue',
            description: 'continue',
          },
        },
        {
          shouldManageSession: () => true,
          backgroundJobBoard: new BackgroundJobBoard(),
          pendingCallTracker: {
            add() {},
            take: () => undefined,
            pendingCallId: () => 'call_4',
          },
          taskContextTracker: { pendingManagedTaskIds: new Set() },
          hostFlavor: 'v2',
        },
      ),
    ).rejects.toThrow(/Omit sessionID on a separate call/);
  });

  test('a successfully attributed native result gains one suffix after the outer close', async () => {
    const board = new BackgroundJobBoard();
    const output = {
      output: `<task id="${CHILD}" state="running">\nworking\n</task>`,
    };
    await handleToolExecuteAfter(
      { tool: 'task', sessionID: PARENT, callID: 'call_2' },
      output,
      {
        directory: '/test/project',
        backgroundJobBoard: board,
        terminalGate: {} as never,
        pendingCallTracker: {
          take: () => ({
            callId: 'call_2',
            parentSessionId: PARENT,
            agentType: 'fixer',
            label: 'Run one foreground fixer',
            background: false,
            lifecycleEpoch: 0,
          }),
          takeByTaskID: () => undefined,
          takeUnresolvedFirstMatch: () => undefined,
        },
        taskContextTracker: {
          pendingManagedTaskIds: new Set<string>(),
          addContext() {},
          contextFilesForPrompt: () => [],
          prune() {},
        },
      },
    );
    const ref = readAuthoritativeChildRef(String(output.output));
    expect(ref).toEqual({
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: CHILD,
    });
    expect(String(output.output).indexOf('</task>')).toBeLessThan(
      String(output.output).indexOf('slim-child-ref:v1'),
    );
  });
});
