import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OhMyOpenCodeLite as plugin } from '../index';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';

type ToolExecute = (
  args: Record<string, unknown>,
  context: { sessionID: string; agent?: string },
) => Promise<unknown>;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function loadPlugin(session: Record<string, unknown>) {
  const projectDir = await mkdtemp(join(tmpdir(), 'omo-revive-dispose-'));
  const previous = { ...process.env };
  process.env = {
    ...previous,
    OPENCODE_CONFIG_DIR: projectDir,
    XDG_DATA_HOME: `${projectDir}/data`,
    XDG_CACHE_HOME: `${projectDir}/cache`,
    OPENCODE_LOG_DIR: `${projectDir}/logs`,
  };
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  await Bun.write(
    `${projectDir}/oh-my-opencode-slim.json`,
    JSON.stringify({ companion: { enabled: false } }),
  );
  const hooks = await plugin({
    client: { app: { log: async () => ({}) }, session },
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL('http://127.0.0.1:4098'),
  } as never);
  await hooks['chat.message']?.(
    { sessionID: PARENT, agent: 'orchestrator' } as never,
    {} as never,
  );
  return {
    hooks,
    projectDir,
    async cleanup() {
      process.env = previous;
      await rm(projectDir, { recursive: true, force: true });
    },
  };
}

const transcript = {
  data: [
    {
      info: {
        id: 'msg_user',
        role: 'user',
        agent: 'fixer',
        time: { created: 10 },
      },
      parts: [{ type: 'text', text: 'ask' }],
    },
    {
      info: {
        id: 'msg_turn',
        role: 'assistant',
        finish: 'stop',
        time: { created: 11, completed: 12 },
      },
      parts: [{ type: 'text', text: 'done' }],
    },
  ],
};

test('direct dispose during a paused revive read sends no prompt and imports nothing', async () => {
  const seen = deferred<void>();
  const read = deferred<{ data: Record<string, unknown> }>();
  const prompts: unknown[] = [];
  const loaded = await loadPlugin({
    get: async (args: { path?: { id?: string } }) => {
      if (args.path?.id !== CHILD) return { error: { message: 'NotFound' } };
      seen.resolve();
      return read.promise;
    },
    messages: async () => transcript,
    status: async () => ({ data: {} }),
    promptAsync: async (args: unknown) => {
      prompts.push(args);
      return {};
    },
  });
  try {
    const revive = (
      loaded.hooks as { tool?: { task_revive?: { execute: ToolExecute } } }
    ).tool?.task_revive;
    expect(revive).toBeDefined();
    const pending = revive?.execute(
      { task_id: CHILD, prompt: 'continue' },
      { sessionID: PARENT, agent: 'orchestrator' },
    );
    await seen.promise;
    await loaded.hooks.dispose?.();
    read.resolve({
      data: {
        id: CHILD,
        parentID: PARENT,
        agent: 'fixer',
        time: { created: 9 },
      },
    });
    await expect(pending).rejects.toThrow(
      /disposed|retired|not found|could not/i,
    );
    expect(prompts).toHaveLength(0);
    await expect(
      (
        loaded.hooks as { tool?: { task_status?: { execute: ToolExecute } } }
      ).tool?.task_status?.execute(
        { task_id: CHILD },
        { sessionID: PARENT, agent: 'orchestrator' },
      ),
    ).rejects.toThrow(/Unknown task ID or alias/);
  } finally {
    await loaded.cleanup();
  }
});

test('an accepted revive write that settles after dispose is not tracked', async () => {
  const prompts: unknown[] = [];
  const written = deferred<void>();
  const response = deferred<Record<string, unknown>>();
  const loaded = await loadPlugin({
    get: async (args: { path?: { id?: string } }) => {
      if (args.path?.id !== CHILD) return { error: { message: 'NotFound' } };
      return {
        data: {
          id: CHILD,
          parentID: PARENT,
          agent: 'fixer',
          time: { created: 9 },
        },
      };
    },
    messages: async () => transcript,
    status: async () => ({ data: {} }),
    promptAsync: async (args: unknown) => {
      prompts.push(args);
      written.resolve();
      return response.promise;
    },
  });
  try {
    const revive = (
      loaded.hooks as { tool?: { task_revive?: { execute: ToolExecute } } }
    ).tool?.task_revive;
    const pending = revive?.execute(
      { task_id: CHILD, prompt: 'continue' },
      { sessionID: PARENT, agent: 'orchestrator' },
    );
    await written.promise;
    expect(prompts).toHaveLength(1);
    await loaded.hooks.dispose?.();
    response.resolve({});
    let receipt = '';
    try {
      await pending;
    } catch (error) {
      receipt = error instanceof Error ? error.message : String(error);
    }
    expect(receipt).toContain('accepted');
    expect(receipt).toContain('retired');
    expect(receipt).not.toContain('NOT sent');
    const status = String(
      await (
        loaded.hooks as { tool?: { task_status?: { execute: ToolExecute } } }
      ).tool?.task_status?.execute(
        { task_id: CHILD },
        { sessionID: PARENT, agent: 'orchestrator' },
      ),
    );
    expect(status).toContain('state: completed');
    expect(status).not.toContain('state: running');
    expect(status).not.toContain('state: reconciled');
  } finally {
    await loaded.cleanup();
  }
});

afterEach(() => {});
