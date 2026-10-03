import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OhMyOpenCodeLite } from '../../index';
import { createCancelTaskTool } from '../../tools/cancel-task';
import { createTaskMessageTool } from '../../tools/task-message';
import { createTaskReplyTool } from '../../tools/task-reply';
import { createTaskResultTool } from '../../tools/task-result';
import { createTaskReviveTool } from '../../tools/task-revive';
import { createTaskStatusTool } from '../../tools/task-status';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import * as persistence from '../../utils/background-job-persistence';
import * as opencodeClient from '../../utils/opencode-client';
import { buildPluginInput } from '../../v2/client-shim';
import {
  appendChildRefSuffix,
  createAliasAuthority,
  createSessionRecovery,
  noteExactSessionAlias,
} from './session-recovery';
import { handleToolExecuteBefore } from './tool-execute-hooks';

const PARENT = 'ses_parent';
const OTHER = 'ses_otherparent';
const HOST = 'ses_hostchild';
const CACHE = 'ses_cachechild';
const context = { sessionID: PARENT, agent: 'orchestrator' };

afterEach(() => {
  mock.restore();
});

function closed(sessionID: string, body = 'ok'): string {
  return `<task id="${sessionID}" state="completed">\n<task_result>\n${body}\n</task_result>\n</task>`;
}

function withRef(
  sessionID: string,
  alias: string,
  agent = 'fixer',
  parent = PARENT,
): string {
  return appendChildRefSuffix(closed(sessionID), {
    parentSessionID: parent,
    agent,
    alias,
    sessionID,
  });
}

function taskPart(input: {
  output: string;
  agent?: string;
  tool?: string;
  callID?: string;
  status?: string;
}) {
  return {
    info: {
      id: `msg_${input.callID ?? 'done'}`,
      role: 'assistant',
      time: { created: 10, completed: 20 },
    },
    parts: [
      {
        type: 'tool',
        tool: input.tool ?? 'task',
        callID: input.callID ?? 'call_done',
        state: {
          status: input.status ?? 'completed',
          input: {
            subagent_type: input.agent ?? 'fixer',
            description: 'check',
            prompt: 'ask',
          },
          output: input.output,
          time: { start: 11, end: 19 },
        },
      },
    ],
  };
}

function clientFor(
  pages: unknown[] | ((id: string) => unknown | Promise<unknown>),
  extras?: Record<string, unknown>,
) {
  const messages = mock(async (args: { path?: { id?: string } }) => {
    if (typeof pages === 'function') return pages(args.path?.id ?? '');
    return { data: pages };
  });
  const prompt = mock(async () => ({}));
  const promptAsync = mock(async () => ({}));
  const abort = mock(async () => ({}));
  const reply = mock(async () => ({}));
  const input = {
    directory: '/tmp/omo-alias-authority',
    client: {
      session: {
        messages,
        prompt,
        promptAsync,
        abort,
        status: async () => ({ data: {} }),
        get: async () => ({
          data: { id: HOST, parentID: PARENT, agent: 'fixer' },
        }),
        ...extras,
      },
      permission: { reply },
    },
  };
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (value) => (value as { client: unknown }).client as never,
  );
  return { input, messages, prompt, promptAsync, abort, reply };
}

function deferredBoard() {
  return new BackgroundJobBoard({ deferNumberedAliases: true });
}

describe('alias numbering preparation', () => {
  test('an unprepared parent keeps the task id, including early register paths', () => {
    const board = deferredBoard();
    expect(board.isNumberedAliasReady(PARENT)).toBe(false);
    const early = board.registerLaunch({
      taskID: 'ses_early',
      parentSessionID: PARENT,
      agent: 'fixer',
    });
    const placeholder = board.registerLaunch({
      taskID: 'ses_placeholder',
      parentSessionID: PARENT,
      agent: 'oracle',
      provisional: true,
    });
    const adopted = board.registerLaunch({
      taskID: 'ses_adopted',
      parentSessionID: PARENT,
      agent: 'explorer',
    });
    expect(early.alias).toBe('ses_early');
    expect(placeholder.alias).toBe('ses_placeholder');
    expect(adopted.alias).toBe('ses_adopted');
    expect(
      board.registerLaunch({
        taskID: 'ses_other',
        parentSessionID: OTHER,
        agent: 'fixer',
      }).alias,
    ).toBe('ses_other');
  });

  test('a complete empty history enables monotonic numbering without rewriting the backend floor', () => {
    const bump = spyOn(persistence, 'bumpAliasHighWaterMark');
    const board = new BackgroundJobBoard({
      deferNumberedAliases: true,
      aliasCounterHighWater: (parent, prefix) =>
        parent === PARENT && prefix === 'fix' ? 4 : 0,
    });
    expect(board.applyVerifiedAliasFloor(PARENT, { fix: 2 })).toBe(true);
    expect(bump).not.toHaveBeenCalled();
    expect(board.isNumberedAliasReady(PARENT)).toBe(true);
    expect(
      board.registerLaunch({
        taskID: 'ses_next',
        parentSessionID: PARENT,
        agent: 'fixer',
      }).alias,
    ).toBe('fix-5');
    expect(
      board.registerLaunch({
        taskID: 'ses_other_parent',
        parentSessionID: OTHER,
        agent: 'fixer',
      }).alias,
    ).toBe('ses_other_parent');
  });

  test('verified history floors every prefix, including a custom agent, per parent', async () => {
    const { input, messages } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-2'), agent: 'fixer' }),
      taskPart({
        output: withRef('ses_oracle', 'ora-4', 'oracle'),
        agent: 'oracle',
        callID: 'call_oracle',
      }),
      taskPart({
        output: withRef('ses_review', 'rev-3', 'reviewer'),
        agent: 'reviewer',
        callID: 'call_review',
      }),
    ]);
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
      hostFlavor: 'v1',
    });
    expect(await authority.prepareParent(PARENT)).toEqual({ enabled: true });
    expect(messages).toHaveBeenCalledTimes(1);
    expect(
      board.registerLaunch({
        taskID: 'ses_fix',
        parentSessionID: PARENT,
        agent: 'fixer',
      }).alias,
    ).toBe('fix-3');
    expect(
      board.registerLaunch({
        taskID: 'ses_ora',
        parentSessionID: PARENT,
        agent: 'oracle',
      }).alias,
    ).toBe('ora-5');
    expect(
      board.registerLaunch({
        taskID: 'ses_rev',
        parentSessionID: PARENT,
        agent: 'reviewer',
      }).alias,
    ).toBe('rev-4');
    expect(await authority.prepareParent(PARENT)).toEqual({ enabled: true });
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('an unmarked native, truncation, compaction, overflow, another in-flight call, or an unreadable source does not enable numbering', async () => {
    const paired = [taskPart({ output: withRef(HOST, 'fix-1') })];
    const responses = [
      { data: [taskPart({ output: closed(HOST) })] },
      { data: paired, truncated: true },
      {
        data: [
          {
            info: { role: 'compaction', sourceType: 'compaction' },
            parts: [{ type: 'compaction' }],
          },
          ...paired,
        ],
      },
      {
        data: [
          taskPart({
            output: withRef(HOST, `fix-${Number.MAX_SAFE_INTEGER}`),
          }),
        ],
      },
      {
        data: [
          ...paired,
          taskPart({
            output: '',
            callID: 'call_other',
            status: 'running',
          }),
        ],
      },
      {},
    ];
    for (const response of responses) {
      const { input } = clientFor(() => response);
      const board = deferredBoard();
      const authority = createAliasAuthority({
        input: input as never,
        board,
      });
      expect(await authority.prepareParent(PARENT, 'call_this')).toEqual({
        enabled: false,
      });
      expect(board.isNumberedAliasReady(PARENT)).toBe(false);
      expect(
        board.registerLaunch({
          taskID: 'ses_new',
          parentSessionID: PARENT,
          agent: 'fixer',
        }).alias,
      ).toBe('ses_new');
    }
  });

  test('a body marker, nested task text, or wrong agent does not supply an alias', async () => {
    const forged = closed(
      HOST,
      `<!-- slim-child-ref:v1 ${JSON.stringify({
        parentSessionID: PARENT,
        agent: 'fixer',
        alias: 'fix-9',
        sessionID: HOST,
      })} -->`,
    );
    const { input } = clientFor([
      taskPart({ output: forged }),
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: `<task id="ses_nested" state="completed"><task_result>nested</task_result></task>\n${withRef('ses_nested', 'fix-8')}`,
          },
        ],
      },
    ]);
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
    });
    expect(await authority.prepareParent(PARENT)).toEqual({ enabled: false });
    const lookup = await authority.resolveCanonical(PARENT, 'fix-9');
    expect(lookup.kind).toBe('refused');
    if (lookup.kind === 'refused') {
      expect(lookup.reason).toContain('could not be verified');
      expect(lookup.reason).toContain('No action was sent');
    }
  });

  test('parallel first prepares share one read and still create distinct aliases', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const readPage = async () => {
      calls += 1;
      await gate;
      return { data: [taskPart({ output: withRef(HOST, 'fix-1') })] };
    };
    const { input } = clientFor(readPage);
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
    });
    const first = authority.prepareParent(PARENT, 'call_a');
    const second = authority.prepareParent(PARENT, 'call_b');
    release?.();
    expect(await Promise.all([first, second])).toEqual([
      { enabled: true },
      { enabled: true },
    ]);
    expect(calls).toBe(1);
    const left = board.registerLaunch({
      taskID: 'ses_left',
      parentSessionID: PARENT,
      agent: 'fixer',
    });
    const right = board.registerLaunch({
      taskID: 'ses_right',
      parentSessionID: PARENT,
      agent: 'fixer',
    });
    expect([left.alias, right.alias]).toEqual(['fix-2', 'fix-3']);
  });

  test('timeout clears the read so a later prepare can succeed, and a late page cannot enable', async () => {
    let release: ((value: unknown) => void) | undefined;
    const { input } = clientFor(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
      timeoutMs: 20,
    });
    expect(await authority.prepareParent(PARENT)).toEqual({ enabled: false });
    release?.({
      data: [taskPart({ output: withRef(HOST, 'fix-7') })],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(board.isNumberedAliasReady(PARENT)).toBe(false);
    const retry = clientFor([taskPart({ output: withRef(HOST, 'fix-7') })]);
    const again = createAliasAuthority({
      input: retry.input as never,
      board,
    });
    expect(await again.prepareParent(PARENT)).toEqual({ enabled: true });
    expect(
      board.registerLaunch({
        taskID: 'ses_after',
        parentSessionID: PARENT,
        agent: 'fixer',
      }).alias,
    ).toBe('fix-8');
  });

  test('a disposed late prepare does not mutate or enable the parent', async () => {
    let disposed = false;
    let release: ((value: unknown) => void) | undefined;
    const { input } = clientFor(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
      isDisposed: () => disposed,
      timeoutMs: 500,
    });
    const pending = authority.prepareParent(PARENT);
    disposed = true;
    release?.({ data: [taskPart({ output: withRef(HOST, 'fix-4') })] });
    expect(await pending).toEqual({ enabled: false, stopped: true });
    expect(board.isNumberedAliasReady(PARENT)).toBe(false);
    expect(
      board.registerLaunch({
        taskID: 'ses_disposed',
        parentSessionID: PARENT,
        agent: 'fixer',
      }).alias,
    ).toBe('ses_disposed');
  });

  test('an unconsumed cursor and a v2 context array are not a complete floor', async () => {
    const paged = clientFor(() => ({
      data: [taskPart({ output: withRef(HOST, 'fix-1') })],
      next: 'page-2',
    }));
    const pagedBoard = deferredBoard();
    expect(
      await createAliasAuthority({
        input: paged.input as never,
        board: pagedBoard,
        hostFlavor: 'v2',
        timeoutMs: 200,
      }).prepareParent(PARENT),
    ).toEqual({ enabled: false });
    expect(paged.messages.mock.calls.length).toBeGreaterThan(1);

    const context = clientFor([taskPart({ output: withRef(HOST, 'fix-1') })]);
    const contextBoard = deferredBoard();
    expect(
      await createAliasAuthority({
        input: context.input as never,
        board: contextBoard,
        hostFlavor: 'v2',
      }).prepareParent(PARENT),
    ).toEqual({ enabled: false });
    expect(context.messages).toHaveBeenCalledTimes(1);
  });
});

describe('canonical alias reference', () => {
  test('an exact session id does not read parent history', async () => {
    const { input, messages } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1') }),
    ]);
    const authority = createAliasAuthority({
      input: input as never,
      board: deferredBoard(),
    });
    expect(await authority.resolveCanonical(PARENT, HOST)).toEqual({
      kind: 'exact',
      taskID: HOST,
    });
    expect(messages).not.toHaveBeenCalled();
  });

  test('two saved targets and a host/cache conflict refuse without writing', async () => {
    const other = 'ses_secondhost';
    const { input } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1'), callID: 'call_a' }),
      taskPart({
        output: withRef(other, 'fix-1'),
        callID: 'call_b',
      }),
    ]);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CACHE,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'SECRET-B',
    });
    const authority = createAliasAuthority({
      input: input as never,
      board,
    });
    const many = await authority.resolveCanonical(PARENT, 'fix-1');
    expect(many.kind).toBe('refused');
    if (many.kind === 'refused') {
      expect(many.reason).toContain(HOST);
      expect(many.reason).toContain(other);
      expect(many.reason).toContain('multiple saved targets');
      expect(many.reason).toContain('No action was sent');
    }
    expect(board.get(HOST)).toBeUndefined();
    expect(board.get(CACHE)?.description).toBe('SECRET-B');

    const single = clientFor([taskPart({ output: withRef(HOST, 'fix-1') })]);
    const conflicted = new BackgroundJobBoard();
    conflicted.registerLaunch({
      taskID: CACHE,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'SECRET-B',
    });
    const conflict = await createAliasAuthority({
      input: single.input as never,
      board: conflicted,
    }).resolveCanonical(PARENT, 'fix-1');
    expect(conflict.kind).toBe('refused');
    if (conflict.kind === 'refused') {
      expect(conflict.reason).toContain('host session');
      expect(conflict.reason).toContain(HOST);
      expect(conflict.reason).toContain(CACHE);
    }
    expect(conflicted.get(HOST)).toBeUndefined();
    expect(conflicted.get(CACHE)?.alias).toBe('fix-1');
    expect(conflicted.list(PARENT)).toHaveLength(1);
  });

  test('exact recovery does not republish an alias that also belongs to another session', async () => {
    const { input } = clientFor((id) => {
      if (id === PARENT) {
        return {
          data: [
            taskPart({ output: withRef(HOST, 'fix-1'), callID: 'call_a' }),
            taskPart({
              output: withRef(CACHE, 'fix-1'),
              callID: 'call_b',
            }),
          ],
        };
      }
      return {
        data: [
          {
            info: {
              id: 'msg_user',
              role: 'user',
              agent: 'fixer',
              time: { created: 1 },
            },
            parts: [{ type: 'text', text: 'ask' }],
          },
          {
            info: {
              id: 'msg_turn',
              role: 'assistant',
              finish: 'stop',
              time: { created: 2, completed: 3 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      };
    });
    const board = new BackgroundJobBoard();
    const result = await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      stableStoppedMs: 0,
      stopConfirmationBudgetMs: 0,
    })({ parentSessionID: PARENT, requested: HOST });
    expect(result).toEqual({ kind: 'recovered', taskID: HOST });
    expect(board.get(HOST)?.alias).toBe(HOST);
  });

  test('control and read tools refuse a host/cache conflict before any action', async () => {
    const { input, prompt, promptAsync, abort, reply } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1') }),
    ]);
    const board = new BackgroundJobBoard();
    const cached = board.registerLaunch({
      taskID: CACHE,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'SECRET-B',
    });
    board.updateStatus({
      taskID: CACHE,
      state: 'completed',
      resultSummary: 'SECRET-B',
    });
    const resolveCanonicalTaskRef = createAliasAuthority({
      input: input as never,
      board,
    }).resolveCanonical;
    const shared = {
      input: input as never,
      backgroundJobBoard: board,
      resolveCanonicalTaskRef,
      shouldManageSession: () => true,
    };
    const tools = {
      ...createCancelTaskTool(shared),
      ...createTaskMessageTool(shared),
      ...createTaskReplyTool(shared),
      ...createTaskResultTool(shared),
      ...createTaskReviveTool({
        ...shared,
        revivedRunTracker: { captureBaseline: async () => 'baseline' } as never,
      }),
      ...createTaskStatusTool(shared),
    };
    const cancel = await tools.task_cancel.execute(
      { task_id: 'fix-1' },
      context as never,
    );
    expect(String(cancel)).toContain('No action was sent');
    expect(String(cancel)).not.toContain('SECRET-B');
    await expect(
      tools.task_message.execute(
        { task_id: 'fix-1', message: 'hello' },
        context as never,
      ),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_reply.execute(
        { task_id: 'fix-1', request_id: 'req_1', reply: 'once' },
        context as never,
      ),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_result.execute({ task_id: 'fix-1' }, context as never),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_revive.execute(
        { task_id: 'fix-1', prompt: 'again' },
        context as never,
      ),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_status.execute({ task_id: 'fix-1' }, context as never),
    ).rejects.toThrow(/No action was sent/);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(board.get(CACHE)?.taskID).toBe(cached.taskID);
    expect(board.get(HOST)).toBeUndefined();
  });

  test('after verification a changed alias cannot select the cache row', async () => {
    const { input } = clientFor([taskPart({ output: withRef(HOST, 'fix-1') })]);
    const board = new BackgroundJobBoard();
    board.restoreRetainedSession({
      taskID: HOST,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'HOST-A',
      state: 'completed',
      background: false,
      alias: 'fix-1',
      resultSummary: 'HOST-A',
    });
    const resolveCanonicalTaskRef = createAliasAuthority({
      input: input as never,
      board,
    }).resolveCanonical;
    const status = createTaskStatusTool({
      input: {
        ...input,
        client: {
          ...input.client,
          session: {
            ...input.client.session,
            status: async () => {
              board.registerLaunch({
                taskID: CACHE,
                parentSessionID: PARENT,
                agent: 'fixer',
                description: 'SECRET-B',
              });
              return { data: {} };
            },
          },
        },
      } as never,
      backgroundJobBoard: board,
      resolveCanonicalTaskRef,
    });
    const output = await status.task_status.execute(
      { task_id: 'fix-1' },
      context as never,
    );
    expect(String(output)).toContain(HOST);
    expect(String(output)).not.toContain('SECRET-B');
    expect(String(output)).not.toContain(CACHE);
  });
});

describe('recorded host alias interleave', () => {
  const v1Parent = 'ses_f056711d1ffeK1iBZwobzsRi56';
  const v1A = 'ses_f05670f71ffecrzbssUnH69xZD';
  const v1B = 'ses_f0566b48affe94I8ZSvRgVaTLX';
  const secretA = 'LAB-MARKER:secA-d326f8b2518c';
  const secretB = 'LAB-MARKER:secB-b9939557bd4b';
  const v2Parent = 'ses_f05660aa7ffe2exy7NiCABvlOn';
  const v2A = 'ses_f05660a24ffeGkjo2iOFWeYXdc';
  const v2B = 'ses_f056602a8ffeq7IlAE607sBSzk';
  const v2SecretA = 'LAB-MARKER:secA-671fa707ed9e';
  const v2SecretB = 'LAB-MARKER:secB-d55b46283baf';

  function v1Task(input: {
    callID: string;
    sessionID: string;
    marker: string;
  }) {
    const output = `<task id="${input.sessionID}" state="completed">\n<task_result>\n${input.marker}\n</task_result>\n</task>\n<!-- slim-child-ref:v1 ${JSON.stringify(
      {
        parentSessionID: v1Parent,
        agent: 'fixer',
        alias: 'fix-1',
        sessionID: input.sessionID,
      },
    )} -->`;
    return {
      info: {
        role: 'assistant',
        time: { created: 1790910721646, completed: 1790910722315 },
      },
      parts: [
        { type: 'step-start' },
        {
          type: 'tool',
          callID: input.callID,
          tool: 'task',
          state: {
            status: 'completed',
            input: {
              subagent_type: 'fixer',
              description: 'Run one foreground fixer',
              prompt: input.marker,
              background: false,
            },
            output,
            time: { start: 1790910722184, end: 1790910722306 },
          },
        },
        { type: 'step-finish' },
      ],
    };
  }

  function v2Subagent(input: {
    callID: string;
    sessionID: string;
    alias: string;
    marker: string;
  }) {
    const text = `<subagent sessionID="${input.sessionID}" state="completed">\n${input.marker}\n</subagent>\n<!-- slim-child-ref:v1 ${JSON.stringify(
      {
        parentSessionID: v2Parent,
        agent: 'fixer',
        alias: input.alias,
        sessionID: input.sessionID,
      },
    )} -->`;
    return {
      id: `msg_${input.callID}`,
      time: { created: 1790910789069 },
      type: 'assistant',
      agent: 'fixer',
      content: [
        {
          type: 'tool',
          id: input.callID,
          name: 'subagent',
          executed: true,
          state: {
            status: 'completed',
            input: {
              agent: 'fixer',
              description: 'Run one foreground fixer',
              prompt: input.marker,
              background: false,
            },
            content: [{ type: 'text', text }],
          },
          time: {
            created: 1790910789069,
            ran: 1790910789075,
            completed: 1790910789162,
          },
        },
      ],
    };
  }

  test('v1 restart history with two fix-1 tails does not report B', async () => {
    const { input } = clientFor([
      v1Task({ callID: 'call_2', sessionID: v1A, marker: secretA }),
      v1Task({ callID: 'call_3', sessionID: v1B, marker: secretB }),
    ]);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: v1B,
      parentSessionID: v1Parent,
      agent: 'fixer',
      description: secretB,
    });
    const authority = createAliasAuthority({
      input: input as never,
      board,
      hostFlavor: 'v1',
    });
    const failed = createTaskStatusTool({
      input: input as never,
      backgroundJobBoard: board,
      resolveCanonicalTaskRef: authority.resolveCanonical,
    }).task_status.execute({ task_id: 'fix-1' }, {
      sessionID: v1Parent,
      agent: 'orchestrator',
    } as never);
    await expect(failed).rejects.toThrow(/multiple saved targets/);
    await expect(failed).rejects.toThrow(v1A);
    await expect(failed).rejects.toThrow(v1B);
    await expect(failed).rejects.not.toThrow(/Task fix-1/);
    expect(board.get(v1B)?.description).toBe(secretB);
    expect(board.get(v1A)).toBeUndefined();
  });

  test('a v2 cursor object with next and previous is not a complete floor and cannot select B', async () => {
    const page = {
      data: [
        { id: 'idle', type: 'idle', time: { created: 1 }, outcome: 'idle' },
        v2Subagent({
          callID: 'call_2',
          sessionID: v2A,
          alias: 'fix-1',
          marker: v2SecretA,
        }),
        v2Subagent({
          callID: 'call_3',
          sessionID: v2B,
          alias: 'fix-2',
          marker: v2SecretB,
        }),
      ],
      cursor: { next: 'older-page', previous: 'newer-page' },
    };
    const { input } = clientFor(() => page);
    const board = deferredBoard();
    board.registerLaunch({
      taskID: v2B,
      parentSessionID: v2Parent,
      agent: 'fixer',
      description: v2SecretB,
    });
    const authority = createAliasAuthority({
      input: input as never,
      board,
      hostFlavor: 'v2',
      timeoutMs: 200,
    });
    expect(await authority.prepareParent(v2Parent)).toEqual({ enabled: false });
    await expect(
      createTaskStatusTool({
        input: input as never,
        backgroundJobBoard: board,
        resolveCanonicalTaskRef: authority.resolveCanonical,
      }).task_status.execute({ sessionID: 'fix-1' }, {
        sessionID: v2Parent,
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow(/could not be verified/);
    expect(board.get(v2B)?.description).toBe(v2SecretB);
    expect(board.get(v2A)).toBeUndefined();
  });

  test('a fully paged v2 history keeps fix-1 on A and continues after fix-2', async () => {
    const older = {
      data: [
        v2Subagent({
          callID: 'call_2',
          sessionID: v2A,
          alias: 'fix-1',
          marker: v2SecretA,
        }),
      ],
      cursor: { next: null, previous: null },
    };
    const newest = {
      data: [
        { id: 'idle', type: 'idle', time: { created: 1 }, outcome: 'idle' },
        v2Subagent({
          callID: 'call_3',
          sessionID: v2B,
          alias: 'fix-2',
          marker: v2SecretB,
        }),
      ],
      cursor: { next: 'older-page', previous: null },
    };
    const { input } = clientFor(() => newest);
    input.client.session.messages = async (args: {
      query?: { cursor?: string };
    }) => (args.query?.cursor === 'older-page' ? older : newest);
    const board = deferredBoard();
    board.restoreRetainedSession({
      taskID: v2A,
      parentSessionID: v2Parent,
      agent: 'fixer',
      description: v2SecretA,
      state: 'completed',
      background: false,
      alias: v2A,
    });
    const authority = createAliasAuthority({
      input: input as never,
      board,
      hostFlavor: 'v2',
    });
    expect(await authority.prepareParent(v2Parent)).toEqual({ enabled: true });
    const output = await createTaskStatusTool({
      input: input as never,
      backgroundJobBoard: board,
      resolveCanonicalTaskRef: authority.resolveCanonical,
    }).task_status.execute({ sessionID: 'fix-1' }, {
      sessionID: v2Parent,
      agent: 'orchestrator',
    } as never);
    expect(String(output)).toContain(v2A);
    expect(String(output)).not.toContain(v2B);
    expect(String(output)).not.toContain(v2SecretB);
    expect(
      board.registerLaunch({
        taskID: 'ses_after_floor',
        parentSessionID: v2Parent,
        agent: 'fixer',
      }).alias,
    ).toBe('fix-3');
  });
});

describe('oracle audit fences', () => {
  test('an alias continuation is accepted only when an earlier pair names the same session', async () => {
    const first = taskPart({
      output: withRef(HOST, 'fix-1'),
      callID: 'call_first',
    });
    const continued = taskPart({
      output: withRef(HOST, 'fix-1'),
      callID: 'call_next',
    });
    const state = continued.parts[0]?.state as {
      input: Record<string, unknown>;
    };
    state.input.sessionID = 'fix-1';
    const { input } = clientFor([first, continued]);
    const board = deferredBoard();
    const authority = createAliasAuthority({ input: input as never, board });
    expect(await authority.prepareParent(PARENT)).toEqual({ enabled: true });
    expect(
      board.registerLaunch({
        taskID: 'ses_after',
        parentSessionID: PARENT,
        agent: 'fixer',
      }).alias,
    ).toBe('fix-2');

    const conflict = taskPart({
      output: withRef(CACHE, 'fix-1'),
      callID: 'call_bad',
    });
    const badState = conflict.parts[0]?.state as {
      input: Record<string, unknown>;
    };
    badState.input.sessionID = 'fix-1';
    const bad = clientFor([first, conflict]);
    const badBoard = deferredBoard();
    expect(
      await createAliasAuthority({
        input: bad.input as never,
        board: badBoard,
      }).prepareParent(PARENT),
    ).toEqual({ enabled: false });
  });

  test('the current running call is ignored and a different running call is not', async () => {
    const running = taskPart({
      output: '',
      callID: 'call_this',
      status: 'running',
    });
    const done = taskPart({
      output: withRef(HOST, 'fix-1'),
      callID: 'call_done',
    });
    const { input } = clientFor([running, done]);
    const board = deferredBoard();
    const authority = createAliasAuthority({ input: input as never, board });
    expect(await authority.prepareParent(PARENT, 'call_this')).toEqual({
      enabled: true,
    });
    const other = clientFor([
      taskPart({ output: '', callID: 'call_other', status: 'running' }),
      done,
    ]);
    expect(
      await createAliasAuthority({
        input: other.input as never,
        board: deferredBoard(),
      }).prepareParent(PARENT, 'call_this'),
    ).toEqual({ enabled: false });
    const looked = await authority.resolveCanonical(
      PARENT,
      'fix-1',
      'call_this',
    );
    expect(looked).toEqual({ kind: 'exact', taskID: HOST });
  });

  test('one unread cursor direction, an illegal cursor, or a missing message body does not enable', async () => {
    const newer = {
      data: [taskPart({ output: withRef(CACHE, 'fix-2'), callID: 'call_new' })],
      cursor: { next: 'older-page', previous: 'newer-page' },
    };
    const older = { data: [] };
    const { input } = clientFor(() => newer);
    input.client.session.messages = async (args: {
      query?: { cursor?: string };
    }) => (args.query?.cursor ? older : newer);
    const board = deferredBoard();
    expect(
      await createAliasAuthority({
        input: input as never,
        board,
        hostFlavor: 'v2',
      }).prepareParent(PARENT),
    ).toEqual({ enabled: false });
    expect(board.isNumberedAliasReady(PARENT)).toBe(false);

    const invalid = clientFor(() => ({
      data: [taskPart({ output: withRef(HOST, 'fix-1') })],
      cursor: { next: 1, previous: null },
    }));
    expect(
      await createAliasAuthority({
        input: invalid.input as never,
        board: deferredBoard(),
        hostFlavor: 'v2',
      }).prepareParent(PARENT),
    ).toEqual({ enabled: false });

    const missing = clientFor([
      { type: 'assistant', id: 'dropped' },
      taskPart({ output: withRef(HOST, 'fix-1') }),
    ]);
    expect(
      await createAliasAuthority({
        input: missing.input as never,
        board: deferredBoard(),
      }).prepareParent(PARENT),
    ).toEqual({ enabled: false });
  });

  test('an empty, unknown, or mixed cursor cannot select the first page alias', async () => {
    const pageB = taskPart({
      output: withRef(CACHE, 'fix-1'),
      callID: 'call_b',
    });
    const pageA = taskPart({
      output: withRef(HOST, 'fix-1'),
      callID: 'call_a',
    });
    const shapes = [
      { data: [pageB], cursor: {} },
      { data: [pageB], cursor: { older: 'older-page' } },
      { data: [pageB], page: { next: null, hasMore: true } },
      { data: [pageB], cursor: 'older-page', previous: 'newer-page' },
      { data: [pageB], cursor: 'older-page', next: 1 },
    ];
    for (const first of shapes) {
      const { input, prompt, promptAsync, abort } = clientFor(() => first);
      input.client.session.messages = async (args: {
        query?: { cursor?: string };
      }) => {
        if (args.query?.cursor === 'older-page') {
          return { data: [], cursor: { next: null, previous: null } };
        }
        if (args.query?.cursor === 'newer-page') {
          return { data: [pageA], cursor: { next: null, previous: null } };
        }
        return first;
      };
      const board = deferredBoard();
      board.registerLaunch({
        taskID: CACHE,
        parentSessionID: PARENT,
        agent: 'fixer',
        description: 'SECRET-B',
      });
      const authority = createAliasAuthority({
        input: input as never,
        board,
        hostFlavor: 'v2',
      });
      expect(await authority.prepareParent(PARENT)).toEqual({ enabled: false });
      const resolved = await authority.resolveCanonical(PARENT, 'fix-1');
      expect(resolved.kind).toBe('refused');
      if (resolved.kind === 'refused') {
        expect(resolved.reason).toContain('No action was sent');
      }
      expect(board.get(HOST)).toBeUndefined();
      expect(board.get(CACHE)?.description).toBe('SECRET-B');
      const shared = {
        input: input as never,
        backgroundJobBoard: board,
        resolveCanonicalTaskRef: authority.resolveCanonical,
        shouldManageSession: () => true,
      };
      const tools = {
        ...createCancelTaskTool(shared),
        ...createTaskReviveTool({
          ...shared,
          revivedRunTracker: {
            captureBaseline: async () => 'baseline',
          } as never,
        }),
      };
      const cancel = await tools.task_cancel.execute(
        { task_id: 'fix-1' },
        context as never,
      );
      expect(String(cancel)).toContain('No action was sent');
      expect(String(cancel)).not.toContain('SECRET-B');
      await expect(
        tools.task_revive.execute(
          { task_id: 'fix-1', prompt: 'again' },
          context as never,
        ),
      ).rejects.toThrow(/No action was sent/);
      expect(abort).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(promptAsync).not.toHaveBeenCalled();
    }
  });

  test('a pure string cursor remains valid without trusting inherited directions', async () => {
    for (const inherited of [undefined, { next: 1, previous: 'newer-page' }]) {
      const first = {
        data: [taskPart({ output: withRef(CACHE, 'fix-1'), callID: 'call_b' })],
        cursor: 'older-page',
      };
      if (inherited) Object.setPrototypeOf(first, inherited);
      const { input } = clientFor(() => first);
      const visited: Array<string | undefined> = [];
      input.client.session.messages = async (args: {
        query?: { cursor?: string };
      }) => {
        visited.push(args.query?.cursor);
        return args.query?.cursor === 'older-page'
          ? { data: [], cursor: { next: null, previous: null } }
          : first;
      };
      const board = deferredBoard();
      const authority = createAliasAuthority({
        input: input as never,
        board,
        hostFlavor: 'v2',
      });
      expect(await authority.prepareParent(PARENT)).toEqual({ enabled: true });
      expect(await authority.resolveCanonical(PARENT, 'fix-1')).toEqual({
        kind: 'exact',
        taskID: CACHE,
      });
      expect(visited).toEqual([
        undefined,
        'older-page',
        undefined,
        'older-page',
      ]);
      expect(await authority.resolveCanonical(PARENT, HOST)).toEqual({
        kind: 'exact',
        taskID: HOST,
      });
      expect(visited).toHaveLength(4);
      expect(
        board.registerLaunch({
          taskID: 'ses_next',
          parentSessionID: PARENT,
          agent: 'fixer',
        }).alias,
      ).toBe('fix-2');
    }
  });

  test('canonical lookup times out instead of hanging, and a late page does not enable', async () => {
    let release: ((value: unknown) => void) | undefined;
    const { input } = clientFor(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
      timeoutMs: 10,
    });
    const started = Date.now();
    const refused = await authority.resolveCanonical(PARENT, 'fix-1');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(refused.kind).toBe('refused');
    if (refused.kind === 'refused') {
      expect(refused.reason).toContain('No action was sent');
    }
    release?.({ data: [taskPart({ output: withRef(HOST, 'fix-9') })] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(board.isNumberedAliasReady(PARENT)).toBe(false);
    const retry = clientFor([taskPart({ output: withRef(HOST, 'fix-9') })]);
    expect(
      await createAliasAuthority({
        input: retry.input as never,
        board,
      }).resolveCanonical(PARENT, 'fix-9'),
    ).toEqual({ kind: 'exact', taskID: HOST });
  });

  test('stock v2 context numbers a complete history and refuses a compacted one', async () => {
    const output = withRef(HOST, 'fix-1');
    const raw = [
      {
        id: 'msg_user',
        type: 'user',
        time: { created: 1 },
        text: 'ask',
      },
      {
        id: 'msg_tool',
        type: 'assistant',
        agent: 'fixer',
        time: { created: 2 },
        content: [
          {
            type: 'tool',
            id: 'call_2',
            name: 'subagent',
            state: {
              status: 'completed',
              input: {
                agent: 'fixer',
                description: 'check',
                prompt: 'ask',
              },
              content: [{ type: 'text', text: output }],
            },
          },
        ],
      },
    ];
    const input = buildPluginInput({
      directory: '/tmp/omo-alias-authority',
      session: { context: async () => raw },
    } as never);
    const board = deferredBoard();
    const authority = createAliasAuthority({
      input: input as never,
      board,
      hostFlavor: 'v2',
    });
    expect(await authority.prepareParent(PARENT, 'call_this')).toEqual({
      enabled: true,
    });
    expect(
      await authority.resolveCanonical(PARENT, 'fix-1', 'call_this'),
    ).toEqual({
      kind: 'exact',
      taskID: HOST,
    });

    const compacted = buildPluginInput({
      directory: '/tmp/omo-alias-authority',
      session: {
        context: async () => [
          {
            id: 'cmp',
            type: 'compaction',
            status: 'completed',
            summary: 'earlier work',
            time: { created: 1 },
          },
          ...raw,
        ],
      },
    } as never);
    const compactedBoard = deferredBoard();
    const compactedAuthority = createAliasAuthority({
      input: compacted as never,
      board: compactedBoard,
      hostFlavor: 'v2',
    });
    expect(await compactedAuthority.prepareParent(PARENT)).toEqual({
      enabled: false,
    });
    expect(await compactedAuthority.resolveCanonical(PARENT, HOST)).toEqual({
      kind: 'exact',
      taskID: HOST,
    });
    expect(
      await compactedAuthority.resolveCanonical(PARENT, 'fix-1'),
    ).toMatchObject({
      kind: 'refused',
    });
  });

  test('root dispose during a held history read does not create pending work or abort', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'omo-alias-dispose-'));
    let release: ((value: unknown) => void) | undefined;
    const abort = mock(async () => ({}));
    const prompt = mock(async () => ({}));
    const client = {
      app: { log: async () => ({}) },
      session: {
        messages: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        abort,
        prompt,
        status: async () => ({ data: {} }),
        get: async () => ({ data: {} }),
      },
    };
    const hooks = await OhMyOpenCodeLite({
      client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    const pending = hooks['tool.execute.before']?.(
      {
        tool: 'task',
        sessionID: 'ses_parentdispose01',
        callID: 'call_held',
      },
      {
        args: {
          subagent_type: 'fixer',
          description: 'held launch',
          prompt: 'do not send',
          background: true,
        },
      },
    );
    await Promise.resolve();
    await hooks.event?.({
      event: {
        type: 'server.instance.disposed',
        properties: { directory: projectDir },
      },
    } as never);
    release?.({
      data: [taskPart({ output: withRef(HOST, 'fix-4'), callID: 'call_old' })],
    });
    await expect(pending).rejects.toThrow(/disposed/);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    await hooks['tool.execute.after']?.(
      {
        tool: 'task',
        sessionID: 'ses_parentdispose01',
        callID: 'call_held',
      },
      { output: withRef(HOST, 'fix-4'), metadata: {} },
    );
    await expect(
      hooks.tool?.task_status?.execute({ task_id: HOST }, {
        sessionID: 'ses_parentdispose01',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow(/disposed|Unknown task/);
  });
});

describe('native create degrade', () => {
  test('a failed prepare still creates and tells the model to use the exact session id', async () => {
    const board = deferredBoard();
    const args = {
      subagent_type: 'fixer',
      description: 'new work',
      prompt: 'do it',
      background: false,
    };
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'call_new' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard: board,
        pendingCallTracker: {
          add() {},
          take: () => undefined,
          pendingCallId: () => 'call_new',
        },
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        prepareAliasNumbering: async () => ({ enabled: false }),
      },
    );
    const created = board.registerLaunch({
      taskID: 'ses_created',
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'new work',
    });
    expect(created.alias).toBe('ses_created');
    const noted = noteExactSessionAlias(closed('ses_created'), 'ses_created');
    const marked = appendChildRefSuffix(noted, {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: created.alias,
      sessionID: 'ses_created',
    });
    expect(marked).toContain('Refer by the exact session id ses_created.');
    expect(marked).not.toContain('Call task_result');
    expect(marked.endsWith('-->') || marked.includes('slim-child-ref:v1')).toBe(
      true,
    );
  });
});
