import { statSync } from 'node:fs';
import * as path from 'node:path';
import { resolveWindowsCommand } from './compat';

export interface PackageInstallCommand {
  /** argv for crossSpawn. */
  command: string[];
  /** Full child env, when the command needs extra variables. */
  env?: Record<string, string | undefined>;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function isOnPath(
  command: string,
  pathEnv: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return resolveWindowsCommand(command, pathEnv) !== undefined;
  }
  return pathEnv
    .split(path.delimiter)
    .some((dir) => dir && isExecutableFile(path.join(dir, command)));
}

/**
 * Resolves the command used to install the plugin into a cache directory.
 *
 * 1. Running under Bun (the OpenCode binary is Bun-compiled, or the CLI ran
 *    via bunx): re-exec the current executable with BUN_BE_BUN=1, which makes
 *    a compiled Bun binary behave as the `bun` CLI. Needs nothing on PATH.
 * 2. `bun` on PATH.
 * 3. `npm` on PATH (e.g. the CLI ran via npx on a machine without bun).
 *
 * Returns null when no package manager is available.
 */
export function resolvePackageInstallCommand(
  options: { isBunRuntime?: boolean; execPath?: string; pathEnv?: string } = {},
): PackageInstallCommand | null {
  const {
    isBunRuntime = typeof Bun !== 'undefined',
    execPath = process.execPath,
    pathEnv = process.env.PATH ?? '',
  } = options;

  if (isBunRuntime && execPath) {
    return {
      command: [execPath, 'install', '--ignore-scripts'],
      env: { ...process.env, BUN_BE_BUN: '1' },
    };
  }
  if (isOnPath('bun', pathEnv)) {
    return { command: ['bun', 'install', '--ignore-scripts'] };
  }
  if (isOnPath('npm', pathEnv)) {
    return {
      command: [
        'npm',
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
    };
  }
  return null;
}
