import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OhMyOpenCodeLite } from '../index';
import { MarketplaceStore } from '../marketplace/store';
import { readTuiSnapshot } from '../tui-state';
import { makeTestEnv, type TestEnv } from './test-fixtures';

const DEEPSEEK_CHEAP = {
  explorer: {
    model: 'opencode-go/deepseek-v4.1-flash',
    temperature: 0.2,
    options: { thinking: { type: 'enabled' } },
  },
};
const SONNET_STRONG = {
  explorer: { model: 'anthropic/claude-sonnet-4-5', variant: 'thinking' },
};
/** Both presets present; only the selected `preset` key differs. */
const withPreset = (preset: string) => ({
  preset,
  presets: { cheap: DEEPSEEK_CHEAP, strong: SONNET_STRONG },
});
const CHEAP_DEEPSEEK = {
  preset: 'cheap',
  presets: {
    cheap: { explorer: { model: 'opencode-go/deepseek-v4.1-flash' } },
  },
};

/** Live sidebar projections for the fixture project dir. */
const sidebarModels = () => readTuiSnapshot(env.projectDir).agentModels;

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2cr');
});

afterEach(() => {
  env.restore();
});

type ProfilesHook = (options?: { allowInvalidFallback?: boolean }) => Promise<
  | {
      ok: true;
      profiles: Record<
        string,
        {
          model?: { providerID: string; id: string; variant?: string };
          temperature?: number;
          providerOptions?: Record<string, unknown>;
          sidebarModel: string;
        }
      >;
      projection: {
        agentModels: Record<string, string>;
        agentVariants: Record<string, string>;
      };
    }
  | { ok: false; reason: string }
>;

function createPluginClient() {
  const noop = async () => ({});
  const session = new Proxy({}, { get: () => noop }) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : new Proxy({}, { get: () => noop }),
    },
  );
}

async function bootFactory() {
  const hooks = await OhMyOpenCodeLite({
    client: createPluginClient(),
    directory: env.projectDir,
    worktree: env.projectDir,
    serverUrl: new URL('http://127.0.0.1:4096'),
  } as never);
  // The host calls the config hook once at init; mirror that so the initial
  // registry/tui-state snapshot exists.
  await hooks.config?.({} as never);
  const refresh = (hooks as unknown as { 'v2.refreshProfiles'?: ProfilesHook })[
    'v2.refreshProfiles'
  ];
  if (!refresh) throw new Error('v2.refreshProfiles hook missing');
  return { hooks, refresh };
}

/** Boots the factory, runs `body`, and always disposes the hooks. */
async function withFactory(
  body: (fac: Awaited<ReturnType<typeof bootFactory>>) => Promise<void>,
): Promise<void> {
  const fac = await bootFactory();
  try {
    await body(fac);
  } finally {
    await fac.hooks.dispose?.();
  }
}

describe('v2 profile refresh hook', () => {
  test('re-reads the config, resolves profiles, and rewrites the sidebar model entries', async () => {
    env.writeUserConfig(withPreset('cheap'));

    await withFactory(async ({ refresh }) => {
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');

      // Preset manager Save & Apply rewrites the file; the refresh hook is
      // what the watcher / direct call runs afterwards.
      env.writeUserConfig(withPreset('strong'));
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      expect(refreshed.profiles.explorer?.model).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4-5',
        variant: 'thinking',
      });
      expect(refreshed.profiles.explorer?.sidebarModel).toBe(
        'anthropic/claude-sonnet-4-5',
      );
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');
      expect(readTuiSnapshot(env.projectDir).agentVariants.explorer).toBe(
        'thinking',
      );
    });
  });

  test('resolves temperature and provider options for captured profiles', async () => {
    env.writeUserConfig({
      preset: 'cheap',
      presets: {
        cheap: {
          explorer: {
            model: 'opencode-go/deepseek-v4.1-flash',
            temperature: 0.25,
            options: { thinking: { type: 'enabled', budgetTokens: 4096 } },
          },
        },
      },
    });

    await withFactory(async ({ refresh }) => {
      const refreshed = await refresh();
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      expect(refreshed.profiles.explorer?.temperature).toBe(0.25);
      expect(refreshed.profiles.explorer?.providerOptions).toEqual({
        thinking: { type: 'enabled', budgetTokens: 4096 },
      });
    });
  });

  test('picks up manual project-config edits', async () => {
    env.writeUserConfig({});
    env.writeProjectConfig({
      preset: 'project-local',
      presets: {
        'project-local': { oracle: { model: 'openai/gpt-5-mini' } },
      },
    });

    await withFactory(async ({ refresh }) => {
      expect(sidebarModels().oracle).toBe('openai/gpt-5-mini');

      env.writeProjectConfig({
        preset: 'project-local',
        presets: {
          'project-local': { oracle: { model: 'openai/o3' } },
        },
      });
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      expect(refreshed.profiles.oracle?.model).toEqual({
        providerID: 'openai',
        id: 'o3',
      });
      expect(sidebarModels().oracle).toBe('openai/o3');
    });
  });

  test('keeps host opencode.json agent overrides across a refresh', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);
    const hooks = await OhMyOpenCodeLite({
      client: createPluginClient(),
      directory: env.projectDir,
      worktree: env.projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      // The host layer wins the shallow merge (same as at init).
      await hooks.config?.({
        agent: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
      } as never);
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');

      const refresh = (
        hooks as unknown as { 'v2.refreshProfiles'?: ProfilesHook }
      )['v2.refreshProfiles'];
      const refreshed = await refresh?.();

      expect(refreshed?.ok).toBe(true);
      if (!refreshed?.ok) throw new Error(refreshed?.reason);
      expect(refreshed.profiles.explorer?.model).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4-5',
      });
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('does not rebuild agent definitions or mutate session-frozen surfaces', async () => {
    env.writeUserConfig({
      preset: 'cheap',
      presets: {
        cheap: {
          explorer: {
            model: 'opencode-go/deepseek-v4.1-flash',
            prompt: 'You are a custom explorer.',
            permission: { edit: 'deny' },
          },
        },
      },
    });

    await withFactory(async ({ hooks, refresh }) => {
      const beforeAgentDefs = JSON.stringify(hooks.agent?.explorer);
      env.writeUserConfig({
        preset: 'cheap',
        presets: {
          cheap: {
            explorer: {
              model: 'anthropic/claude-sonnet-4-5',
              prompt: 'You are a DIFFERENT explorer.',
              permission: { edit: 'allow' },
            },
          },
        },
      });
      await refresh();

      // Prompt/permission surfaces stay frozen: the refresh only resolves
      // the inference profile (the v2 adapter never re-registers agents).
      expect(JSON.stringify(hooks.agent?.explorer)).toBe(beforeAgentDefs);
    });
  });

  test('malformed JSON is a hard refresh failure: last-good sidebar (and profiles) retained', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async ({ refresh }) => {
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');

      fs.writeFileSync(env.userConfigPath, '{ not json');
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(false);
      if (refreshed.ok) throw new Error('expected a hard failure');
      expect(refreshed.reason).toContain('invalid-json');
      // No swap: the last-known-good sidebar model entry survives, and no
      // profiles were reported (the caller swaps only on ok).
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
    });
  });

  test('startup can seed fallback profiles before any last-good table exists', async () => {
    fs.writeFileSync(env.userConfigPath, '{ not json');
    const { refresh } = await bootFactory();

    const result = await refresh({ allowInvalidFallback: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.profiles).length).toBeGreaterThan(0);
      expect(result.profiles.explorer).toBeDefined();
    }
  });

  test('schema-invalid config is a hard refresh failure: last-good sidebar retained', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async ({ refresh }) => {
      env.writeUserConfig({
        preset: 'cheap',
        presets: {
          // `temperature` must be a number: schema rejection.
          cheap: {
            explorer: { model: 'openai/gpt-5-mini', temperature: 'hot' },
          },
        },
      });
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(false);
      if (refreshed.ok) throw new Error('expected a hard failure');
      expect(refreshed.reason).toContain('invalid-schema');
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
    });
  });

  test('warning-only kinds (missing preset, deprecated key) do not fail the refresh', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async ({ refresh }) => {
      env.writeUserConfig({
        preset: 'ghost', // missing-preset warning, not a hard failure
        tmux: { enabled: true }, // deprecated-key warning, ignored
        presets: {
          cheap: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
        },
      });
      const refreshed = await refresh();

      // The selected preset is missing (defaults apply) and a deprecated key
      // was ignored — both are warnings, not malformed config.
      expect(refreshed.ok).toBe(true);
    });
  });

  test('refresh preserves marketplace agents in the sidebar roster', async () => {
    // Isolate the marketplace store for this test (test-isolation also sets
    // XDG_DATA_HOME, but a per-test root avoids cross-test package leakage).
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-data-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
        manifest: {
          schemaVersion: 2,
          id: 'team/market',
          version: '1.0.0',
          displayName: 'market-agent',
          description: 'Marketplace agent for refresh regression',
          agentName: 'market-agent',
          prompt: 'Marketplace prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: { source: 'explicit', candidates: ['provider/package'] },
          routing: {
            description: 'Marketplace lane',
            when: 'Marketplace task',
            keywords: ['marketplace'],
          },
        },
      } as never);
      env.writeUserConfig({
        preset: 'market',
        presets: { market: { marketplace: { agents: ['team/market'] } } },
      });

      await withFactory(async ({ refresh }) => {
        // Registry path wrote the full roster (core + marketplace).
        expect(sidebarModels()['market-agent']).toBeDefined();

        const refreshed = await refresh();
        expect(refreshed.ok).toBe(true);

        // The refresh must not clobber the marketplace roster entry.
        expect(sidebarModels()['market-agent']).toBeDefined();
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
