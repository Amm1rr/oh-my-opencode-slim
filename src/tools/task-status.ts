import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { listChildInputWaits } from '../hooks/task-session-manager/child-input-wait';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  taskRefArgs,
} from './task-ref';

const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
}): Record<'task_status', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias.',
    args: {
      ...taskRefArgs(idParam),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_status requires ${idParam}`);
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (canonical?.kind === 'refused') throw new Error(canonical.reason);
      const identity = canonical?.taskID ?? requested;
      const job = canonical
        ? options.backgroundJobBoard.get(identity)
        : options.backgroundJobBoard.resolve(parentSessionID, requested);
      if (!job || job.parentSessionID !== parentSessionID) {
        throw new Error(`Unknown task ID or alias: ${identity}`);
      }
      const taskID = job.taskID;

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const current = options.backgroundJobBoard.get(taskID) ?? job;
      if (
        current.parentSessionID !== parentSessionID ||
        current.taskID !== taskID
      ) {
        throw new Error(`Unknown task ID or alias: ${taskID}`);
      }
      const observation = observationFromSnapshot(snapshot, taskID);
      const now = options.now?.() ?? Date.now();
      const lastActivityAt =
        options.activityTracker?.lastActivityAt(taskID) ??
        current.lastLiveBusyAt ??
        current.runStartedAt;
      const report = summarizeTaskStatus(
        current,
        observation,
        lastActivityAt,
        now,
      );

      const details = [
        `Task ${current.alias} (${current.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${current.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      const waits = listChildInputWaits(taskID);
      const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
      // A child parked on an open question/permission moves no tokens and
      // never finishes on its own: surface the block explicitly so the
      // parent handles it instead of waiting it out. On pinned v2 hosts,
      // questions are Form requests; the plugin context exposes observation
      // but no supported form-reply API, so do not promise task_reply can
      // unblock them.
      for (const wait of waits) {
        details.push(`waiting_input: true (${wait.kind} ${wait.requestID})`);
        details.push(
          `pending_${wait.kind}: ${formatPendingInput(wait.kind, wait.requestID, wait.questions, wait.permission, wait.patterns)}`,
        );
        details.push(inputWaitGuidance(wait.kind, hostFlavor));
      }
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (!report.uncertain && ACTIVE_STATES.has(report.state)) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      if (waits.length > 0) {
        details.push('');
        details.push(
          '[guidance]: The task is waiting for input and cannot proceed until the pending request is handled. See the request-specific guidance above.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

function inputWaitGuidance(
  kind: 'question' | 'permission',
  hostFlavor: unknown,
): string {
  if (kind === 'question' && hostFlavor === 'v2') {
    return '[guidance]: This is an OpenCode v2 form request. The pinned v2 plugin context can observe it but exposes no supported form-reply API, so task_reply cannot answer it. Answer/cancel it in the host UI if available; otherwise leave the child waiting or cancel the task.';
  }
  return '[guidance]: Use task_reply with this request ID to answer or reject this pending request.';
}

function formatPendingInput(
  kind: 'question' | 'permission',
  requestID: string,
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
  }>,
  permission?: string,
  patterns?: string[],
): string {
  if (kind === 'permission') {
    const patternText =
      patterns && patterns.length > 0
        ? ` patterns: ${patterns.join(', ')}`
        : '';
    return `${requestID} permission: ${permission ?? 'unknown'}${patternText}`;
  }
  if (!questions || questions.length === 0) return requestID;
  const rendered = questions
    .map((entry) => {
      const options =
        entry.options.length > 0
          ? ` [${entry.options.map((option) => option.label).join(' / ')}]`
          : '';
      const header = entry.header ? `${entry.header}: ` : '';
      return `${header}${entry.question}${options}`;
    })
    .join('; ');
  return `${requestID} ${rendered}`;
}
