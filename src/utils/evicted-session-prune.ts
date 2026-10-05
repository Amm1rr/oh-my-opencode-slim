/**
 * Terminal-session GC host delete (#1387). Removes the host child session of
 * an evicted board record only after proving it is still this plugin's own
 * background child: eligibility by board provenance, then a bounded host
 * read confirming the session's parentID still matches the record's parent.
 */
import {
  type BackgroundJobEvictedSession,
  isPrunableEvictedSession,
} from './background-job-board';
import { log } from './logger';
import { withTimeout } from './session';

interface PruneSessionClient {
  get?: (request: {
    path: { id: string };
    query: { directory: string };
    signal?: AbortSignal;
  }) => Promise<unknown>;
  delete: (request: {
    path: { id: string };
    query: { directory: string };
  }) => Promise<unknown>;
}

export type EvictedSessionPruneOutcome =
  | 'deleted'
  | 'ineligible'
  | 'read-failed'
  | 'parent-mismatch'
  | 'delete-failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read the host session's parentID; undefined when the read is unusable. */
async function readHostParentID(
  session: PruneSessionClient,
  taskID: string,
  directory: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (typeof session.get !== 'function') return undefined;
  const controller = new AbortController();
  try {
    const response = await withTimeout(
      session.get({
        path: { id: taskID },
        query: { directory },
        signal: controller.signal,
      }),
      timeoutMs,
      'Evicted session parent lookup timed out',
    );
    if (!isRecord(response) || response.error !== undefined) return undefined;
    const data = response.data;
    if (!isRecord(data)) return undefined;
    if (data.id !== undefined && data.id !== taskID) return undefined;
    return typeof data.parentID === 'string' ? data.parentID : undefined;
  } catch (error) {
    controller.abort();
    log('[plugin] terminal-session prune parent read failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Never rejects: every failure resolves to a skip outcome and is logged. */
export async function pruneEvictedHostSession(input: {
  session: PruneSessionClient;
  directory: string;
  evicted: BackgroundJobEvictedSession;
  readTimeoutMs: number;
}): Promise<EvictedSessionPruneOutcome> {
  const { session, directory, evicted } = input;
  if (!isPrunableEvictedSession(evicted)) return 'ineligible';
  const parentID = await readHostParentID(
    session,
    evicted.taskID,
    directory,
    input.readTimeoutMs,
  );
  if (parentID === undefined) {
    log('[plugin] terminal-session prune skipped: parent unverified', {
      taskID: evicted.taskID,
    });
    return 'read-failed';
  }
  if (parentID !== evicted.parentSessionID) {
    log('[plugin] terminal-session prune skipped: parent mismatch', {
      taskID: evicted.taskID,
      expected: evicted.parentSessionID,
      actual: parentID,
    });
    return 'parent-mismatch';
  }
  try {
    // `query.directory` pins the delete to this project: on a shared v1 host
    // an unpinned call can route to the server's working directory and miss
    // the child session.
    await session.delete({
      path: { id: evicted.taskID },
      query: { directory },
    });
    return 'deleted';
  } catch (error) {
    log('[plugin] terminal-session prune remove failed', {
      taskID: evicted.taskID,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'delete-failed';
  }
}
