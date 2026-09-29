/**
 * Session-frozen hot-refresh integration: config changes resolve NEW child
 * profiles and the sidebar projection without rebuilding agent definitions or
 * reloading the host registry (AGENTS.md: system prompts and tool sets stay
 * frozen for a session's lifetime).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { readTuiSnapshot } from '../tui-state';
import { createV2Setup } from './setup';
import { makeTestEnv, type TestEnv } from './test-fixtures';
import type { V2Context, V2SessionContextEvent } from './types';

const CHEAP_PLAIN = { explorer: { model: 'openai/gpt-5-mini' } };
const CHEAP_TEMP = {
  explorer: { model: 'openai/gpt-5-mini', temperature: 0.2 },
};
const STRONG_PLAIN = { explorer: { model: 'anthropic/claude-sonnet-4-5' } };
const STRONG_THINKING = {
  explorer: {
    model: 'anthropic/claude-sonnet-4-5',
    options: { thinking: { type: 'enabled' } },
  },
};
/** Both presets present; only the selected `preset` key differs. */
const hot = (preset: string) => ({
  preset,
  presets: { cheap: CHEAP_TEMP, strong: STRONG_THINKING },
});
const plain = (preset: string) => ({
  preset,
  presets: { cheap: CHEAP_PLAIN, strong: STRONG_PLAIN },
});

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2-hot');
  process.env.XDG_DATA_HOME = path.join(env.configHome, 'data');
  process.env.XDG_CONFIG_HOME = path.join(env.configHome, 'xdg-config');
  process.env.XDG_CACHE_HOME = path.join(env.configHome, 'xdg-cache');
  process.env.OPENCODE_LOG_DIR = path.join(env.configHome, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
});

afterEach(() => {
  env.restore();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await wait(10);
  }
}

interface Harness {
  cleanup: () => Promise<void>;
  pushEvent: (event: unknown) => void;
  invokePrompt: (event: Record<string, unknown>) => Promise<void>;
  switchCalls: Array<{ sessionID: string; model: { id: string } }>;
  contextHandler: ((event: V2SessionContextEvent) => Promise<void>) | undefined;
  agentTransformCalls: () => number;
  agentReloadCalls: () => number;
}

/** Live sidebar model projection for the fixture project dir. */
const sidebarModels = () => readTuiSnapshot(env.projectDir).agentModels;

async function bootHarness(): Promise<Harness> {
  const reg = () => ({ dispose() {} });
  /** Transform stub: apply `draft`, then hand back a disposable. */
  const transformWith =
    (draft: unknown) => async (cb: (draft: unknown) => void) => {
      cb(draft);
      return reg();
    };
  const queue: unknown[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const iterator = {
    next: () =>
      new Promise<IteratorResult<unknown>>((resolve) => {
        if (closed) {
          resolve({ value: undefined, done: true });
          return;
        }
        const deliver = () => {
          if (closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          if (queue.length > 0) {
            resolve({ value: queue.shift(), done: false });
          } else {
            wake = deliver;
          }
        };
        deliver();
      }),
    return: () => {
      closed = true;
      wake?.();
      wake = undefined;
      return Promise.resolve({ value: undefined, done: true }) as Promise<
        IteratorResult<unknown>
      >;
    },
  };

  const switchCalls: Array<{ sessionID: string; model: { id: string } }> = [];
  let agentTransformCalls = 0;
  let agentReloadCalls = 0;
  let contextHandler:
    | ((event: V2SessionContextEvent) => Promise<void>)
    | undefined;
  const promptHandlers: Array<
    (event: Record<string, unknown>) => Promise<void>
  > = [];

  const ctx = {
    app: { name: 'opencode', version: 'v2-hot-refresh-test' },
    options: {},
    location: {
      directory: env.projectDir,
      project: {
        id: 'proj_hot',
        directory: env.projectDir,
        canonical: env.projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        agentTransformCalls += 1;
        await transformWith({
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: () => {},
          remove: () => {},
        })(cb);
      },
      reload: async () => {
        agentReloadCalls += 1;
      },
      list: async () => [],
    },
    tool: {
      transform: transformWith({ add: () => {} }),
      hook: async () => reg(),
    },
    command: {
      transform: transformWith({ add: () => {} }),
      list: async () => [],
    },
    session: {
      hook: async (
        name: string,
        cb: (event: V2SessionContextEvent) => Promise<void>,
      ) => {
        if (name === 'context') contextHandler = cb;
        if (name === 'prompt') {
          promptHandlers.push(
            cb as unknown as (event: Record<string, unknown>) => Promise<void>,
          );
        }
        return reg();
      },
      // Identity source for the awaited prompt-path capture: children carry
      // a parentID + plugin agent; root/foreign sessions are recognizable.
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        ...(sessionID.startsWith('root') ? {} : { parentID: 'parent-1' }),
        agent: sessionID.startsWith('foreign') ? 'build' : 'explorer',
      }),
      switchModel: async (input: {
        sessionID: string;
        model: { id: string };
      }) => {
        switchCalls.push(input);
      },
      update: async () => ({}),
    },
    mcp: {
      transform: transformWith({
        list: () => [],
        get: () => undefined,
        set: () => {},
        update: () => {},
        remove: () => {},
      }),
      reload: async () => {},
    },
    event: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
  } as unknown as V2Context;

  const cleanup = await createV2Setup()(ctx);

  return {
    cleanup: () => cleanup(),
    pushEvent: (event: unknown) => {
      if (closed) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    invokePrompt: async (event: Record<string, unknown>) => {
      for (const handler of promptHandlers) {
        await handler(event);
      }
    },
    switchCalls,
    get contextHandler() {
      return contextHandler;
    },
    agentTransformCalls: () => agentTransformCalls,
    agentReloadCalls: () => agentReloadCalls,
  };
}

/** Boots the harness, runs `body`, and always cleans it up. */
async function withHarness(
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await bootHarness();
  try {
    await body(harness);
  } finally {
    await harness.cleanup();
  }
}

function createChildEvent(sessionID: string): Record<string, unknown> {
  return {
    type: 'session.created',
    data: { sessionID, parentID: 'parent-1', agent: 'explorer' },
  };
}

/** Push probe children until one captures a seeded profile. */
async function captureFirstChild(
  harness: Harness,
  idPrefix: string,
): Promise<string> {
  for (let index = 0; index < 60; index += 1) {
    const id = `${idPrefix}-${index}`;
    harness.pushEvent(createChildEvent(id));
    await wait(15);
    if (harness.switchCalls.some((call) => call.sessionID === id)) {
      return id;
    }
  }
  throw new Error('no child captured a profile');
}

describe('v2 session-frozen hot refresh', () => {
  test('config edit refreshes new-child profiles and sidebar without touching frozen surfaces', async () => {
    env.writeUserConfig(hot('cheap'));

    await withHarness(async (harness) => {
      expect(sidebarModels().explorer).toBe('openai/gpt-5-mini');

      // A child created before the edit captures the initial profile.
      const firstChild = await captureFirstChild(harness, 'first');
      const firstSwitch = harness.switchCalls.find(
        (call) => call.sessionID === firstChild,
      );
      expect(firstSwitch?.model.id).toBe('gpt-5-mini');

      // Root and foreign-agent sessions mixed into the same event stream stay
      // untouched while the first child captures its profile (isolated
      // unit coverage lives in runtime-profiles.test.ts).
      harness.pushEvent({
        type: 'session.created',
        data: { sessionID: 'root-1', agent: 'explorer' },
      });
      harness.pushEvent({
        type: 'session.created',
        data: { sessionID: 'foreign-1', parentID: 'parent-1', agent: 'build' },
      });
      await wait(80);
      expect(
        harness.switchCalls.some(
          (call) =>
            call.sessionID === 'root-1' || call.sessionID === 'foreign-1',
        ),
      ).toBe(false);

      // Manual config edit: the watcher refreshes profiles + sidebar only.
      env.writeUserConfig(hot('strong'));
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // The existing child is NOT re-switched...
      const switchCountBefore = harness.switchCalls.filter(
        (call) => call.sessionID === firstChild,
      ).length;
      harness.pushEvent(createChildEvent(firstChild));
      await wait(60);
      expect(
        harness.switchCalls.filter((call) => call.sessionID === firstChild),
      ).toHaveLength(switchCountBefore);

      // ...while a NEW child gets the fresh profile/options.
      const secondChild = await captureFirstChild(harness, 'second');
      const secondSwitch = harness.switchCalls.find(
        (call) => call.sessionID === secondChild,
      );
      expect(secondSwitch?.model.id).toBe('claude-sonnet-4-5');

      const contextHandler = harness.contextHandler;
      expect(contextHandler).toBeDefined();
      const options: Record<string, unknown> = {};
      await contextHandler?.({
        sessionID: firstChild,
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      // First child applies its frozen temperature, not the new profile.
      expect(options.temperature).toBe(0.2);
      expect(options.thinking).toBeUndefined();

      await contextHandler?.({
        sessionID: secondChild,
        agent: 'explorer',
        model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect((options as { thinking?: unknown }).thinking).toEqual({
        type: 'enabled',
      });
      expect(options.temperature).toBeUndefined();

      // Frozen surfaces: agents registered ONCE and never reloaded globally.
      expect(harness.agentTransformCalls()).toBe(1);
      expect(harness.agentReloadCalls()).toBe(0);
    });
  }, 20_000);

  test('disposal stops watching: no refresh or child capture afterwards', async () => {
    env.writeUserConfig(plain('cheap'));
    const harness = await bootHarness();
    await captureFirstChild(harness, 'pre');

    await harness.cleanup();
    const switchCount = harness.switchCalls.length;

    env.writeUserConfig(plain('strong'));
    await wait(400);

    harness.pushEvent(createChildEvent('post-dispose-child'));
    await wait(100);

    expect(harness.switchCalls).toHaveLength(switchCount);
  }, 20_000);

  test('first prompt captures and switches before session.created; a refresh keeps the captured profile', async () => {
    env.writeUserConfig(hot('cheap'));

    await withHarness(async (harness) => {
      // The host fires the prompt hook BEFORE any session.created event for
      // the child: the awaited request-path capture must still switch the
      // model and freeze the profile before the first request.
      await harness.invokePrompt({
        sessionID: 'race-child',
        messageID: 'msg_1',
        prompt: { text: 'start' },
      });
      expect(harness.switchCalls).toEqual([
        {
          sessionID: 'race-child',
          model: { providerID: 'openai', id: 'gpt-5-mini' },
        },
      ]);

      const options: Record<string, unknown> = {};
      await harness.contextHandler?.({
        sessionID: 'race-child',
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect(options.temperature).toBe(0.2);

      // A config refresh replaces the table for NEW children only.
      env.writeUserConfig(hot('strong'));
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // Replayed prompt + the (delayed) session.created event for the
      // existing child must neither re-switch nor re-freeze it.
      await harness.invokePrompt({
        sessionID: 'race-child',
        messageID: 'msg_2',
        prompt: { text: 'more' },
      });
      harness.pushEvent(createChildEvent('race-child'));
      await wait(80);
      expect(
        harness.switchCalls.filter((call) => call.sessionID === 'race-child'),
      ).toHaveLength(1);

      const optionsAfter: Record<string, unknown> = {};
      await harness.contextHandler?.({
        sessionID: 'race-child',
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options: optionsAfter,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect(optionsAfter.temperature).toBe(0.2);
      expect(optionsAfter.thinking).toBeUndefined();

      // A child first seen after the refresh gets the fresh profile.
      const secondChild = await captureFirstChild(harness, 'race-second');
      const secondSwitch = harness.switchCalls.find(
        (call) => call.sessionID === secondChild,
      );
      expect(secondSwitch?.model.id).toBe('claude-sonnet-4-5');
    });
  }, 20_000);
});
