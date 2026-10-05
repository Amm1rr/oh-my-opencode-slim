import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { log } from './logger';

const RETRY_INTERVAL_MS = 25;
const YOUNG_LOCK_MS = 5_000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function parsePidFile(raw: string): number | null {
  const pid = Number(raw.split('\n')[0].trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Reads a lock dir's `owner` file. The current format is the PID on line 1
 * and a per-acquisition owner token on line 2; legacy locks written by older
 * plugin versions contain only the PID, so `token` is then null.
 * Returns null when the file is missing or unparsable.
 */
export function readPidFileOwner(
  lock: string,
): { pid: number; token: string | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
  const pid = parsePidFile(raw);
  if (pid === null) return null;
  const token = raw.split('\n')[1]?.trim();
  return { pid, token: token ? token : null };
}

/**
 * Attempts to take an exclusive lock by creating the `<file>.lock` directory
 * and writing this process's PID plus a unique owner token into it. Locks
 * left behind by dead processes are detected via the owner PID file and
 * taken over atomically via rename, so two waiters can never both become
 * owners. With `maxAgeMs` set, a lock older than that is treated as stale
 * even when its owner PID is alive (PID reuse or a wedged holder must not
 * wedge peers forever). Returns a release function, or null when a live
 * process holds the lock. Release only removes the lock dir when the owner
 * token it reads still matches the token this acquisition wrote, so a
 * holder that lost the lock to a takeover can never delete its successor's
 * lock.
 */
export function acquirePidFileLock(
  file: string,
  maxAgeMs?: number,
): (() => void) | null {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      // Token is only compared against itself on release, never reaches the
      // prompt, so Date.now/Math.random are safe here (src/utils is outside
      // the cache-safety tripwire's SCAN_DIRS).
      const token = `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2)}`;
      writeFileSync(path.join(lock, 'owner'), `${process.pid}\n${token}`);
      return () => {
        const owner = readPidFileOwner(lock);
        if (!owner || owner.token !== token) {
          log('[pid-file-lock] lock owner changed; skipping release');
          return;
        }
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch (err) {
          log('[pid-file-lock] lock release failed', String(err));
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (pidFileLockHasLiveOwner(lock, maxAgeMs)) return null;
      log('[pid-file-lock] removing stale PID file lock for dead process');
      // Claim the stale lock by renaming it away before deleting: only one
      // waiter wins the rename, so a second waiter can never delete a
      // freshly re-acquired (live) lock and leave two owners. The suffix is
      // random so a leftover stale dir from a crashed same-PID predecessor
      // can never make this rename fail with EEXIST.
      const stalePath = `${lock}.stale-${process.pid}-${Date.now().toString(
        36,
      )}${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(lock, stalePath);
      } catch {
        // Another waiter took over or removed it; retry the mkdir.
        continue;
      }
      try {
        rmSync(stalePath, { recursive: true, force: true });
      } catch (err) {
        // Cleanup of the renamed-away dir is best-effort (EACCES/EBUSY on
        // win32); the lock itself is already ours, so never abort.
        log('[pid-file-lock] stale lock cleanup failed', String(err));
      }
    }
  }
  return null;
}

/**
 * Retries {@link acquirePidFileLock} up to `attempts` times, blocking
 * `RETRY_INTERVAL_MS` between attempts. Synchronous (Atomics.wait parks the
 * JS thread); prefer {@link acquirePidFileLockWithRetryAsync} on a main
 * thread. Returns a release function, or null when the lock stayed held for
 * every attempt (roughly `attempts * RETRY_INTERVAL_MS`).
 */
export function acquirePidFileLockWithRetry(
  file: string,
  attempts: number,
  maxAgeMs?: number,
): (() => void) | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const release = acquirePidFileLock(file, maxAgeMs);
    if (release) return release;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      RETRY_INTERVAL_MS,
    );
  }
  return null;
}

/**
 * Async variant of {@link acquirePidFileLockWithRetry}: waits via setTimeout
 * so the JS thread is never blocked (safe on the main thread). Retries until
 * `timeoutMs` has elapsed. Returns a release function, or null when the lock
 * stayed held for the whole budget.
 */
export async function acquirePidFileLockWithRetryAsync(
  file: string,
  timeoutMs: number,
  maxAgeMs?: number,
): Promise<(() => void) | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = acquirePidFileLock(file, maxAgeMs);
    if (release) return release;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
}

/**
 * A lock counts as live when its owner PID is running. Two guards keep a
 * dead or wedged holder from blocking peers forever:
 *
 * - If the owner file is unreadable (holder crashed between mkdirSync and
 *   writeFileSync), a lock dir younger than {@link YOUNG_LOCK_MS} counts as
 *   live; older ones are stale.
 * - With `maxAgeMs` set, a lock dir older than that is stale even when the
 *   owner PID answers: the PID was recycled by an unrelated process, or the
 *   holder wedged past its own install timeout.
 */
export function pidFileLockHasLiveOwner(
  lock: string,
  maxAgeMs?: number,
): boolean {
  try {
    const owner = parsePidFile(readFileSync(path.join(lock, 'owner'), 'utf8'));
    if (owner !== null) {
      if (!isProcessAlive(owner)) return false;
      if (maxAgeMs !== undefined) {
        try {
          if (Date.now() - statSync(lock).mtimeMs >= maxAgeMs) {
            log('[pid-file-lock] lock age exceeds max age; treating as stale');
            return false;
          }
        } catch {
          // Cannot stat the lock dir; treat the live owner as authoritative.
        }
      }
      return true;
    }
  } catch (err) {
    log('[pid-file-lock] lock owner check failed', String(err));
    try {
      return Date.now() - statSync(lock).mtimeMs < YOUNG_LOCK_MS;
    } catch (err) {
      log('[pid-file-lock] lock owner check failed', String(err));
    }
  }
  return false;
}
