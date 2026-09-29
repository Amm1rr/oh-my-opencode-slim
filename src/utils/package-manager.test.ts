import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isOnPath, resolvePackageInstallCommand } from './package-manager';

const createdDirs: string[] = [];

function dirWith(files: string[], mode = 0o755): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-test-'));
  createdDirs.push(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    writeFileSync(filePath, '');
    chmodSync(filePath, mode);
  }
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolvePackageInstallCommand', () => {
  test('re-execs the Bun runtime as bun, without needing PATH', () => {
    const result = resolvePackageInstallCommand({
      isBunRuntime: true,
      execPath: '/home/u/.opencode/bin/opencode',
      pathEnv: '',
    });
    expect(result?.command).toEqual([
      '/home/u/.opencode/bin/opencode',
      'install',
      '--ignore-scripts',
    ]);
    expect(result?.env?.BUN_BE_BUN).toBe('1');
  });

  test.skipIf(process.platform === 'win32')('prefers bun on PATH', () => {
    const dir = dirWith(['bun', 'npm']);
    expect(
      resolvePackageInstallCommand({ isBunRuntime: false, pathEnv: dir }),
    ).toEqual({ command: ['bun', 'install', '--ignore-scripts'] });
  });

  test.skipIf(process.platform === 'win32')(
    'falls back to npm when bun is missing',
    () => {
      const dir = dirWith(['npm']);
      expect(
        resolvePackageInstallCommand({ isBunRuntime: false, pathEnv: dir }),
      ).toEqual({
        command: [
          'npm',
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
      });
    },
  );

  test('returns null when nothing is available', () => {
    expect(
      resolvePackageInstallCommand({
        isBunRuntime: false,
        pathEnv: dirWith([]),
      }),
    ).toBeNull();
  });
});

describe('isOnPath', () => {
  test('finds an executable file and skips missing PATH entries', () => {
    const dir = dirWith(['bun']);
    const missing = path.join(dir, 'missing');
    const pathEnv = [missing, dir].join(path.delimiter);
    expect(isOnPath('bun', pathEnv, 'linux')).toBe(true);
    expect(isOnPath('npm', pathEnv, 'linux')).toBe(false);
  });

  test('ignores non-executable files and directories', () => {
    const dir = dirWith(['bun'], 0o644);
    mkdirSync(path.join(dir, 'npm'));
    expect(isOnPath('bun', dir, 'linux')).toBe(false);
    expect(isOnPath('npm', dir, 'linux')).toBe(false);
  });

  test('ignores relative PATH entries', () => {
    const dir = dirWith(['bun']);
    const relative = path.relative(process.cwd(), dir);
    expect(isOnPath('bun', relative, 'linux')).toBe(false);
  });

  test('uses PATHEXT resolution on Windows', () => {
    const dir = dirWith(['npm.CMD', 'bun']);
    expect(isOnPath('npm', dir, 'win32')).toBe(true);
    expect(isOnPath('bun', dir, 'win32')).toBe(false);
  });
});
