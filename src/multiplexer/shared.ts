/**
 * Shared multiplexer infrastructure
 *
 * Functions used across tmux, zellij, and herdr backend adapters.
 * Extracted to eliminate copy-paste duplication and prevent drift.
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { MultiplexerViewer } from '../config/schema';
import { crossSpawn } from '../utils/compat';
import { log } from '../utils/logger';

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalize Windows backslashes to / so sh -lc (MSYS2/Git Bash) doesn't treat them as escape chars. */
export function normalizePathForShell(directory: string): string {
  return process.platform === 'win32'
    ? directory.replace(/\\/g, '/')
    : directory;
}

export function buildOpencodeAttachCommand(
  sessionId: string,
  serverUrl: string,
  directory: string,
  executable = 'opencode',
): string {
  const attachDir = normalizePathForShell(directory);
  return [
    executable === 'opencode' ? executable : quoteShellArg(executable),
    'attach',
    quoteShellArg(serverUrl),
    '--session',
    quoteShellArg(sessionId),
    '--dir',
    quoteShellArg(attachDir),
  ].join(' ');
}

/**
 * Viewer command flavor, one per host deployment mode (FR-2 matrix):
 * `v1` attaches to a reflected server URL; `v2-shared` lets the viewer
 * rediscover the shared background service itself; `v2-remote` connects to
 * the same explicit `--server` the parent client uses.
 */
export type ViewerFlavor = 'v1' | 'v2-shared' | 'v2-remote';

/**
 * Which opencode TUI surface a viewer command opens: the full `tui`
 * (default) or the lightweight `mini` interface. Derived from the config
 * schema so the user-facing enum has one source of truth.
 */
export type ViewerSurface = MultiplexerViewer;

export interface ViewerCommandOptions {
  /** Absolute host binary; defaults to the bare `opencode` name. */
  executable?: string;
  /** TUI surface to open; defaults to the full `tui`. */
  viewerSurface?: ViewerSurface;
}

/**
 * Builds the pane viewer command for one host flavor (FR-2 command matrix).
 * Every adapter routes through here so the matrix lives in exactly one place.
 *
 * - `v1`: `opencode attach <url> --session <id> --dir <dir>` (unchanged)
 * - `v2-shared`: `opencode --session <id> <dir>` — the viewer discovers the
 *   same shared background service by itself; no URL is passed.
 * - `v2-remote`: `opencode --server <url> --session <id> <dir>` — the
 *   `OPENCODE_PASSWORD` secret is never part of the command text; adapters
 *   inject it at pane creation through their native spawn-time environment
 *   mechanism, or through `withParentEnvPassword` where none exists.
 *
 * With `viewerSurface: 'mini'` the same matrix targets the `opencode mini`
 * interface instead: the `mini` subcommand is inserted after the binary and
 * the v1 attach form is expressed as `mini --server <url>`, mirroring the
 * flags `mini` shares with the full TUI. Mini rejects a positional
 * directory, so the directory argument is omitted; every adapter pins the
 * pane to the child session's project directory by its own means (herdr
 * `--cwd`, kitty `--cwd=`, tmux `-c`, Zellij `--cwd`, cmux-tui `cd`).
 */
export function buildViewCommand(
  flavor: ViewerFlavor,
  sessionId: string,
  serverUrl: string,
  directory: string,
  options: ViewerCommandOptions = {},
): string {
  const executable = options.executable ?? 'opencode';
  const isMini = options.viewerSurface === 'mini';
  const exe =
    executable === 'opencode' ? executable : quoteShellArg(executable);
  if (flavor === 'v1' && !isMini) {
    return buildOpencodeAttachCommand(
      sessionId,
      serverUrl,
      directory,
      executable,
    );
  }
  if (flavor === 'v1') {
    return [
      exe,
      ...(isMini ? ['mini'] : []),
      '--server',
      quoteShellArg(serverUrl),
      '--session',
      quoteShellArg(sessionId),
    ].join(' ');
  }
  const viewDir = normalizePathForShell(directory);
  const dirArgs = isMini ? [] : [quoteShellArg(viewDir)];
  if (flavor === 'v2-shared') {
    return [
      exe,
      ...(isMini ? ['mini'] : []),
      '--session',
      quoteShellArg(sessionId),
      ...dirArgs,
    ].join(' ');
  }
  return [
    exe,
    ...(isMini ? ['mini'] : []),
    '--server',
    quoteShellArg(serverUrl),
    '--session',
    quoteShellArg(sessionId),
    ...dirArgs,
  ].join(' ');
}

/** Shells whose `-c` argument is a POSIX script. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Whether the resolved shell can run a POSIX script. Used to gate the
 * `/proc`-based viewer-secret bridge (cmux-tui): unknown and Windows shells
 * count as non-POSIX, so the caller fails closed instead of feeding a
 * command-substitution script to a shell that cannot parse it.
 */
export function isPosixShell(shell: string): boolean {
  return POSIX_SHELLS.has(shellName(shell));
}

/**
 * Wraps `command` in a POSIX script that recovers the viewer password from
 * this process's own `/proc/<pid>/environ` (readable by the owning user only)
 * and exports it as `OPENCODE_PASSWORD` before running the command. Adapters
 * whose CLI has no spawn-time env mechanism (zellij, cmux-tui) use this so
 * the secret never appears in command text or argv — it exists only in the
 * pane's environment at viewer start.
 *
 * Precedence matches the v2 host wiring: `OPENCODE_PASSWORD` first, then
 * `OPENCODE_SERVER_PASSWORD`. `/proc/<pid>/environ` is NUL-separated and is
 * split with `tr`, so the value is read line-wise: a password containing
 * newlines is recovered only up to its first line (documented limitation).
 */
export function withParentEnvPassword(command: string): string {
  const environ = `/proc/${process.pid}/environ`;
  const read = (name: string): string =>
    `$(tr '\\0' '\\n' < ${environ} 2>/dev/null | sed -n 's/^${name}=//p' | head -n 1)`;
  return [
    `_omo_pw=${read('OPENCODE_PASSWORD')}`,
    `[ -n "$_omo_pw" ] || _omo_pw=${read('OPENCODE_SERVER_PASSWORD')}`,
    'if [ -n "$_omo_pw" ]; then export OPENCODE_PASSWORD="$_omo_pw"; fi',
    'unset _omo_pw',
    command,
  ].join('\n');
}

/**
 * Masks the viewer secret in spawn argv before it reaches a log payload.
 * The secret travels as a spawn-time environment entry (`-e` / `--env`), so
 * masking `OPENCODE_PASSWORD=…` / `OPENCODE_SERVER_PASSWORD=…` values keeps
 * every log line secret-free; viewer commands never contain it.
 */
export function redactViewerSecretArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    const separator = arg.indexOf('=');
    if (separator === -1) return arg;
    const name = arg.slice(0, separator);
    return name === 'OPENCODE_PASSWORD' || name === 'OPENCODE_SERVER_PASSWORD'
      ? `${name}=<redacted>`
      : arg;
  });
}

/**
 * Resolve the absolute path to the running OpenCode binary so child shells
 * (e.g. a kitty-launched window) don't need `opencode` on their PATH. Falls
 * back to the bare `opencode` name when no absolute path can be determined.
 */
export function resolveOpencodeExecutable(): string {
  return resolveHostOpencodeBinary() ?? 'opencode';
}

/**
 * Build the `[shell, ...shellArgs, command]` array for launching a command in
 * the user's interactive shell. OpenCode respects the user's shell when running
 * commands; multiplexer panes must do the same, otherwise a hardcoded `sh -c`
 * breaks under non-POSIX shells (fish, nu, powershell, ...) or misses login
 * startup files (where `opencode` may be on PATH).
 *
 * Mirrors OpenCode's own `Shell.args()` resolution:
 * - nu / fish: `<shell> -c <command>` (no login mode)
 * - zsh: login mode; zsh sources ~/.zshenv automatically, then we source
 *   .zshrc before running the command
 * - bash: login mode, sources bashrc, then runs command
 * - cmd: `cmd /c <command>`
 * - powershell: `pwsh -NoProfile -Command <command>`
 * - default (sh/dash/elvish/xonsh/...): `<shell> -c <command>`
 *
 * Note: the working directory is supplied by the launcher (e.g. kitty's
 * `--cwd`), not by a `cd` inside the shell command.
 */
export function buildShellLaunchArgs(command: string): string[] {
  const shell = process.env.SHELL || '/bin/sh';
  const name = shellName(shell);

  if (name === 'nu' || name === 'fish') {
    return [shell, '-c', command];
  }
  if (name === 'zsh') {
    // zsh sources ~/.zshenv unconditionally at startup (every session, login or
    // not), so we must not source it again here. Only source .zshrc (login
    // mode already implies this, but doing it explicitly keeps PATH/aliases
    // consistent for the launched command).
    return [
      shell,
      '-l',
      '-c',
      `[[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1\n${command}`,
    ];
  }
  if (name === 'bash') {
    return [
      shell,
      '-l',
      '-c',
      `shopt -s expand_aliases\n[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true\n${command}`,
    ];
  }
  if (name === 'cmd') {
    return [shell, '/c', command];
  }
  if (name === 'pwsh' || name === 'powershell') {
    return [shell, '-NoProfile', '-Command', command];
  }
  return [shell, '-c', command];
}

/** Resolved basename of a shell path, without a `.exe` suffix. */
function shellName(shell: string): string {
  return (shell.split(/[/\\]/).at(-1) ?? 'sh').replace(/\.(exe|EXE)$/, '');
}

/**
 * Whether the resolved interactive shell treats `#` as a comment. Adapters
 * that prefix a POSIX comment data marker to a command must omit it when the
 * shell has no `#` comments (only `cmd` today). Reuses the same shell-name
 * resolution as `buildShellLaunchArgs` so the two can never disagree.
 */
export function shellSupportsHashComments(
  shell = process.env.SHELL || '/bin/sh',
): boolean {
  return shellName(shell) !== 'cmd';
}

export function resolveHostOpencodeBinary(
  options: {
    override?: string;
    envOverride?: string;
    execPath?: string;
    argv0?: string;
    pathExists?: (path: string) => boolean;
  } = {},
): string | null {
  const pathExists = options.pathExists ?? existsSync;
  for (const candidate of [
    options.override,
    options.envOverride ?? process.env.OPENCODE_BIN,
    options.execPath ?? process.execPath,
    options.argv0 ?? process.argv[0],
  ]) {
    if (
      candidate &&
      isAbsolute(candidate) &&
      /^opencode(?:\.exe)?$/i.test(basename(candidate)) &&
      pathExists(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Log prefix of one `findBinary` probe: `[<binaryName>]` by default. Callers
 * that probe a differently named distribution binary (cmux probes `cmux` as a
 * legacy fallback while its logs are prefixed `[cmux-tui]`) pass `logPrefix`.
 */
export function findBinaryLogPrefix(
  binaryName: string,
  logPrefix?: string,
): string {
  return `[${logPrefix ?? binaryName}]`;
}

export async function findBinary(
  binaryName: string,
  options: { verify?: boolean; logPrefix?: string } = {},
): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  const logPrefix = findBinaryLogPrefix(binaryName, options.logPrefix);

  try {
    const proc = crossSpawn([cmd, binaryName], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log(`${logPrefix} findBinary: '${cmd} ${binaryName}' failed`, {
        exitCode,
      });
      return null;
    }

    const stdout = await proc.stdout();
    const path = stdout.trim().split('\n')[0];
    if (!path) {
      log(`${logPrefix} findBinary: no path in output`);
      return null;
    }

    log(`${logPrefix} findBinary: found ${path}`);

    // Verify the binary works if requested
    if (options.verify) {
      try {
        const verifyProc = crossSpawn([path, '-V'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const verifyExitCode = await verifyProc.exited;
        if (verifyExitCode !== 0) {
          log(`${logPrefix} findBinary: verification failed for ${path}`);
          return null;
        }
        const verifyStdout = await verifyProc.stdout();
        log(`${logPrefix} findBinary: verified`, {
          version: verifyStdout.trim(),
        });
      } catch (verifyErr) {
        log(`${logPrefix} findBinary: verification exception`, {
          error: String(verifyErr),
        });
        return null;
      }
    }

    return path;
  } catch (err) {
    log(`${logPrefix} findBinary: exception`, { error: String(err) });
    return null;
  }
}

const GRACEFUL_SHUTDOWN_DELAY_MS = 250;

export interface GracefulClosePaneOptions {
  /** Backend-specific Ctrl+C command args (binary prepended by caller). */
  ctrlC: string[];
  /** Backend-specific close/kill command args (binary prepended by caller). */
  close: string[];
  /** Accept exit code 1 as success (zellij/herdr treat "already closed" as 1). */
  acceptExitCode1?: boolean;
  /** Return true for empty/unknown paneId instead of false (zellij/herdr behavior). */
  emptyPaneReturnsTrue?: boolean;
  /** Env to pass to the kitten/kitty invocations (e.g. KITTY_LISTEN_ON). */
  env?: Record<string, string | undefined>;
}

export async function gracefulClosePane(
  binary: string | null,
  paneId: string,
  options: GracefulClosePaneOptions,
): Promise<boolean> {
  if (!binary) return false;

  const isEmpty = !paneId || paneId === 'unknown';
  if (isEmpty) return options.emptyPaneReturnsTrue ?? false;

  try {
    const ctrlCProc = crossSpawn([binary, ...options.ctrlC], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: options.env,
    });
    await ctrlCProc.exited;

    await new Promise((r) => setTimeout(r, GRACEFUL_SHUTDOWN_DELAY_MS));

    const proc = crossSpawn([binary, ...options.close], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: options.env,
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) return true;
    if (options.acceptExitCode1 && exitCode === 1) return true;
    return false;
  } catch {
    return false;
  }
}
