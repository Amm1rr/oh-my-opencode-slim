/**
 * Shared fixtures for the v2 config-watch / config-refresh suites: isolated
 * temp dirs, JSON config writers, and polling waits (established conventions:
 * `mkdtempSync` under `os.tmpdir()`, `OPENCODE_CONFIG_DIR` pointed at the
 * config home, full `process.env` restore on teardown).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TestEnv {
  /** Temp dir backing `OPENCODE_CONFIG_DIR`. */
  configHome: string;
  /** Temp project directory handed to the watchers/loaders. */
  projectDir: string;
  /** Live user-config path (honors a test's own `OPENCODE_CONFIG_DIR`). */
  readonly userConfigPath: string;
  writeUserConfig(content: Record<string, unknown>): void;
  writeProjectConfig(content: Record<string, unknown>): void;
  /** Restore the pre-test env and remove both temp dirs. */
  restore(): void;
}

/** Fresh temp dirs + isolated env for one test (call from `beforeEach`). */
export function makeTestEnv(prefix: string): TestEnv {
  const originalEnv = { ...process.env };
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-cfg-`));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-proj-`));
  process.env.OPENCODE_CONFIG_DIR = configHome;
  const projectConfigDir = path.join(projectDir, '.opencode');
  const writeJson = (file: string, content: Record<string, unknown>) =>
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return {
    configHome,
    projectDir,
    get userConfigPath() {
      return path.join(
        process.env.OPENCODE_CONFIG_DIR ?? '',
        'oh-my-opencode-slim.json',
      );
    },
    writeUserConfig(content) {
      writeJson(path.join(configHome, 'oh-my-opencode-slim.json'), content);
    },
    writeProjectConfig(content) {
      fs.mkdirSync(projectConfigDir, { recursive: true });
      writeJson(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        content,
      );
    },
    restore() {
      process.env = originalEnv;
      fs.rmSync(configHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

/** Resolves after `ms` milliseconds. */
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` every 10ms until true or `timeoutMs` elapses. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await wait(10);
  }
}
