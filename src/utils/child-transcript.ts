/**
 * Shared child-session transcript evidence extraction and fetch.
 *
 * Two consumers need "what did the child session end with?":
 * - `revived-run-tracker` (revive probes, strict v1 transcript shape)
 * - the quiescent host-outcome settle path in `task-session-manager`
 *   (v2 shim shape — `info` carries only `{id, role}`; terminality is
 *   confirmed upstream via `Session.Info.outcome`)
 *
 * Both previously carried their own (and subtly different) extraction
 * logic. This module is the single source of truth for reading a v1-style
 * `{data: [{info, parts}]}` messages response and classifying the
 * trailing assistant turn — and for fetching that transcript:
 * `fetchChildTranscript` binds the client's `session.messages` endpoint
 * (degraded hosts may not expose it) and surfaces `response.error` as a
 * normalized `Error`, replacing the bind/call/unwrap boilerplate that was
 * previously duplicated at every call site. `responseError` and
 * `stringifyError` are the shared response-error extraction and error-text
 * helpers for session-endpoint call sites (revive probes, notification
 * transport, task cancellation).
 */

import type { PluginInput } from '@opencode-ai/plugin';

import { isRecord } from './guards';

export type ChildTerminalEvidence =
  | { kind: 'ready'; text: string }
  | { kind: 'textless' }
  | { kind: 'pending' }
  | { kind: 'error'; errorText: string }
  | { kind: 'no-assistant' };

/**
 * Fetch a child session's transcript via `client.session.messages`.
 *
 * Returns the raw response, or `undefined` when the host client does not
 * expose a callable `session.messages` endpoint (degraded hosts) — each
 * call site decides how to degrade. Transport failures propagate to the
 * caller. A `response.error` payload is surfaced as a normalized `Error`
 * whose message is `stringifyError(response.error)`, matching the
 * error-surfacing style previously duplicated at the call sites.
 *
 * `limit` asks the host for only the newest N messages (still oldest-first);
 * a host that ignores it returns the whole transcript, so callers must
 * tolerate either.
 */
export async function fetchChildTranscript(
  client: PluginInput['client'],
  sessionID: string,
  directory: string,
  limit?: number,
): Promise<unknown> {
  const session = client.session;
  const messages =
    typeof session?.messages === 'function'
      ? session.messages.bind(session)
      : undefined;
  if (typeof messages !== 'function') return undefined;
  const response = await messages({
    path: { id: sessionID },
    query: { directory, limit },
  });
  const error = responseError(response);
  if (error !== undefined) throw new Error(stringifyError(error));
  return response;
}

/** Extract a non-null `response.error` payload from an SDK-style
 * response; `undefined` when the response carries no error. */
export function responseError(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  return response.error === undefined || response.error === null
    ? undefined
    : response.error;
}

/** Normalize an unknown error payload to a displayable message string. */
export function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    if (error instanceof Error)
      return JSON.stringify({ name: error.name, ...(error as object) });
    const serialized = JSON.stringify(error);
    return serialized ?? String(error);
  } catch {
    return String(error);
  }
}

interface LooseMessage {
  info?: {
    id?: unknown;
    role?: unknown;
    parentID?: unknown;
    agent?: unknown;
    sourceType?: unknown;
    outcome?: unknown;
    error?: unknown;
    finish?: unknown;
    time?: { created?: unknown; completed?: unknown };
  };
  parts?: unknown[];
}

export type TranscriptMessage = LooseMessage;

export type TerminalEvidenceVerdict =
  | { verdict: 'completed'; text: string }
  | { verdict: 'error'; text: string }
  | { verdict: 'absent' }
  | { verdict: 'retry'; reason: string };

function verdictFromEvidence(
  evidence: ChildTerminalEvidence,
): TerminalEvidenceVerdict {
  switch (evidence.kind) {
    case 'ready':
      return { verdict: 'completed', text: evidence.text };
    case 'error':
      return { verdict: 'error', text: evidence.errorText };
    case 'pending':
      return { verdict: 'retry', reason: 'pending' };
    case 'textless':
      return { verdict: 'retry', reason: 'textless' };
    default:
      return { verdict: 'retry', reason: 'unrecognized segment shape' };
  }
}

/** A valid absence is not unknown evidence. Never scan through a user prompt
 * or pending assistant placeholder to recover the previous attempt's answer. */
export function classifyTerminalEvidence(
  response: unknown,
  options: {
    baselineMessageID?: string;
    runStartedAt?: number;
    terminalOutcomeConfirmed?: boolean;
  } = {},
): TerminalEvidenceVerdict {
  if (response === undefined)
    return { verdict: 'retry', reason: 'transcript source unavailable' };
  if (responseError(response) !== undefined)
    return { verdict: 'retry', reason: 'transcript read failed' };
  if (!isRecord(response) || !Array.isArray(response.data))
    return { verdict: 'retry', reason: 'malformed transcript response' };
  const all: TranscriptMessage[] = [];
  for (const entry of response.data) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.info) ||
      (!['assistant', 'user', 'system'].includes(String(entry.info.role)) &&
        typeof entry.info.id !== 'string')
    ) {
      return { verdict: 'retry', reason: 'malformed transcript entries' };
    }
    all.push(entry);
    if (
      entry.parts !== undefined &&
      (!Array.isArray(entry.parts) ||
        entry.parts.some(
          (part) => !isRecord(part) || typeof part.type !== 'string',
        ))
    )
      return { verdict: 'retry', reason: 'malformed transcript parts' };
  }
  if (options.baselineMessageID) {
    const baseline = all.findIndex(
      (message) => message.info?.id === options.baselineMessageID,
    );
    if (baseline < 0)
      return { verdict: 'retry', reason: 'baseline message missing' };
    const segment = all.slice(baseline + 1);
    let target = segment.length - 1;
    while (target >= 0) {
      const role = segment[target].info?.role;
      if (typeof role !== 'string' || role === 'assistant' || role === 'user')
        break;
      target -= 1;
    }
    if (target < 0) return { verdict: 'absent' };
    if (segment[target].info?.role === 'user') {
      return segment.some((message) => message.info?.role === 'assistant')
        ? { verdict: 'retry', reason: 'user message after last assistant' }
        : { verdict: 'absent' };
    }
    return verdictFromEvidence(
      classifyAssistantTurnEvidence(
        all,
        baseline + 1 + target,
        baseline,
        !options.terminalOutcomeConfirmed,
      ),
    );
  }
  let target = all.length - 1;
  while (target >= 0 && all[target].info?.role === 'system') target--;
  const trailing = all[target];
  if (!trailing || trailing.info?.role === 'user') return { verdict: 'absent' };
  if (trailing.info?.role !== 'assistant')
    return {
      verdict: 'retry',
      reason: 'no baseline; cannot attribute a historical assistant turn',
    };
  const completedAt = trailing.info?.time?.completed;
  if (
    options.runStartedAt !== undefined &&
    typeof completedAt === 'number' &&
    completedAt < options.runStartedAt
  )
    return { verdict: 'absent' };
  return verdictFromEvidence(
    classifyAssistantTurnEvidence(
      all,
      target,
      -1,
      !options.terminalOutcomeConfirmed,
    ),
  );
}

/**
 * Single source of truth for classifying ONE assistant turn as the
 * terminal evidence of a run: pending finish states, completion time,
 * segment-wide pending tool calls, terminal error precedence, and
 * usable text. Both the revived-run tracker probe and the stop gate's
 * evidence classifier delegate here so their terminality contracts
 * cannot diverge (a second independent classifier had already dropped
 * the pending-tool rule).
 */
export function classifyAssistantTurnEvidence(
  messages: TranscriptMessage[],
  targetIndex: number,
  baselineIndex: number,
  requireCompletionTime = true,
): ChildTerminalEvidence {
  const last = messages[targetIndex];
  if (last?.info?.role !== 'assistant') return { kind: 'no-assistant' };

  // Terminal error precedence: an assistant turn that carries a
  // terminal error is an error EVEN when a residual `finish` value
  // (e.g. 'tool-calls'/'unknown') survived the failure — the error is
  // the outcome, the finish flag is leftover state.
  if (last.info?.error !== undefined && last.info?.error !== null) {
    return { kind: 'error', errorText: stringifyError(last.info.error) };
  }

  const finish = last.info?.finish;
  if (finish === 'tool-calls' || finish === 'unknown') {
    return { kind: 'pending' };
  }
  if (
    requireCompletionTime &&
    !(isRecord(last.info?.time) && typeof last.info.time.completed === 'number')
  ) {
    return { kind: 'pending' };
  }

  const postBaseline = messages.slice(baselineIndex + 1);
  const hasPendingToolCall = postBaseline.some((message) =>
    (Array.isArray(message.parts) ? message.parts : []).some((part) => {
      if (!isRecord(part) || part.type !== 'tool') return false;
      const status = isRecord(part.state)
        ? typeof part.state.status === 'string'
          ? part.state.status
          : undefined
        : undefined;
      return status !== 'completed' && status !== 'error';
    }),
  );
  if (hasPendingToolCall) return { kind: 'pending' };

  const text = (Array.isArray(last.parts) ? last.parts : [])
    .filter(
      (part) =>
        isRecord(part) &&
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.length > 0,
    )
    .map((part) => (part as { text: string }).text)
    .join('\n\n')
    .trim();
  return text.length > 0 ? { kind: 'ready', text } : { kind: 'textless' };
}

export interface CurrentRoundClassification {
  verdict: 'completed' | 'error' | 'interrupted' | 'incomplete' | 'unreadable';
  text?: string;
  reason?: string;
  /** Timestamp of the latest delivered user message, when the host provided one. */
  startedAt?: number;
  /** Assistant completion time for this round, when the host provided one. */
  completedAt?: number;
}

function transcriptOrderKey(message: TranscriptMessage): number | undefined {
  const time = message.info?.time;
  if (!isRecord(time)) return undefined;
  if (typeof time.created === 'number' && Number.isFinite(time.created)) {
    return time.created;
  }
  if (typeof time.completed === 'number' && Number.isFinite(time.completed)) {
    return time.completed;
  }
  return undefined;
}

function assistantCompletedAt(message: TranscriptMessage): number | undefined {
  const time = message.info?.time;
  if (!isRecord(time)) return undefined;
  return typeof time.completed === 'number' && Number.isFinite(time.completed)
    ? time.completed
    : undefined;
}

function isInterruptSignal(message: TranscriptMessage): boolean {
  const finish = message.info?.finish;
  if (finish === 'abort' || finish === 'aborted') return true;
  const error = message.info?.error;
  if (error === undefined || error === null) return false;
  const text = stringifyError(error).toLowerCase();
  return text.includes('abort') || text.includes('interrupted');
}

function messageIdentity(message: TranscriptMessage): string | undefined {
  const id = message.info?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function messageParentIdentity(message: TranscriptMessage): string | undefined {
  const parentID = message.info?.parentID;
  return typeof parentID === 'string' && parentID.length > 0
    ? parentID
    : undefined;
}

function finiteCreated(message: TranscriptMessage): number | undefined {
  const time = message.info?.time;
  return isRecord(time) &&
    typeof time.created === 'number' &&
    Number.isFinite(time.created)
    ? time.created
    : undefined;
}

function exclusiveEqualCreatedLink(
  rows: Array<{
    message: TranscriptMessage;
    time: number | undefined;
    id?: string;
  }>,
  parent: { message: TranscriptMessage; time: number | undefined; id?: string },
  child: { message: TranscriptMessage; id?: string; parentID?: string },
): boolean {
  if (
    parent.message.info?.role !== 'user' ||
    child.message.info?.role !== 'assistant'
  ) {
    return false;
  }
  const parentCreated = finiteCreated(parent.message);
  const childCreated = finiteCreated(child.message);
  if (
    !parent.id ||
    !child.id ||
    child.parentID !== parent.id ||
    parentCreated === undefined ||
    parentCreated !== childCreated
  ) {
    return false;
  }
  const bucket = rows.filter((item) => item.time === parent.time);
  return bucket.length === 2 && bucket.every((item) => item.id);
}

/**
 * Order a transcript without trusting array position.
 * Different timestamps sort by time. Equal timestamps use an assistant
 * parentID link or the host message id. A tie that cannot be proved is
 * unreadable; the array is not reversed as a guess.
 */
export function orderTranscriptMessages(
  messages: TranscriptMessage[],
): TranscriptMessage[] | 'unreadable' {
  const rows = messages.map((message) => ({
    message,
    time: transcriptOrderKey(message),
    id: messageIdentity(message),
    parentID: messageParentIdentity(message),
  }));
  if (rows.some((row) => row.time === undefined)) return 'unreadable';
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id) continue;
    if (seen.has(row.id)) return 'unreadable';
    seen.add(row.id);
  }
  for (const row of rows) {
    if (!row.parentID) continue;
    if (row.parentID === row.id) return 'unreadable';
    const parent = rows.find((item) => item.id === row.parentID);
    if (!parent || parent.time === undefined || row.time === undefined)
      continue;
    if (parent.time > row.time) return 'unreadable';
    if (
      parent.time === row.time &&
      parent.id &&
      row.id &&
      parent.id > row.id &&
      !exclusiveEqualCreatedLink(rows, parent, row)
    ) {
      return 'unreadable';
    }
  }
  let unreadable = false;
  const sorted = [...rows].sort((left, right) => {
    if (left.time !== right.time) return (left.time ?? 0) - (right.time ?? 0);
    if (left.parentID && left.parentID === right.id) return 1;
    if (right.parentID && right.parentID === left.id) return -1;
    if (left.id && right.id) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }
    unreadable = true;
    return 0;
  });
  return unreadable ? 'unreadable' : sorted.map((row) => row.message);
}

/**
 * Classify only the latest delivered user round.
 *
 * Pending tool parts from an older round do not block a later completed
 * round, and an older assistant answer is not reused once a newer user
 * message exists.
 */
export function classifyCurrentDeliveredRound(
  response: unknown,
): CurrentRoundClassification {
  if (response === undefined) {
    return {
      verdict: 'unreadable',
      reason: 'transcript source unavailable',
    };
  }
  if (responseError(response) !== undefined) {
    return { verdict: 'unreadable', reason: 'transcript read failed' };
  }
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return { verdict: 'unreadable', reason: 'malformed transcript response' };
  }

  const messages: TranscriptMessage[] = [];
  for (const entry of response.data) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.info) ||
      (!['assistant', 'user', 'system'].includes(String(entry.info.role)) &&
        typeof entry.info.id !== 'string')
    ) {
      return { verdict: 'unreadable', reason: 'malformed transcript entries' };
    }
    if (
      entry.parts !== undefined &&
      (!Array.isArray(entry.parts) ||
        entry.parts.some(
          (part) => !isRecord(part) || typeof part.type !== 'string',
        ))
    ) {
      return { verdict: 'unreadable', reason: 'malformed transcript parts' };
    }
    messages.push(entry);
  }

  const sorted = orderTranscriptMessages(messages);
  if (sorted === 'unreadable') {
    return {
      verdict: 'unreadable',
      reason: 'transcript order is not verifiable',
    };
  }

  let latestUser = -1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]?.info?.role === 'user') {
      latestUser = index;
      break;
    }
  }
  if (latestUser < 0) {
    return { verdict: 'unreadable', reason: 'no delivered user round' };
  }
  const startedAt = transcriptOrderKey(sorted[latestUser] as TranscriptMessage);

  let assistant = -1;
  for (let index = sorted.length - 1; index > latestUser; index -= 1) {
    if (sorted[index]?.info?.role === 'assistant') {
      assistant = index;
      break;
    }
  }
  if (assistant < 0) return { verdict: 'incomplete', startedAt };

  const turn = sorted[assistant] as TranscriptMessage;
  const declaredParent = messageParentIdentity(turn);
  const latestUserID = messageIdentity(sorted[latestUser] as TranscriptMessage);
  if (declaredParent && declaredParent !== latestUserID) {
    return latestUserID
      ? { verdict: 'incomplete', startedAt }
      : {
          verdict: 'unreadable',
          reason: 'assistant parent is not the latest user',
        };
  }
  if (isInterruptSignal(turn)) {
    return {
      verdict: 'interrupted',
      startedAt,
      completedAt: assistantCompletedAt(turn),
    };
  }
  const evidence = classifyAssistantTurnEvidence(
    sorted,
    assistant,
    latestUser,
    true,
  );
  const completedAt = assistantCompletedAt(turn);
  switch (evidence.kind) {
    case 'ready':
      return {
        verdict: 'completed',
        text: evidence.text,
        startedAt,
        completedAt,
      };
    case 'error':
      return {
        verdict: 'error',
        text: evidence.errorText,
        startedAt,
        completedAt,
      };
    default:
      return { verdict: 'incomplete', startedAt };
  }
}

function sourceTypeOf(message: TranscriptMessage): string | undefined {
  const source = message.info?.sourceType ?? message.info?.role;
  return typeof source === 'string' ? source : undefined;
}

function outcomeOf(message: TranscriptMessage): string | undefined {
  const outcome = message.info?.outcome;
  return typeof outcome === 'string' && outcome.length > 0
    ? outcome
    : undefined;
}

function textOf(message: TranscriptMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter(
      (part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => (part as { text: string }).text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Historical v2 round. The latest user or synthetic message is the input
 * boundary. Only an idle/outcome after that boundary can confirm the round.
 * An older idle or Session-level outcome is not reused, and a missing time
 * is not treated as zero.
 */
export function classifyV2HistoricalRound(
  response: unknown,
): CurrentRoundClassification {
  if (response === undefined) {
    return { verdict: 'unreadable', reason: 'transcript source unavailable' };
  }
  if (responseError(response) !== undefined) {
    return { verdict: 'unreadable', reason: 'transcript read failed' };
  }
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return { verdict: 'unreadable', reason: 'malformed transcript response' };
  }
  const messages: TranscriptMessage[] = [];
  for (const entry of response.data) {
    if (!isRecord(entry) || !isRecord(entry.info)) {
      return { verdict: 'unreadable', reason: 'malformed transcript entries' };
    }
    messages.push(entry);
  }
  const sorted = orderTranscriptMessages(messages);
  if (sorted === 'unreadable') {
    return {
      verdict: 'unreadable',
      reason: 'transcript order is not verifiable',
    };
  }
  let boundary = -1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const source = sourceTypeOf(sorted[index] as TranscriptMessage);
    if (source === 'user' || source === 'synthetic') {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) {
    return { verdict: 'unreadable', reason: 'no delivered user round' };
  }
  const startedAt = transcriptOrderKey(sorted[boundary] as TranscriptMessage);
  let assistant = -1;
  let closingIdle = -1;
  for (let index = boundary + 1; index < sorted.length; index += 1) {
    const message = sorted[index] as TranscriptMessage;
    const source = sourceTypeOf(message);
    if (source === 'user' || source === 'synthetic') break;
    if (source === 'assistant') {
      assistant = index;
      closingIdle = -1;
      continue;
    }
    if (source === 'idle') closingIdle = index;
  }
  if (closingIdle < 0) return { verdict: 'incomplete', startedAt };
  const idle = sorted[closingIdle] as TranscriptMessage;
  const idleOutcome = outcomeOf(idle);
  const completedAt =
    transcriptOrderKey(idle) ??
    (assistant >= 0
      ? assistantCompletedAt(sorted[assistant] as TranscriptMessage)
      : undefined);
  if (idleOutcome === undefined) {
    return { verdict: 'unreadable', reason: 'idle outcome is missing' };
  }
  if (assistant >= 0 && closingIdle < assistant) {
    return { verdict: 'incomplete', startedAt };
  }
  if (idleOutcome === 'interrupted') {
    return { verdict: 'interrupted', startedAt, completedAt };
  }
  if (idleOutcome === 'failed') {
    const turn =
      assistant >= 0 ? (sorted[assistant] as TranscriptMessage) : undefined;
    return {
      verdict: 'error',
      text:
        (turn ? textOf(turn) : '') ||
        'The historical round failed before an assistant result.',
      startedAt,
      completedAt,
    };
  }
  if (idleOutcome !== 'succeeded') {
    return {
      verdict: 'unreadable',
      reason: `unrecognized idle outcome ${idleOutcome}`,
    };
  }
  if (assistant < 0) return { verdict: 'incomplete', startedAt };
  const text = textOf(sorted[assistant] as TranscriptMessage);
  if (!text) return { verdict: 'incomplete', startedAt };
  return {
    verdict: 'completed',
    text,
    startedAt,
    completedAt:
      assistantCompletedAt(sorted[assistant] as TranscriptMessage) ??
      completedAt,
  };
}
