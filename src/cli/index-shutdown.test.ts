import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI marketplace shutdown', () => {
  test.each([
    { outcome: 'success', exitCode: 0 },
    { outcome: 'error', exitCode: 1 },
    { outcome: 'rejection', exitCode: 1 },
  ])(
    '$outcome exits naturally with status $exitCode',
    ({ outcome, exitCode }) => {
      const root = mkdtempSync(join(tmpdir(), 'cli-shutdown-'));
      const preload = join(root, 'preload.ts');

      try {
        // Run the real entrypoint in isolation so module mocks and exit state
        // cannot affect other tests. Pending work must survive command completion.
        writeFileSync(
          preload,
          `import { mock } from 'bun:test';
const exit = process.exit;
process.exit = (code) => {
  console.error('FORCED_EXIT');
  exit(code);
};
mock.module(${JSON.stringify(join(import.meta.dir, 'marketplace.ts'))}, () => ({
  marketplaceCommand: async (args) => {
    console.log('ARGS:' + JSON.stringify(args));
    setTimeout(() => console.log('DRAINED'), 20);
    if (${JSON.stringify(outcome)} === 'rejection') {
      throw new Error('unexpected shutdown test failure');
    }
    return ${exitCode};
  },
}));
`,
        );

        const result = spawnSync(
          process.execPath,
          [
            '--preload',
            preload,
            join(import.meta.dir, 'index.ts'),
            'marketplace',
            'list',
          ],
          {
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, OPENCODE_CONFIG_DIR: root },
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(exitCode);
        expect(result.stdout).toContain('ARGS:["list"]');
        expect(result.stdout).toContain('DRAINED');
        expect(result.stderr).not.toContain('FORCED_EXIT');
        if (outcome === 'rejection') {
          expect(result.stderr).toContain('Fatal error:');
          expect(result.stderr).toContain('unexpected shutdown test failure');
        } else {
          expect(result.stderr).toBe('');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
