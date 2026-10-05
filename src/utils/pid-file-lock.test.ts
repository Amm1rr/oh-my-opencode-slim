import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquirePidFileLock,
  acquirePidFileLockWithRetryAsync,
  parsePidFile,
} from './pid-file-lock';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('pid-file-lock', () => {
  test('acquire, release, and re-acquire', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');

    const release = acquirePidFileLock(lockFile);
    expect(release).not.toBeNull();
    expect(fs.existsSync(`${lockFile}.lock`)).toBe(true);

    release?.();
    expect(fs.existsSync(`${lockFile}.lock`)).toBe(false);

    const reAcquired = acquirePidFileLock(lockFile);
    expect(reAcquired).not.toBeNull();
    reAcquired?.();
  });

  test('takes over a lock whose owner PID is dead', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    // A dead owner: an integer PID far above typical pid_max that no test
    // process should hold. If such a PID somehow exists, skip rather than
    // flake.
    const deadPid = 2 ** 22;
    try {
      process.kill(deadPid, 0);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
    }

    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(join(lockDir, 'owner'), String(deadPid));

    const release = acquirePidFileLock(lockFile);
    expect(release).not.toBeNull();
    expect(parsePidFile(fs.readFileSync(join(lockDir, 'owner'), 'utf8'))).toBe(
      process.pid,
    );
    release?.();
  });

  test('age cap takes over a live-owned lock older than maxAgeMs', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(join(lockDir, 'owner'), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);

    const release = await acquirePidFileLockWithRetryAsync(
      lockFile,
      500,
      30_000,
    );
    expect(release).not.toBeNull();
    expect(parsePidFile(fs.readFileSync(join(lockDir, 'owner'), 'utf8'))).toBe(
      process.pid,
    );
    release?.();
  });

  test('owner-less young lock counts as live', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');

    // Crash between mkdirSync and writeFileSync leaves a lock dir with no
    // owner file; the young-lock fallback must treat it as live so the next
    // waiter does not steal a lock the crashed process briefly held.
    fs.mkdirSync(`${lockFile}.lock`, { recursive: true });

    const release = await acquirePidFileLockWithRetryAsync(lockFile, 50);
    expect(release).toBeNull();
  });
});
