/**
 * On-demand v1 recovery of a host child the local board no longer knows.
 *
 * Reads the host session, verifies parent and agent, classifies only the
 * latest delivered round, then imports a terminal cache row. It does not
 * scan at startup, send a prompt, or keep a recovery claim.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import {
  aliasPrefixForAgent,
  type BackgroundJobBoard,
  deriveFullObjective,
  deriveTaskSessionLabel,
  type RestoreRetainedSessionInput,
} from '../../utils/background-job-board';
import { getSuppressionTombstone } from '../../utils/background-job-persistence';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import {
  clearBackgroundJobSuppression,
  getBackgroundJobLifecycleLedger,
} from '../../utils/background-job-store';
import { STOP_CONFIRMATION_GRACE_MS } from '../../utils/background-job-terminal-gate';
import {
  classifyCurrentDeliveredRound,
  classifyV2HistoricalRound,
  fetchChildTranscript,
  orderTranscriptMessages,
  responseError,
  stringifyError,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { getClient } from '../../utils/opencode-client';
import { delay } from '../../utils/polling';
import { SESSION_ID_PATTERN } from '../../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../../utils/session-runtime-status';
import { parseTaskIdFromTaskOutput } from '../../utils/task';

const DEFAULT_STABLE_STOPPED_MS = 300;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 150;

export interface ChildRef {
  parentSessionID: string;
  agent: string;
  alias: string;
  sessionID: string;
}

export type RetainedRecoveryResult =
  | { kind: 'recovered'; taskID: string }
  | { kind: 'existing'; taskID: string }
  | {
      kind: 'adoptable';
      taskID: string;
      agent: string;
      description: string;
      deletionEpoch?: number;
    }
  | { kind: 'refused'; reason: string; reasonCode?: 'agent-unavailable' };

export interface RetainedRecoveryRequest {
  parentSessionID: string;
  requested: string;
  agent?: string;
  purpose?: 'revive';
  /** The upstream v1 exact-ID path, only when no transcript exists. */
  allowExactAdoption?: boolean;
}

export interface SessionRecoveryOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  isDisposed?: () => boolean;
  hostFlavor?: string;
  stableStoppedMs?: number;
  stopConfirmationBudgetMs?: number;
  statusPollIntervalMs?: number;
  liveStatusTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function unrecognizedTaskReferenceMessage(requested: string): string {
  const shown = requested.replace(/["\r\n]/g, '');
  return `The local task cache does not recognize this reference. It was not dropped; no new session was created. Call task_revive(task_id: "${shown}", prompt: "...") directly; it verifies the original host session and continues in that same session. This prompt was not sent.`;
}

export function createSessionRecovery(
  options: SessionRecoveryOptions,
): (request: RetainedRecoveryRequest) => Promise<RetainedRecoveryResult> {
  return (request) => recoverRetainedSession(options, request);
}

async function recoverRetainedSession(
  options: SessionRecoveryOptions,
  request: RetainedRecoveryRequest,
): Promise<RetainedRecoveryResult> {
  const parentSessionID = request.parentSessionID;
  const requested = request.requested.trim();
  const board = options.backgroundJobBoard;
  if (options.isDisposed?.()) return refuse('Session recovery was disposed');

  const client = getClient(options.input);
  const directory = options.input.directory;
  let sessionID = requested;
  let trustedAlias: string | undefined;
  if (!SESSION_ID_PATTERN.test(requested)) {
    const paired = await resolveAlias(
      client,
      directory,
      parentSessionID,
      requested,
      options.hostFlavor,
      options.isDisposed,
    );
    if (paired.kind !== 'ok') return paired;
    const cached = board.resolve(parentSessionID, requested);
    if (cached && cached.taskID !== paired.sessionID) {
      return refuse(
        aliasCacheConflictMessage(requested, paired.sessionID, cached.taskID),
      );
    }
    sessionID = paired.sessionID;
    trustedAlias = paired.alias;
  }

  const ledger = getBackgroundJobLifecycleLedger(board);
  const deletionEpoch = ledger.deletionEpochs.get(sessionID);
  const hosted = await readHostSession(client, directory, sessionID);
  const prefix = `Unknown or unowned background task: ${requested}`;
  const generic = `${prefix}. Tracking does not survive a host restart; verify whether the host restored it before re-dispatching.`;
  if (hosted.kind !== 'ok') {
    return request.purpose === 'revive' ? refuse(generic) : hosted;
  }
  if (hosted.parentID !== parentSessionID) {
    if (request.purpose === 'revive') return refuse(generic);
    return refuse(
      `Task ${sessionID} belongs to a different parent session; no prompt was sent`,
    );
  }
  if (options.isDisposed?.()) return refuse('Session recovery was disposed');
  if (ledger.deletionEpochs.get(sessionID) !== deletionEpoch) {
    return refuse(
      `Task ${sessionID} was deleted during recovery; no prompt was sent`,
    );
  }

  const raced = board.get(sessionID);
  if (raced) {
    if (raced.parentSessionID !== parentSessionID) {
      return refuse(
        `Task ${sessionID} belongs to a different parent session; no prompt was sent`,
      );
    }
    return { kind: 'existing', taskID: raced.taskID };
  }

  // #1388's live gate and persisted-result behavior precede any import.
  if (request.purpose === 'revive' && options.hostFlavor !== 'v2') {
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.liveStatusTimeoutMs ?? 1_500,
    });
    const liveStatus = snapshot.statuses.get(sessionID);
    if (liveStatus === 'busy' || liveStatus === 'retry') {
      return refuse(
        `${prefix}. The host is executing that session (it may have been restored after a restart); its result is still delivered on completion — do not re-dispatch.`,
      );
    }
    if (
      snapshot.error !== undefined ||
      snapshot.malformedSessionIDs.has(sessionID)
    ) {
      return refuse(
        `${prefix}. The host could not confirm the session state (${snapshot.error ?? 'malformed entry'}); retry task_revive.`,
      );
    }
    if (options.isDisposed?.()) return refuse('Session recovery was disposed');
    if (ledger.deletionEpochs.get(sessionID) !== deletionEpoch) {
      return refuse(
        `Task ${sessionID} was deleted during recovery; no prompt was sent`,
      );
    }
    const tombstone = getSuppressionTombstone(sessionID);
    if (tombstone?.terminalState !== undefined && tombstone.resultSummary) {
      clearBackgroundJobSuppression(board, sessionID);
      const ending =
        tombstone.terminalState === 'completed'
          ? 'completed'
          : `ended in state ${tombstone.terminalState}`;
      return refuse(
        `${prefix}. The session ${ending} before the tracking loss; its recorded result: ${tombstone.resultSummary}. Re-dispatch only if this result does not satisfy the objective.`,
      );
    }
  }

  const transcriptSourceAvailable =
    typeof client.session?.messages === 'function';
  let childTranscript: unknown;
  try {
    childTranscript = await fetchChildTranscript(client, sessionID, directory);
  } catch (error) {
    return refuse(
      `Task ${sessionID} transcript could not be read (${stringifyError(error)}); no prompt was sent`,
    );
  }
  const noTranscript =
    !transcriptSourceAvailable || isCompleteEmptyTranscript(childTranscript);
  if (
    noTranscript &&
    request.purpose === 'revive' &&
    request.allowExactAdoption &&
    options.hostFlavor !== 'v2' &&
    SESSION_ID_PATTERN.test(requested)
  ) {
    // Explicit upstream fallback, never a fallback from an evidence refusal.
    const parentTranscript = await readParentTranscript(
      client,
      directory,
      parentSessionID,
    );
    const agent = resolveAgent({
      sessionID,
      sessionAgent: hosted.agent,
      childTranscript,
      parentTranscript,
      parentSessionID,
    });
    if (agent.kind === 'refused' && agent.reasonCode !== 'agent-unavailable')
      return agent;
    if (options.isDisposed?.()) return refuse('Session recovery was disposed');
    if (ledger.deletionEpochs.get(sessionID) !== deletionEpoch) {
      return refuse(
        `Task ${sessionID} was deleted during recovery; no prompt was sent`,
      );
    }
    return {
      kind: 'adoptable',
      taskID: sessionID,
      agent: agent.kind === 'ok' ? agent.agent : 'unknown',
      description: hosted.title
        ? `recovered: ${hosted.title}`
        : 'recovered background task',
      deletionEpoch,
    };
  }
  if (childTranscript === undefined) {
    return refuse(
      `Task ${sessionID} transcript could not be read (transcript source unavailable); no prompt was sent`,
    );
  }
  const round =
    options.hostFlavor === 'v2'
      ? classifyV2HistoricalRound(childTranscript)
      : classifyCurrentDeliveredRound(childTranscript);
  if (round.verdict === 'unreadable') {
    return refuse(
      `Task ${sessionID} transcript could not be classified (${round.reason ?? 'unreadable'}); no prompt was sent`,
    );
  }
  if (options.hostFlavor === 'v2' && round.verdict === 'incomplete') {
    return refuse(
      `Task ${sessionID} has no verified historical terminal after its latest input. The current round was not imported. No prompt was sent`,
    );
  }

  const parentTranscript = await readParentTranscript(
    client,
    directory,
    parentSessionID,
  );
  const agent = resolveAgent({
    sessionID,
    sessionAgent: hosted.agent,
    childTranscript,
    parentTranscript,
    parentSessionID,
  });
  if (agent.kind !== 'ok') return agent;
  if (request.agent && request.agent !== agent.agent) {
    return refuse(
      `Task ${sessionID} agent is ${agent.agent}, not ${request.agent}. No prompt was sent`,
    );
  }

  const alias =
    trustedAlias ??
    (aliasHistoryProven(parentTranscript, parentSessionID, options.hostFlavor)
      ? trustedAliasForSession(parentTranscript, parentSessionID, sessionID)
      : undefined);
  const delegation = parentDelegation(
    parentTranscript,
    parentSessionID,
    sessionID,
  );
  const cancelMatched =
    round.startedAt !== undefined &&
    parentCancelMatchesRound(parentTranscript, sessionID, round.startedAt);

  let state: RestoreRetainedSessionInput['state'];
  if (round.verdict === 'completed' && !cancelMatched) state = 'completed';
  else if (round.verdict === 'error') state = 'error';
  else if (cancelMatched) state = 'cancelled';
  else state = 'stopped';

  const quiescent =
    options.hostFlavor === 'v2'
      ? { kind: 'ok' as const }
      : await confirmQuiescence(options, sessionID, state === 'stopped');
  if (quiescent.kind === 'refused') return quiescent;
  if (options.isDisposed?.()) return refuse('Session recovery was disposed');
  if (ledger.deletionEpochs.get(sessionID) !== deletionEpoch) {
    return refuse(
      `Task ${sessionID} was deleted during recovery; no prompt was sent`,
    );
  }
  const again = board.get(sessionID);
  if (again) {
    if (again.parentSessionID !== parentSessionID) {
      return refuse(
        `Task ${sessionID} belongs to a different parent session; no prompt was sent`,
      );
    }
    return { kind: 'existing', taskID: again.taskID };
  }

  const descriptionSource = delegation?.description;
  const promptSource = delegation?.prompt;
  const description = deriveTaskSessionLabel({
    description: descriptionSource,
    prompt: promptSource,
    agentType: agent.agent,
  });
  const objective = deriveFullObjective({
    description: descriptionSource,
    prompt: promptSource,
  });
  const launchedAt = round.startedAt ?? hosted.createdAt;
  const restored = board.restoreRetainedSession({
    taskID: sessionID,
    parentSessionID,
    agent: agent.agent,
    description:
      descriptionSource || promptSource
        ? description
        : `recovered ${agent.agent} session`,
    ...(objective !== undefined ? { objective } : {}),
    state,
    background: delegation?.background === true,
    ...(state === 'completed' && round.text !== undefined
      ? { resultSummary: round.text }
      : state === 'error' && round.text !== undefined
        ? { resultSummary: round.text }
        : state === 'cancelled'
          ? { resultSummary: 'cancelled' }
          : {
              resultSummary:
                'Recovered retained session stopped before a terminal result.',
            }),
    ...(alias !== undefined ? { alias } : {}),
    ...(launchedAt !== undefined ? { launchedAt } : {}),
    ...(state === 'completed' && round.completedAt !== undefined
      ? { completedAt: round.completedAt }
      : {}),
  });
  if (!restored) {
    const existing = board.resolve(parentSessionID, sessionID);
    if (existing) return { kind: 'existing', taskID: existing.taskID };
    return refuse(
      `Task ${sessionID} could not be imported without overwriting a newer row or lease; no prompt was sent`,
    );
  }
  return { kind: 'recovered', taskID: restored.taskID };
}

function isCompleteEmptyTranscript(response: unknown): boolean {
  if (
    !isRecord(response) ||
    responseError(response) !== undefined ||
    !Array.isArray(response.data) ||
    response.data.length !== 0 ||
    response.complete === false
  ) {
    return false;
  }
  const page = hasOwn(response, 'page') ? response.page : undefined;
  if (hasOwn(response, 'page') && !isRecord(page)) return false;
  const contextPage = sessionContextPage(response);
  if (contextPage && !contextPage.complete) return false;
  if (
    hasOwn(response, 'source') &&
    (!contextPage || response.source !== 'session.context')
  ) {
    return false;
  }
  if (isRecord(page)) {
    if (page.complete === false || (hasOwn(page, 'source') && !contextPage))
      return false;
    if (['next', 'previous', 'cursor'].some((key) => hasOwn(response, key)))
      return false;
  }
  const bag = isRecord(page) ? page : response;
  if (
    hasOwn(bag, 'cursor') &&
    (hasOwn(bag, 'next') ||
      hasOwn(bag, 'previous') ||
      (isRecord(bag.cursor) && bag.cursor.complete === false))
  ) {
    return false;
  }
  const links = pageLinks(response);
  return (
    links.mode === 'absent' ||
    (links.mode === 'links' && !links.next && !links.previous)
  );
}

function refuse(reason: string): RetainedRecoveryResult {
  return { kind: 'refused', reason };
}

async function confirmQuiescence(
  options: SessionRecoveryOptions,
  sessionID: string,
  requireStableStop: boolean,
): Promise<{ kind: 'ok' } | RetainedRecoveryResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const stableMs = Math.max(
    0,
    options.stableStoppedMs ?? DEFAULT_STABLE_STOPPED_MS,
  );
  const budget = Math.max(
    0,
    options.stopConfirmationBudgetMs ?? STOP_CONFIRMATION_GRACE_MS,
  );
  const interval = Math.max(
    0,
    options.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS,
  );
  const deadline = now() + (requireStableStop ? budget : 0);
  let stableSince: number | undefined;
  for (;;) {
    if (options.isDisposed?.()) return refuse('Session recovery was disposed');
    const read = await readLiveStatus(options.input, sessionID);
    if (read.kind !== 'quiescent') return read;
    if (!requireStableStop) return { kind: 'ok' };
    const clock = now();
    stableSince ??= clock;
    if (clock - stableSince >= stableMs) return { kind: 'ok' };
    if (clock >= deadline) {
      return refuse(
        `Task ${sessionID} did not stay stopped long enough to recover; no prompt was sent`,
      );
    }
    await sleep(Math.min(interval, Math.max(0, deadline - clock)));
    if (now() > deadline && now() - (stableSince ?? now()) < stableMs) {
      return refuse(
        `Task ${sessionID} did not stay stopped long enough to recover; no prompt was sent`,
      );
    }
  }
}

async function readLiveStatus(
  input: PluginInput,
  sessionID: string,
): Promise<{ kind: 'quiescent' } | RetainedRecoveryResult> {
  const snapshot = await getRuntimeSessionStatusSnapshot(input);
  if (
    snapshot.error !== undefined ||
    snapshot.malformedSessionIDs.has(sessionID)
  ) {
    return refuse(
      `Task ${sessionID} could not be verified against the live session map (${snapshot.error ?? 'malformed entry'}); no prompt was sent`,
    );
  }
  const status = runtimeSessionStatus(snapshot, sessionID);
  if (status === 'busy' || status === 'retry') {
    return refuse(
      `Task ${sessionID} is executing at the host (live status: ${status}); it was not imported and no prompt was sent`,
    );
  }
  if (status === 'idle' || status === undefined) return { kind: 'quiescent' };
  return refuse(
    `Task ${sessionID} could not be verified against the live session map (unrecognized status); no prompt was sent`,
  );
}

interface HostSession {
  kind: 'ok';
  parentID: string;
  agent?: string;
  createdAt?: number;
  title?: string;
}

async function readHostSession(
  client: PluginInput['client'],
  directory: string,
  sessionID: string,
): Promise<HostSession | RetainedRecoveryResult> {
  const session = client.session;
  if (typeof session?.get !== 'function') {
    return refuse(
      `Task ${sessionID} could not be read (session.get unavailable); no prompt was sent`,
    );
  }
  try {
    const response = await session.get({
      path: { id: sessionID },
      query: { directory },
    });
    const error = responseError(response);
    if (error !== undefined)
      return refuse(sessionReadRefusal(sessionID, error));
    const rawData = isRecord(response) ? response.data : undefined;
    const data = isRecord(rawData)
      ? (rawData as Record<string, unknown>)
      : undefined;
    const parentID =
      typeof data?.parentID === 'string' ? data.parentID : undefined;
    if (data?.id !== undefined && data.id !== sessionID) {
      return refuse(
        `Task ${sessionID} could not be read (session ID mismatch); no prompt was sent`,
      );
    }
    if (!parentID) {
      return refuse(
        `Task ${sessionID} could not be read (missing parent); no prompt was sent`,
      );
    }
    const agent =
      typeof data?.agent === 'string' ? data.agent.trim() : undefined;
    const createdAt =
      isRecord(data?.time) && typeof data.time.created === 'number'
        ? data.time.created
        : undefined;
    return {
      kind: 'ok',
      parentID,
      ...(agent ? { agent } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(typeof data?.title === 'string' && data.title
        ? { title: data.title }
        : {}),
    };
  } catch (error) {
    return refuse(sessionReadRefusal(sessionID, error));
  }
}

function sessionReadRefusal(sessionID: string, error: unknown): string {
  const text = stringifyError(error);
  if (/not found|\b404\b/i.test(text)) {
    return `Task ${sessionID} was not found on the host; no prompt was sent`;
  }
  return `Task ${sessionID} could not be read (${text}); no prompt was sent`;
}

async function readParentTranscript(
  client: PluginInput['client'],
  directory: string,
  parentSessionID: string,
): Promise<unknown> {
  try {
    return await fetchChildTranscript(client, parentSessionID, directory);
  } catch {
    return undefined;
  }
}

interface AgentDecision {
  kind: 'ok';
  agent: string;
}

function resolveAgent(input: {
  sessionID: string;
  sessionAgent?: string;
  childTranscript: unknown;
  parentTranscript: unknown;
  parentSessionID: string;
}): AgentDecision | RetainedRecoveryResult {
  const child = latestChildUserAgent(input.childTranscript);
  const parent = newestParentAgent(
    input.parentTranscript,
    input.parentSessionID,
    input.sessionID,
  );
  if (parent === 'conflict') {
    return refuse(
      `Task ${input.sessionID} agent evidence conflicts; no prompt was sent`,
    );
  }
  const chosen = preferNewerAgent(child, parent);
  if (chosen === 'conflict') {
    return refuse(
      `Task ${input.sessionID} agent evidence conflicts; no prompt was sent`,
    );
  }
  const agent = chosen?.agent ?? input.sessionAgent;
  if (!agent) {
    return {
      kind: 'refused',
      reason: `Task ${input.sessionID} agent could not be verified; no prompt was sent`,
      reasonCode: 'agent-unavailable',
    };
  }
  if (input.sessionAgent && input.sessionAgent !== agent) {
    return refuse(
      `Task ${input.sessionID} agent evidence conflicts; no prompt was sent`,
    );
  }
  return { kind: 'ok', agent };
}

interface TimedAgent {
  agent: string;
  at?: number;
}

function preferNewerAgent(
  left: TimedAgent | undefined,
  right: TimedAgent | undefined,
): TimedAgent | 'conflict' | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.agent === right.agent) {
    return (left.at ?? -1) >= (right.at ?? -1) ? left : right;
  }
  if (left.at === undefined || right.at === undefined || left.at === right.at) {
    return 'conflict';
  }
  return left.at > right.at ? left : right;
}

function latestChildUserAgent(transcript: unknown): TimedAgent | undefined {
  if (!isRecord(transcript) || !Array.isArray(transcript.data))
    return undefined;
  const messages = transcript.data.filter(isRecord);
  const ordered = orderTranscriptMessages(messages as never);
  if (ordered === 'unreadable') return undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    const rawInfo = message ? message.info : undefined;
    if (!isRecord(rawInfo) || rawInfo.role !== 'user') continue;
    const agent = typeof rawInfo.agent === 'string' ? rawInfo.agent.trim() : '';
    if (!agent) return undefined;
    return { agent, at: messageTime(message) };
  }
  return undefined;
}

function newestParentAgent(
  transcript: unknown,
  parentSessionID: string,
  sessionID: string,
): TimedAgent | 'conflict' | undefined {
  let chosen: TimedAgent | undefined;
  for (const pairing of parentTaskParts(transcript)) {
    if (pairing.sessionID !== sessionID || !pairing.agent) continue;
    if (pairing.ref && pairing.ref.parentSessionID !== parentSessionID)
      continue;
    if (pairing.ref && pairing.ref.agent !== pairing.agent) continue;
    const next = { agent: pairing.agent, at: pairing.at };
    const preferred = preferNewerAgent(chosen, next);
    if (preferred === 'conflict') return 'conflict';
    chosen = preferred;
  }
  return chosen;
}

interface ParentTaskPart {
  sessionID: string;
  agent?: string;
  alias?: string;
  at?: number;
  description?: string;
  prompt?: string;
  background?: boolean;
  ref?: ChildRef;
}

function parentDelegation(
  transcript: unknown,
  parentSessionID: string,
  sessionID: string,
): ParentTaskPart | undefined {
  let chosen: ParentTaskPart | undefined;
  for (const pairing of parentTaskParts(transcript)) {
    if (pairing.sessionID !== sessionID) continue;
    if (pairing.ref && pairing.ref.parentSessionID !== parentSessionID)
      continue;
    if (!chosen || (pairing.at ?? -1) >= (chosen.at ?? -1)) chosen = pairing;
  }
  return chosen;
}

function trustedAliasForSession(
  transcript: unknown,
  parentSessionID: string,
  sessionID: string,
): string | undefined {
  const aliases = new Set<string>();
  const sessionsForAlias = new Map<string, Set<string>>();
  for (const pairing of parentTaskParts(transcript)) {
    if (!pairing.ref || pairing.ref.parentSessionID !== parentSessionID)
      continue;
    if (pairing.agent && pairing.ref.agent !== pairing.agent) continue;
    const sessions = sessionsForAlias.get(pairing.ref.alias) ?? new Set();
    sessions.add(pairing.ref.sessionID);
    sessionsForAlias.set(pairing.ref.alias, sessions);
    if (pairing.ref.sessionID === sessionID) aliases.add(pairing.ref.alias);
  }
  if (aliases.size !== 1) return undefined;
  const alias = [...aliases][0];
  const sessions = alias ? sessionsForAlias.get(alias) : undefined;
  if (!alias || !sessions || sessions.size !== 1 || !sessions.has(sessionID))
    return undefined;
  return alias;
}

async function resolveAlias(
  client: PluginInput['client'],
  directory: string,
  parentSessionID: string,
  alias: string,
  hostFlavor?: string,
  isDisposed?: () => boolean,
): Promise<
  { kind: 'ok'; sessionID: string; alias: string } | RetainedRecoveryResult
> {
  const history = await readAliasHistory({
    client,
    directory,
    parentSessionID,
    hostFlavor,
    isDisposed,
  });
  if (!history.complete) {
    return refuse(aliasUnverifiedMessage(alias));
  }
  const sessions = history.targets.get(alias) ?? [];
  if (sessions.length === 0) {
    return refuse(aliasUnpairedMessage(alias));
  }
  if (sessions.length > 1) {
    return refuse(aliasMultipleTargetsMessage(alias, sessions));
  }
  return { kind: 'ok', sessionID: sessions[0] as string, alias };
}

function parentCancelMatchesRound(
  transcript: unknown,
  sessionID: string,
  roundStartedAt: number,
): boolean {
  if (!isRecord(transcript) || !Array.isArray(transcript.data)) return false;
  for (const message of transcript.data) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== 'tool') continue;
      if (delegationToolName(part) !== 'task_cancel') continue;
      const state = isRecord(part.state) ? part.state : undefined;
      const taskInput = isRecord(state?.input) ? state.input : undefined;
      const referenced =
        stringField(taskInput?.task_id) ?? stringField(taskInput?.sessionID);
      if (referenced !== sessionID) continue;
      const output = toolResultText(state);
      if (!/^state:\s*cancelled\s*$/im.test(output)) continue;
      const at = partEvidenceTime(part, state) ?? messageTime(message);
      if (at !== undefined && at >= roundStartedAt) return true;
    }
  }
  return false;
}

function parentTaskParts(transcript: unknown): ParentTaskPart[] {
  if (!isRecord(transcript) || !Array.isArray(transcript.data)) return [];
  const pairings: ParentTaskPart[] = [];
  for (const message of transcript.data) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== 'tool') continue;
      const toolName = delegationToolName(part);
      if (toolName !== 'task' && toolName !== 'subagent') continue;
      const state = isRecord(part.state) ? part.state : undefined;
      const output = toolResultText(state);
      const outerID = output ? parseTaskIdFromTaskOutput(output) : undefined;
      if (!outerID) continue;
      const taskInput = isRecord(state?.input) ? state.input : undefined;
      const explicitID =
        stringField(taskInput?.task_id) ?? stringField(taskInput?.sessionID);
      if (explicitID && explicitID !== outerID) continue;
      const agent =
        stringField(taskInput?.subagent_type) ?? stringField(taskInput?.agent);
      const ref = output ? readAuthoritativeChildRef(output) : undefined;
      if (ref && ref.sessionID !== outerID) continue;
      pairings.push({
        sessionID: outerID,
        ...(agent ? { agent } : {}),
        ...(ref ? { alias: ref.alias, ref } : {}),
        at: partEvidenceTime(part, state) ?? messageTime(message),
        ...(typeof taskInput?.description === 'string'
          ? { description: taskInput.description }
          : {}),
        ...(typeof taskInput?.prompt === 'string'
          ? { prompt: taskInput.prompt }
          : {}),
        ...(taskInput?.background === true ? { background: true } : {}),
      });
    }
  }
  return pairings;
}

export function appendChildRefSuffix(output: string, ref: ChildRef): string {
  const existing = readAuthoritativeChildRef(output);
  if (existing) return output;
  return `${output}\n${formatChildRef(ref)}`;
}

export function readAuthoritativeChildRef(
  output: string,
): ChildRef | undefined {
  const closeAt = lastOuterClose(output);
  if (closeAt < 0) return undefined;
  const tail = output.slice(closeAt).trim();
  const match = /^<!-- slim-child-ref:v1 (\{.*\}) -->$/.exec(tail);
  if (!match?.[1]) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (!isChildRef(parsed)) return undefined;
  const outerID = parseTaskIdFromTaskOutput(output);
  if (!outerID || outerID !== parsed.sessionID) return undefined;
  return parsed;
}

function formatChildRef(ref: ChildRef): string {
  return `<!-- slim-child-ref:v1 ${JSON.stringify({
    parentSessionID: ref.parentSessionID,
    agent: ref.agent,
    alias: ref.alias,
    sessionID: ref.sessionID,
  })} -->`;
}

function isChildRef(value: unknown): value is ChildRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'agent,alias,parentSessionID,sessionID') return false;
  return (
    nonEmpty(value.parentSessionID) &&
    nonEmpty(value.agent) &&
    nonEmpty(value.alias) &&
    nonEmpty(value.sessionID)
  );
}

function lastOuterClose(output: string): number {
  const lower = output.toLowerCase();
  let closeAt = -1;
  for (const tag of [
    '</task>',
    '</subagent>',
    '</task_result>',
    '</task_error>',
  ]) {
    const index = lower.lastIndexOf(tag);
    if (index >= 0) closeAt = Math.max(closeAt, index + tag.length);
  }
  return closeAt;
}

function messageTime(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.info)) return undefined;
  const time = message.info.time;
  if (!isRecord(time)) return undefined;
  if (typeof time.created === 'number' && Number.isFinite(time.created)) {
    return time.created;
  }
  if (typeof time.completed === 'number' && Number.isFinite(time.completed)) {
    return time.completed;
  }
  return undefined;
}

function delegationToolName(part: Record<string, unknown>): string | undefined {
  return stringField(part.tool) ?? stringField(part.name);
}

function toolResultText(state: Record<string, unknown> | undefined): string {
  if (!state) return '';
  if (typeof state.output === 'string' && state.output.length > 0) {
    return state.output;
  }
  if (!Array.isArray(state.content)) return '';
  return state.content
    .filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry.type === 'text' &&
        typeof entry.text === 'string',
    )
    .map((entry) => entry.text as string)
    .join('');
}

function partEvidenceTime(
  part: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): number | undefined {
  return finiteToolTime(part.time) ?? finiteToolTime(state?.time);
}

function finiteToolTime(time: unknown): number | undefined {
  if (!isRecord(time)) return undefined;
  for (const key of ['completed', 'end', 'ran', 'start', 'created'] as const) {
    const value = time[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const ALIAS_HISTORY_PAGE_LIMIT = 200;
const ALIAS_HISTORY_MAX_PAGES = 20;
const ALIAS_HISTORY_MAX_MESSAGES = 2_000;
const DEFAULT_ALIAS_PREPARE_TIMEOUT_MS = 1_500;

export type CanonicalTaskReference =
  | { kind: 'exact'; taskID: string }
  | { kind: 'refused'; reason: string };

export interface AliasAuthority {
  prepareParent(
    parentSessionID: string,
    excludeCallID?: string,
  ): Promise<{ enabled: boolean; stopped?: boolean }>;
  resolveCanonical(
    parentSessionID: string,
    requested: string,
    excludeCallID?: string,
  ): Promise<CanonicalTaskReference>;
}

export function aliasUnverifiedMessage(alias: string): string {
  return `Alias ${alias} could not be verified from host history. No action was sent. Use the exact session id, or retry the lookup.`;
}

export function aliasUnpairedMessage(alias: string): string {
  return `Alias ${alias} has no saved host pairing. No action was sent. Use the exact session id, or retry the lookup.`;
}

export function aliasMultipleTargetsMessage(
  alias: string,
  sessions: readonly string[],
): string {
  return `Alias ${alias} matches multiple saved targets: ${[...sessions].sort().join(', ')}. No action was sent. Use the exact session id.`;
}

export function aliasCacheConflictMessage(
  alias: string,
  hostSessionID: string,
  cacheSessionID: string,
): string {
  return `Alias ${alias} conflicts with the local cache (host session ${hostSessionID}, local cache ${cacheSessionID}). No action was sent. Use the exact session id.`;
}

/** Model-visible degrade note. Stays before the outer close so the child-ref tail is unchanged. */
export function noteExactSessionAlias(output: string, taskID: string): string {
  const note = `Refer by the exact session id ${taskID}.`;
  const closeAt = lastOuterClose(output);
  if (closeAt < 0) return `${output}\n${note}`;
  const lower = output.toLowerCase();
  let tagStart = -1;
  for (const tag of [
    '</task>',
    '</subagent>',
    '</task_result>',
    '</task_error>',
  ]) {
    const index = lower.lastIndexOf(tag);
    if (index >= 0 && index + tag.length === closeAt) tagStart = index;
  }
  if (tagStart < 0) return `${output}\n${note}`;
  return `${output.slice(0, tagStart)}${note}\n${output.slice(tagStart)}`;
}

interface AliasHistory {
  complete: boolean;
  maxima: Record<string, number>;
  targets: Map<string, string[]>;
  stopped?: boolean;
  timedOut?: boolean;
}

export function pluginDisposedMessage(): string {
  return 'The plugin instance was disposed. No action was sent.';
}

export function createAliasAuthority(options: {
  input: PluginInput;
  board: BackgroundJobBoard;
  isDisposed?: () => boolean;
  hostFlavor?: string;
  timeoutMs?: number;
}): AliasAuthority {
  const inflight = new Map<
    string,
    Promise<{ enabled: boolean; stopped?: boolean }>
  >();
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? DEFAULT_ALIAS_PREPARE_TIMEOUT_MS,
  );

  async function prepareParent(
    parentSessionID: string,
    excludeCallID?: string,
  ): Promise<{ enabled: boolean; stopped?: boolean }> {
    const parent = parentSessionID.trim();
    if (!parent || options.isDisposed?.()) {
      return { enabled: false, stopped: true };
    }
    if (options.board.isNumberedAliasReady(parent)) return { enabled: true };
    const pending = inflight.get(parent);
    if (pending) return pending;
    const slot: { raced?: Promise<{ enabled: boolean; stopped?: boolean }> } =
      {};
    const run = (async (): Promise<{ enabled: boolean; stopped?: boolean }> => {
      const history = await readAliasHistory({
        client: getClient(options.input),
        directory: options.input.directory,
        parentSessionID: parent,
        hostFlavor: options.hostFlavor,
        excludeCallID,
        isDisposed: options.isDisposed,
        deadlineAt: Date.now() + timeoutMs,
      });
      if (history.stopped || options.isDisposed?.()) {
        return { enabled: false, stopped: true };
      }
      if (history.timedOut || !history.complete) return { enabled: false };
      if (options.isDisposed?.()) return { enabled: false, stopped: true };
      return {
        enabled: options.board.applyVerifiedAliasFloor(parent, history.maxima),
      };
    })();
    const raced = run.finally(() => {
      if (slot.raced && inflight.get(parent) === slot.raced) {
        inflight.delete(parent);
      }
    });
    slot.raced = raced;
    inflight.set(parent, raced);
    return raced;
  }

  async function resolveCanonical(
    parentSessionID: string,
    requested: string,
    excludeCallID?: string,
  ): Promise<CanonicalTaskReference> {
    const alias = requested.trim();
    if (SESSION_ID_PATTERN.test(alias)) {
      return { kind: 'exact', taskID: alias };
    }
    if (options.isDisposed?.()) {
      return { kind: 'refused', reason: pluginDisposedMessage() };
    }
    const history = await readAliasHistory({
      client: getClient(options.input),
      directory: options.input.directory,
      parentSessionID,
      hostFlavor: options.hostFlavor,
      excludeCallID,
      isDisposed: options.isDisposed,
      deadlineAt: Date.now() + timeoutMs,
    });
    if (history.stopped || options.isDisposed?.()) {
      return { kind: 'refused', reason: pluginDisposedMessage() };
    }
    if (!history.complete) {
      return { kind: 'refused', reason: aliasUnverifiedMessage(alias) };
    }
    const sessions = history.targets.get(alias) ?? [];
    if (sessions.length === 0) {
      return { kind: 'refused', reason: aliasUnpairedMessage(alias) };
    }
    if (sessions.length > 1) {
      return {
        kind: 'refused',
        reason: aliasMultipleTargetsMessage(alias, sessions),
      };
    }
    const hostSessionID = sessions[0] as string;
    const cached = options.board.resolve(parentSessionID, alias);
    if (cached && cached.taskID !== hostSessionID) {
      return {
        kind: 'refused',
        reason: aliasCacheConflictMessage(alias, hostSessionID, cached.taskID),
      };
    }
    if (options.isDisposed?.()) {
      return { kind: 'refused', reason: pluginDisposedMessage() };
    }
    return { kind: 'exact', taskID: hostSessionID };
  }

  return { prepareParent, resolveCanonical };
}

async function readAliasHistory(input: {
  client: PluginInput['client'];
  directory: string;
  parentSessionID: string;
  hostFlavor?: string;
  excludeCallID?: string;
  isDisposed?: () => boolean;
  deadlineAt?: number;
}): Promise<AliasHistory> {
  const empty = (flags?: {
    stopped?: boolean;
    timedOut?: boolean;
  }): AliasHistory => ({
    complete: false,
    maxima: {},
    targets: new Map(),
    ...flags,
  });
  const session = input.client.session;
  const messages =
    typeof session?.messages === 'function'
      ? session.messages.bind(session)
      : undefined;
  if (typeof messages !== 'function') return empty();
  const collected: unknown[] = [];
  const seenCursors = new Set<string>();
  const pendingCursors: string[] = [];
  let proven = input.hostFlavor !== 'v2';
  const timedOut = (): AliasHistory => empty({ timedOut: true });
  const stopped = (): AliasHistory => empty({ stopped: true });
  try {
    for (let page = 0; page < ALIAS_HISTORY_MAX_PAGES; page += 1) {
      if (input.isDisposed?.()) return stopped();
      if (pastDeadline(input.deadlineAt)) return timedOut();
      const cursor = pendingCursors.shift();
      const query: Record<string, unknown> = { directory: input.directory };
      if (cursor) {
        query.limit = ALIAS_HISTORY_PAGE_LIMIT;
        query.cursor = cursor;
      }
      const response = await readAliasPage(
        messages,
        { path: { id: input.parentSessionID }, query },
        input.deadlineAt,
      );
      if (response === 'timeout') return timedOut();
      if (input.isDisposed?.()) return stopped();
      if (responseError(response) !== undefined) return empty();
      const contextPage = sessionContextPage(response);
      if (contextPage) {
        if (!contextPage.complete) return empty();
        collected.push(...contextPage.data);
        if (collected.length > ALIAS_HISTORY_MAX_MESSAGES) return empty();
        proven = true;
        break;
      }
      const list = messagePage(response);
      if (!list) return empty();
      collected.push(...list);
      if (collected.length > ALIAS_HISTORY_MAX_MESSAGES) return empty();
      const links = pageLinks(response);
      if (links.mode === 'truncated') return empty();
      if (links.mode === 'absent') {
        if (cursor || pendingCursors.length > 0) return empty();
        break;
      }
      proven = true;
      if (!enqueueCursor(links.next, seenCursors, pendingCursors))
        return empty();
      if (!enqueueCursor(links.previous, seenCursors, pendingCursors)) {
        return empty();
      }
      if (pendingCursors.length === 0) break;
      if (page + 1 >= ALIAS_HISTORY_MAX_PAGES) return empty();
    }
    if (pendingCursors.length > 0) return empty();
  } catch {
    if (input.isDisposed?.()) return stopped();
    return empty();
  }
  if (input.isDisposed?.()) return stopped();
  if (!proven) return empty();
  return assessAliasHistory(
    { data: collected },
    input.parentSessionID,
    input.excludeCallID,
  );
}

function aliasHistoryProven(
  transcript: unknown,
  parentSessionID: string,
  hostFlavor?: string,
): boolean {
  const contextPage = sessionContextPage(transcript);
  if (contextPage) {
    return (
      contextPage.complete &&
      assessAliasHistory(transcript, parentSessionID).complete
    );
  }
  const links = pageLinks(transcript);
  if (links.mode === 'truncated') return false;
  if (hostFlavor === 'v2' && links.mode === 'absent') return false;
  if (links.mode === 'links' && (links.next || links.previous)) return false;
  return assessAliasHistory(transcript, parentSessionID).complete;
}

function pastDeadline(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

async function readAliasPage(
  messages: (args: {
    path: { id: string };
    query: Record<string, unknown>;
  }) => Promise<unknown>,
  args: { path: { id: string }; query: Record<string, unknown> },
  deadlineAt: number | undefined,
): Promise<unknown | 'timeout'> {
  if (deadlineAt === undefined) return messages(args);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return 'timeout';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), remaining);
  });
  try {
    return await Promise.race([messages(args), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionContextPage(
  response: unknown,
): { data: unknown[]; complete: boolean } | undefined {
  if (!isRecord(response) || !isRecord(response.page)) return undefined;
  if (response.page.source !== 'session.context') return undefined;
  if (!Array.isArray(response.data)) return undefined;
  return { data: response.data, complete: response.page.complete === true };
}

function messagePage(response: unknown): unknown[] | undefined {
  if (Array.isArray(response)) return response;
  if (!isRecord(response)) return undefined;
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.messages)) return response.messages;
  return undefined;
}

type PageLinks =
  | { mode: 'absent' }
  | { mode: 'truncated' }
  | { mode: 'links'; next?: string; previous?: string };

const SUPPORTED_CURSOR_KEYS = new Set(['next', 'previous']);

function pageLinks(response: unknown): PageLinks {
  if (!isRecord(response)) return { mode: 'absent' };
  if (markedIncomplete(response)) return { mode: 'truncated' };
  const bag =
    hasOwn(response, 'page') && isRecord(response.page)
      ? response.page
      : response;
  if (bag !== response && markedIncomplete(bag)) return { mode: 'truncated' };
  if (hasOwn(bag, 'cursor')) {
    if (typeof bag.cursor === 'string') {
      if (hasOwn(bag, 'next') || hasOwn(bag, 'previous')) {
        return { mode: 'truncated' };
      }
      const token = bag.cursor.trim();
      return token ? { mode: 'links', next: token } : { mode: 'truncated' };
    }
    if (!isRecord(bag.cursor)) return { mode: 'truncated' };
  }
  const cursor =
    hasOwn(bag, 'cursor') && isRecord(bag.cursor) ? bag.cursor : undefined;
  if (cursor && (markedIncomplete(cursor) || unknownCursorKeys(cursor))) {
    return { mode: 'truncated' };
  }
  if (
    cursor &&
    Object.keys(cursor).length === 0 &&
    !hasOwn(bag, 'next') &&
    !hasOwn(bag, 'previous')
  ) {
    return { mode: 'truncated' };
  }
  const hasNext =
    hasOwn(bag, 'next') || (cursor ? hasOwn(cursor, 'next') : false);
  const hasPrevious =
    hasOwn(bag, 'previous') || (cursor ? hasOwn(cursor, 'previous') : false);
  if (!hasNext && !hasPrevious) return { mode: 'absent' };
  const nextRaw = hasOwn(bag, 'next')
    ? bag.next
    : cursor && hasOwn(cursor, 'next')
      ? cursor.next
      : undefined;
  const previousRaw = hasOwn(bag, 'previous')
    ? bag.previous
    : cursor && hasOwn(cursor, 'previous')
      ? cursor.previous
      : undefined;
  if (
    (hasNext && illegalCursor(nextRaw)) ||
    (hasPrevious && illegalCursor(previousRaw))
  ) {
    return { mode: 'truncated' };
  }
  return {
    mode: 'links',
    next: cursorString(nextRaw),
    previous: cursorString(previousRaw),
  };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function markedIncomplete(record: Record<string, unknown>): boolean {
  return (
    record.truncated === true ||
    record.incomplete === true ||
    record.hasMore === true ||
    record.has_more === true
  );
}

function unknownCursorKeys(cursor: Record<string, unknown>): boolean {
  return Object.keys(cursor).some((key) => !SUPPORTED_CURSOR_KEYS.has(key));
}

function illegalCursor(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string';
}

function cursorString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function enqueueCursor(
  cursor: string | undefined,
  seen: Set<string>,
  pending: string[],
): boolean {
  if (!cursor) return true;
  if (seen.has(cursor)) return false;
  seen.add(cursor);
  pending.push(cursor);
  return true;
}

function assessAliasHistory(
  transcript: unknown,
  parentSessionID: string,
  excludeCallID?: string,
): AliasHistory {
  const empty: AliasHistory = {
    complete: false,
    maxima: {},
    targets: new Map(),
  };
  if (!isRecord(transcript) || !Array.isArray(transcript.data)) return empty;
  const maxima: Record<string, number> = {};
  const targetSets = new Map<string, Set<string>>();
  const firstRound = new Map<string, Set<string>>();
  const continuations: Array<{ explicitID: string; outerID: string }> = [];
  const excluded = excludeCallID?.trim();
  for (const message of transcript.data) {
    if (!isRecord(message)) return empty;
    if (isCompactionMessage(message)) return empty;
    const parts = Array.isArray(message.parts)
      ? message.parts
      : Array.isArray(message.content)
        ? message.content
        : undefined;
    if (!parts) {
      if (partlessMessage(message)) continue;
      return empty;
    }
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (isCompactionPart(part)) return empty;
      if (part.type !== 'tool') continue;
      const toolName = delegationToolName(part);
      if (toolName !== 'task' && toolName !== 'subagent') continue;
      const state = isRecord(part.state) ? part.state : undefined;
      const output = toolResultText(state);
      const outerID = output ? parseTaskIdFromTaskOutput(output) : undefined;
      const callID = toolCallID(part, state);
      if (!outerID) {
        if (excluded && callID === excluded) continue;
        return empty;
      }
      const taskInput = isRecord(state?.input) ? state.input : undefined;
      const explicitID =
        stringField(taskInput?.task_id) ?? stringField(taskInput?.sessionID);
      const agent =
        stringField(taskInput?.subagent_type) ?? stringField(taskInput?.agent);
      const ref = readAuthoritativeChildRef(output);
      if (
        !agent ||
        !ref ||
        ref.sessionID !== outerID ||
        ref.parentSessionID !== parentSessionID ||
        ref.agent !== agent
      ) {
        return empty;
      }
      if (
        explicitID &&
        SESSION_ID_PATTERN.test(explicitID) &&
        explicitID !== outerID
      ) {
        return empty;
      }
      const numbered = numberedAliasCounter(ref.agent, ref.alias);
      if (numbered === 'overflow') return empty;
      if (numbered) {
        maxima[numbered.prefix] = Math.max(
          maxima[numbered.prefix] ?? 0,
          numbered.counter,
        );
      }
      const sessions = targetSets.get(ref.alias) ?? new Set<string>();
      sessions.add(ref.sessionID);
      targetSets.set(ref.alias, sessions);
      if (explicitID && explicitID !== outerID) {
        continuations.push({ explicitID, outerID });
      } else {
        const saved = firstRound.get(ref.alias) ?? new Set<string>();
        saved.add(ref.sessionID);
        firstRound.set(ref.alias, saved);
      }
    }
  }
  for (const continuation of continuations) {
    const saved = firstRound.get(continuation.explicitID);
    if (saved?.size !== 1 || !saved?.has(continuation.outerID)) {
      return empty;
    }
  }
  return {
    complete: true,
    maxima,
    targets: new Map(
      [...targetSets].map(([alias, sessions]) => [alias, [...sessions].sort()]),
    ),
  };
}

function numberedAliasCounter(
  agent: string,
  alias: string,
): { prefix: string; counter: number } | 'overflow' | undefined {
  const prefix = aliasPrefixForAgent(agent);
  const match = new RegExp(`^${escapeAliasPrefix(prefix)}-([0-9]+)$`).exec(
    alias,
  );
  if (!match?.[1]) return undefined;
  const counter = Number(match[1]);
  if (
    !Number.isSafeInteger(counter) ||
    counter < 1 ||
    counter >= Number.MAX_SAFE_INTEGER
  ) {
    return 'overflow';
  }
  return { prefix, counter };
}

function toolCallID(
  part: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): string | undefined {
  return (
    stringField(part.callID) ??
    stringField(part.callId) ??
    stringField(part.id) ??
    stringField(part.toolCallId) ??
    stringField(state?.callID)
  );
}

function partlessMessage(message: Record<string, unknown>): boolean {
  const type = stringField(message.type) ?? stringField(message.role);
  if (type === 'idle') return true;
  const info = isRecord(message.info) ? message.info : undefined;
  const role = stringField(info?.role) ?? type;
  return (
    (role === 'user' || role === 'system') && typeof message.text === 'string'
  );
}

function isCompactionMessage(message: Record<string, unknown>): boolean {
  if (message.type === 'compaction' || message.type === 'compact') return true;
  if (message.compacted === true || message.truncated === true) return true;
  const info = isRecord(message.info) ? message.info : undefined;
  if (!info) return false;
  return (
    info.role === 'compaction' ||
    info.sourceType === 'compaction' ||
    info.compacted === true ||
    info.truncated === true
  );
}

function isCompactionPart(part: Record<string, unknown>): boolean {
  const type = stringField(part.type);
  return type === 'compaction' || type === 'compact' || part.compacted === true;
}

function escapeAliasPrefix(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
