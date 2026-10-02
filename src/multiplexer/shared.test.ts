import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
};

const crossSpawnMock = mock(
  (_args: string[]): SpawnResult => ({
    exited: Promise.resolve(0),
    stdout: () => Promise.resolve(''),
    stderr: () => Promise.resolve(''),
  }),
);

mock.module('../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

async function importShared() {
  return import(`./shared?test=${importCounter++}`);
}

describe('gracefulClosePane', () => {
  afterEach(() => {
    crossSpawnMock.mockReset();
  });

  test('sends Ctrl+C, waits 250ms, then closes, returning true on exit 0', async () => {
    const calls: string[][] = [];

    crossSpawnMock.mockImplementation((args: string[]) => {
      calls.push(args);
      return {
        exited: Promise.resolve(0),
        stdout: () => Promise.resolve(''),
        stderr: () => Promise.resolve(''),
      };
    });

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('returns true when acceptExitCode1 and exit code is 1', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
    }));

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('zellij', 'terminal_1', {
      ctrlC: ['action', 'write', '--pane-id', 'terminal_1', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', 'terminal_1'],
      acceptExitCode1: true,
    });
    expect(ok).toBe(true);
  });

  test('returns false on exit 1 when acceptExitCode1 is false', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
    }));

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });
    expect(ok).toBe(false);
  });

  test('returns emptyPaneReturnsTrue when paneId is empty', async () => {
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('zellij', '', {
      ctrlC: ['action', 'write', '--pane-id', '', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', ''],
      emptyPaneReturnsTrue: true,
    });
    expect(ok).toBe(true);
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('returns false when binary is null', async () => {
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane(null, '%1', {
      ctrlC: ['x'],
      close: ['y'],
    });
    expect(ok).toBe(false);
  });
});

describe('buildOpencodeAttachCommand', () => {
  test('quotes an absolute executable containing spaces and apostrophes', async () => {
    const { buildOpencodeAttachCommand } = await importShared();
    const cmd = buildOpencodeAttachCommand(
      'sess',
      'url',
      '/repo',
      "/Users/King's Tools/opencode",
    );
    expect(cmd).toStartWith("'/Users/King'\\''s Tools/opencode' attach");
  });

  test('resolves host executable with env, process, and bare fallbacks', async () => {
    const { resolveHostOpencodeBinary } = await importShared();
    expect(
      resolveHostOpencodeBinary({
        envOverride: '/Users/king/.opencode/bin/opencode',
        pathExists: () => true,
        execPath: '/opt/homebrew/bin/bun',
        argv0: '/opt/homebrew/bin/bun',
      }),
    ).toBe('/Users/king/.opencode/bin/opencode');
    expect(
      resolveHostOpencodeBinary({
        envOverride: '/missing/opencode',
        pathExists: (path) => path === '/Users/king/.opencode/bin/opencode',
        execPath: '/Users/king/.opencode/bin/opencode',
      }),
    ).toBe('/Users/king/.opencode/bin/opencode');
    expect(
      resolveHostOpencodeBinary({
        envOverride: 'relative/opencode',
        pathExists: () => true,
        execPath: '/opt/homebrew/bin/bun',
        argv0: 'bun',
      }),
    ).toBeNull();
  });

  test('normalizes Windows backslash paths to forward slashes', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      const cmd = buildOpencodeAttachCommand(
        'sess',
        'url',
        'C:\\Users\\foo\\repo',
      );
      expect(cmd).toContain('C:/Users/foo/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });

  test('leaves non-Windows paths unchanged', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      const cmd = buildOpencodeAttachCommand('sess', 'url', '/home/user/repo');
      expect(cmd).toContain('/home/user/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('buildShellLaunchArgs', () => {
  const cases: Array<{
    shell: string;
    expected: (cmd: string) => string[];
  }> = [
    {
      shell: '/opt/homebrew/bin/fish',
      expected: (cmd) => ['/opt/homebrew/bin/fish', '-c', cmd],
    },
    {
      shell: '/usr/bin/nu',
      expected: (cmd) => ['/usr/bin/nu', '-c', cmd],
    },
    {
      shell: '/bin/zsh',
      expected: (cmd) => ['/bin/zsh', '-l', '-c', expect.stringContaining(cmd)],
    },
    {
      shell: '/bin/bash',
      expected: (cmd) => [
        '/bin/bash',
        '-l',
        '-c',
        expect.stringContaining(cmd),
      ],
    },
    {
      shell: 'C:\\Windows\\System32\\cmd.exe',
      expected: (cmd) => ['C:\\Windows\\System32\\cmd.exe', '/c', cmd],
    },
    {
      shell: '/usr/bin/pwsh',
      expected: (cmd) => ['/usr/bin/pwsh', '-NoProfile', '-Command', cmd],
    },
    {
      shell: '/bin/dash',
      expected: (cmd) => ['/bin/dash', '-c', cmd],
    },
    {
      shell: '/usr/bin/elvish',
      expected: (cmd) => ['/usr/bin/elvish', '-c', cmd],
    },
  ];

  for (const { shell, expected } of cases) {
    test(`uses correct args for ${shell}`, async () => {
      const original = process.env.SHELL;
      process.env.SHELL = shell;
      try {
        const { buildShellLaunchArgs } = await importShared();
        const cmd = 'opencode attach url --session s';
        expect(buildShellLaunchArgs(cmd)).toEqual(expected(cmd));
      } finally {
        process.env.SHELL = original;
      }
    });
  }

  test('falls back to /bin/sh when SHELL is unset', async () => {
    const original = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const { buildShellLaunchArgs } = await importShared();
      const cmd = 'opencode attach url';
      expect(buildShellLaunchArgs(cmd)).toEqual(['/bin/sh', '-c', cmd]);
    } finally {
      process.env.SHELL = original;
    }
  });
});

describe('findBinaryLogPrefix', () => {
  test('derives [<binaryName>] for callers without an override', async () => {
    const { findBinaryLogPrefix } = await importShared();

    // tmux/zellij/herdr/kitty pass no override, so their `findBinary` log
    // lines stay byte-identical.
    expect(findBinaryLogPrefix('tmux')).toBe('[tmux]');
    expect(findBinaryLogPrefix('zellij')).toBe('[zellij]');
    expect(findBinaryLogPrefix('herdr')).toBe('[herdr]');
    expect(findBinaryLogPrefix('kitten')).toBe('[kitten]');
    expect(findBinaryLogPrefix('kitty')).toBe('[kitty]');
  });

  test('honors the cmux adapter override for both probes', async () => {
    const { findBinaryLogPrefix } = await importShared();

    // The legacy `cmux` fallback must log under `[cmux-tui]`, never `[cmux]`.
    expect(findBinaryLogPrefix('cmux-tui', 'cmux-tui')).toBe('[cmux-tui]');
    expect(findBinaryLogPrefix('cmux', 'cmux-tui')).toBe('[cmux-tui]');
  });
});

describe('buildViewCommand', () => {
  test('v1 flavor is byte-identical to the legacy attach command', async () => {
    const { buildOpencodeAttachCommand, buildViewCommand } =
      await importShared();
    const legacy = buildOpencodeAttachCommand('sess', 'http://x', '/repo');
    expect(buildViewCommand('v1', 'sess', 'http://x', '/repo')).toBe(legacy);
  });

  test('v2-shared omits URL and secret (the viewer discovers the service)', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand('v2-shared', 'ses_abc', 'http://unused', '/repo'),
    ).toBe("opencode --session 'ses_abc' '/repo'");
  });

  test('v2-remote carries server URL, session and directory — never the secret', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand(
        'v2-remote',
        'ses_abc',
        'http://192.168.5.212:8192',
        '/repo',
      ),
    ).toBe(
      "opencode --server 'http://192.168.5.212:8192' --session 'ses_abc' '/repo'",
    );
  });

  test('v2-remote ignores a stray password option (no secret in command text)', async () => {
    const { buildViewCommand } = await importShared();
    // Regression guard: the old interface accepted a password and embedded
    // it as `env OPENCODE_PASSWORD=…`. Any leftover caller must not leak.
    const options = { password: 'pw-123' } as unknown as Parameters<
      typeof buildViewCommand
    >[4];
    const cmd = buildViewCommand(
      'v2-remote',
      'ses_abc',
      'http://x',
      '/repo',
      options,
    );
    expect(cmd).toBe(
      "opencode --server 'http://x' --session 'ses_abc' '/repo'",
    );
    expect(cmd).not.toContain('pw-123');
    expect(cmd).not.toContain('OPENCODE_PASSWORD');
  });

  test('viewer "mini" targets the mini interface for every flavor', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand('v1', 'sess', 'http://x', '/repo', { viewer: 'mini' }),
    ).toBe("opencode mini --server 'http://x' --session 'sess'");
    expect(
      buildViewCommand('v2-shared', 'ses_abc', 'http://unused', '/repo', {
        viewer: 'mini',
      }),
    ).toBe("opencode mini --session 'ses_abc'");
    expect(
      buildViewCommand('v2-remote', 'ses_abc', 'http://192.168.5.212:8192', '/repo', {
        viewer: 'mini',
      }),
    ).toBe(
      "opencode mini --server 'http://192.168.5.212:8192' --session 'ses_abc'",
    );
  });

  test('v2 flavors quote directories, session ids and executables', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand('v2-shared', "s'es s", 'http://x', "/tmp/a b's", {
        executable: "/opt/King's/opencode",
      }),
    ).toBe(
      "'/opt/King'\\''s/opencode' --session 's'\\''es s' '/tmp/a b'\\''s'",
    );
  });

  test('v2-remote normalizes Windows backslash paths', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const { buildViewCommand } = await importShared();
      const cmd = buildViewCommand(
        'v2-remote',
        'ses',
        'http://x',
        'C:\\Users\\foo\\repo',
      );
      expect(cmd).toContain('C:/Users/foo/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('isPosixShell', () => {
  test('accepts POSIX-family shells by basename', async () => {
    const { isPosixShell } = await importShared();
    for (const shell of [
      '/bin/sh',
      '/bin/bash',
      '/usr/bin/zsh',
      '/usr/bin/dash',
      '/usr/bin/ksh',
      'bash',
    ]) {
      expect(isPosixShell(shell)).toBe(true);
    }
  });

  test('rejects non-POSIX and unknown shells (fail closed)', async () => {
    const { isPosixShell } = await importShared();
    for (const shell of [
      '/usr/bin/fish',
      '/usr/bin/nu',
      '/usr/bin/pwsh',
      '/usr/bin/powershell',
      'C:\\Windows\\System32\\cmd.exe',
      '/usr/bin/elvish',
      '/usr/bin/xonsh',
      '',
    ]) {
      expect(isPosixShell(shell)).toBe(false);
    }
  });
});

describe('withParentEnvPassword', () => {
  test('reads OPENCODE_PASSWORD first and falls back to OPENCODE_SERVER_PASSWORD', async () => {
    const { withParentEnvPassword } = await importShared();
    const script = withParentEnvPassword('opencode --server u');

    expect(script).toContain(`/proc/${process.pid}/environ`);
    expect(script).toContain('s/^OPENCODE_PASSWORD=//p');
    expect(script).toContain('s/^OPENCODE_SERVER_PASSWORD=//p');
    // Precedence: the primary probe runs before the fallback probe.
    const primary = script.indexOf('OPENCODE_PASSWORD=');
    const fallback = script.indexOf('OPENCODE_SERVER_PASSWORD=');
    expect(primary).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(primary);
    expect(script).toContain('export OPENCODE_PASSWORD');
    expect(script).toContain('unset _omo_pw');
    // The wrapper takes no secret argument, so no secret can be embedded,
    // and the original command is the last line.
    expect(script).not.toContain('pw-');
    expect(script.endsWith('\nopencode --server u')).toBe(true);
  });

  test('exports the primary value read from the parent environ', async () => {
    await expectExtractedPassword(
      'PATH=/usr/bin\0OPENCODE_PASSWORD=from-primary\0OPENCODE_SERVER_PASSWORD=from-fallback\0',
      'from-primary',
    );
  });

  test('falls back to OPENCODE_SERVER_PASSWORD when the primary is absent', async () => {
    await expectExtractedPassword(
      'PATH=/usr/bin\0OPENCODE_SERVER_PASSWORD=from-fallback\0',
      'from-fallback',
    );
  });

  test('runs the command with an empty value when neither is present', async () => {
    await expectExtractedPassword('PATH=/usr/bin\0', '');
  });

  test('runs the wrapped command in a POSIX shell', async () => {
    const { withParentEnvPassword } = await importShared();
    const script = withParentEnvPassword('printf ok');
    const proc = Bun.spawn(['/bin/sh', '-c', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('ok');
  });
});

/**
 * Executes the generated wrapper against a fake `/proc/<pid>/environ` file
 * (only the path is substituted) and returns the value the wrapped command
 * observes as `OPENCODE_PASSWORD`.
 */
async function expectExtractedPassword(
  environContents: string,
  expected: string,
): Promise<void> {
  const { withParentEnvPassword } = await importShared();
  const dir = `/tmp/opencode/omo-shared-test-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  const environPath = `${dir}/environ`;
  writeFileSync(environPath, environContents);
  try {
    const script = withParentEnvPassword(
      'printf %s "$OPENCODE_PASSWORD"',
    ).replaceAll(`/proc/${process.pid}/environ`, environPath);
    const proc = Bun.spawn(['/bin/sh', '-c', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('redactViewerSecretArgs', () => {
  test('masks viewer-secret env entries in spawn argv', async () => {
    const { redactViewerSecretArgs } = await importShared();
    expect(
      redactViewerSecretArgs([
        '-e',
        'OPENCODE_PASSWORD=hunter2',
        '--env',
        'OPENCODE_SERVER_PASSWORD=hunter3',
      ]),
    ).toEqual([
      '-e',
      'OPENCODE_PASSWORD=<redacted>',
      '--env',
      'OPENCODE_SERVER_PASSWORD=<redacted>',
    ]);
  });

  test('leaves unrelated entries and viewer commands untouched', async () => {
    const { redactViewerSecretArgs } = await importShared();
    expect(
      redactViewerSecretArgs([
        'env',
        'OPENCODE_DISABLE_TERMINAL_TITLE=1',
        'opencode --server http://127.0.0.1:1 --session ses_x /tmp/a b',
        'OPENCODE_PASSWORDX=keep',
      ]),
    ).toEqual([
      'env',
      'OPENCODE_DISABLE_TERMINAL_TITLE=1',
      'opencode --server http://127.0.0.1:1 --session ses_x /tmp/a b',
      'OPENCODE_PASSWORDX=keep',
    ]);
  });
});
