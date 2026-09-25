import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type SpawnCall = {
  file: string;
  args: string[];
  options: Record<string, unknown>;
};

type FakeChild = EventEmitter & {
  kill: () => boolean;
  stdout: null;
  stderr: null;
  exitCode: number | null;
};

const spawnCalls: SpawnCall[] = [];

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = () => true;
  child.stdout = null;
  child.stderr = null;
  child.exitCode = 0;
  return child;
}

const spawnMock = mock(
  (file: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ file, args, options });
    return fakeChild();
  },
);

const TEST_DIR = path.join(
  os.tmpdir(),
  `compat-spawn-options-test-${process.pid}`,
);
const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalComSpec = process.env.ComSpec;
let importCounter = 0;
let spawnSpy: ReturnType<typeof spyOn> | undefined;

async function importCompat() {
  return await import(`./compat.ts?spawn-options=${importCounter++}`);
}

function fixtureDir(name: string, files: string[]): string {
  const dir = path.join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(spawnMock);
});

afterEach(() => {
  setPlatform(originalPlatform);
  process.env.PATH = originalPath;
  if (originalComSpec === undefined) {
    delete process.env.ComSpec;
  } else {
    process.env.ComSpec = originalComSpec;
  }
  spawnCalls.length = 0;
  spawnMock.mockClear();
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('crossSpawn spawn options', () => {
  it('passes windowsHide to the direct spawn branch', async () => {
    // Force the non-win32 branch so the command is spawned directly rather
    // than re-resolved through a .cmd shim on this host.
    setPlatform('linux');
    const { crossSpawn } = await importCompat();

    crossSpawn(['bun', 'install'], { cwd: 'C:\\tmp' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).toBe('bun');
    expect(spawnCalls[0]?.args).toEqual(['install']);
    expect(spawnCalls[0]?.options.windowsHide).toBe(true);
  });

  it('passes windowsHide and windowsVerbatimArguments to the win32 shim branch', async () => {
    const dir = fixtureDir('shim', ['mytool.cmd']);
    process.env.PATH = dir;
    setPlatform('win32');
    const { crossSpawn } = await importCompat();

    crossSpawn(['mytool', 'arg']);

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call?.file).toBe(process.env.ComSpec ?? 'cmd.exe');
    expect(call?.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.windowsVerbatimArguments).toBe(true);
  });
});
