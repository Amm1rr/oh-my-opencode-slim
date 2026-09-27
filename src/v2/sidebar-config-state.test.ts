/**
 * Sidebar preset-label invalidation wiring (finding D).
 *
 * The v2 sidebar registers a per-directory config-change listener and
 * re-reads `readConfigState` on every 1s poll, so the preset label follows:
 * - bare `/preset` / `/preset <name>` / sidebar Apply/Save (coordinator
 *   notification), and
 * - manual config edits (poll re-read), and
 * - a failed switch never notifies and therefore never changes the label.
 *
 * The Solid slot render cannot be evaluated without a host renderer, so this
 * exercises the observable data path: listener registration/notification,
 * the config-state read, and disposal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import tuiPlugin, { readConfigState, retainLastGoodConfigState } from '../tui';
import { notifyConfigChanged } from './config-change-coordinator';
import { makeTestEnv, type TestEnv } from './test-fixtures';

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2sb');
  process.env.XDG_DATA_HOME = path.join(env.configHome, 'data');
  process.env.OPENCODE_LOG_DIR = path.join(env.configHome, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
});

afterEach(() => {
  env.restore();
});

function writeConfig(preset: string | undefined): void {
  env.writeUserConfig({
    ...(preset ? { preset } : {}),
    presets: {
      alpha: { explorer: { model: 'openai/gpt-5-mini' } },
      beta: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
    },
  });
}

function makeContext() {
  return {
    location: { directory: env.projectDir },
    renderer: { requestRender: () => {} },
    theme: {
      text: { default: '#f0f0f0', subdued: '#8a8a8a' },
      background: { default: '#101010' },
      border: { default: '#3a3a3a' },
    },
    ui: {
      slot: () => () => {},
      router: { current: () => ({ type: 'home' }) },
    },
  };
}

type V2Context = Parameters<typeof tuiPlugin.setup>[0];

describe('v2 sidebar config-state invalidation', () => {
  test('coordinator notification reaches the sidebar listener and reports success', async () => {
    writeConfig('alpha');
    const ctx = makeContext();
    const cleanup = await tuiPlugin.setup(ctx as unknown as V2Context);

    try {
      // The sidebar listener re-reads the config-backed state (label source).
      const result = await notifyConfigChanged(env.projectDir, '/preset');
      expect(result).toEqual({ ok: true });
    } finally {
      cleanup?.();
    }
  });

  test('manual edits change the config state the poll and label read', () => {
    writeConfig('alpha');
    expect(readConfigState(env.projectDir).presetName).toBe('alpha');

    // Simulates the manual-edit case: nothing notifies, the 1s poll re-reads.
    writeConfig('beta');
    expect(readConfigState(env.projectDir).presetName).toBe('beta');

    const lastGood = readConfigState(env.projectDir);
    // A broken config surfaces as invalid while the sidebar keeps the
    // last-known-good label and layout instead of adopting loader defaults.
    fs.writeFileSync(env.userConfigPath, '{ not json');
    expect(
      retainLastGoodConfigState(lastGood, readConfigState(env.projectDir)),
    ).toEqual({
      configInvalid: true,
      compactSidebar: lastGood.compactSidebar,
      presetName: 'beta',
    });

    writeConfig('alpha');
    expect(
      retainLastGoodConfigState(lastGood, readConfigState(env.projectDir)),
    ).toEqual({
      configInvalid: false,
      compactSidebar: lastGood.compactSidebar,
      presetName: 'alpha',
    });
  });

  test('disposal unregisters the listener: later notifications fail honestly', async () => {
    writeConfig('alpha');
    const ctx = makeContext();
    const cleanup = await tuiPlugin.setup(ctx as unknown as V2Context);
    const before = await notifyConfigChanged(env.projectDir, '/preset');
    expect(before).toEqual({ ok: true });

    cleanup?.();

    const after = await notifyConfigChanged(env.projectDir, '/preset');
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.reason).toContain('no live config-change listener');
    }
  });

  test('directory changes rebind the coordinator listener', async () => {
    writeConfig('alpha');
    const secondProject = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omos-v2sb-proj-next-'),
    );
    const ctx = makeContext();
    const mutable = ctx as typeof ctx & {
      location: { directory: string };
    };
    const cleanup = await tuiPlugin.setup(mutable as unknown as V2Context);

    try {
      mutable.location.directory = secondProject;
      await Bun.sleep(1_100);

      expect(
        (await notifyConfigChanged(env.projectDir, 'old-directory')).ok,
      ).toBe(false);
      expect(await notifyConfigChanged(secondProject, 'new-directory')).toEqual(
        { ok: true },
      );
    } finally {
      cleanup?.();
      fs.rmSync(secondProject, { recursive: true, force: true });
    }
  });
});
