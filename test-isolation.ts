import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// bun test shares one process: keep every test off the real user dirs.
const root = mkdtempSync(join(tmpdir(), 'omos-test-'));
process.env.XDG_DATA_HOME = join(root, 'data');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.OPENCODE_LOG_DIR = join(root, 'log');
// Takes precedence over XDG_CONFIG_HOME; tests that need it set their own.
delete process.env.OPENCODE_CONFIG_DIR;
// A signal or --bail skips this hook; that run's dir stays in tmpdir().
afterAll(() => rmSync(root, { recursive: true, force: true }));
