/**
 * C2 layer 1: native delegation vocabulary in generated prompts.
 *
 * On v2 hosts (hostFlavor 'v2', stamped by the v2 client shim) the
 * generated orchestrator/council prompt text must use the v2-native
 * delegation vocabulary directly (`subagent(...)` tool with the `agent`
 * parameter) instead of emitting v1 wording (`task(...)`,
 * `subagent_type`).
 *
 * v1 hosts (no hostFlavor) must keep byte-identical v1 wording. That is
 * locked here by literal delegation-sentence assertions (matching the
 * pre-change master strings) plus the repo-wide golden snapshot in
 * src/hooks/cache-payload.snapshot.test.ts, which snapshots
 * buildOrchestratorPrompt with no hostFlavor and must not drift.
 */

import { describe, expect, test } from 'bun:test';
import { createAgents } from '../agents';
import { buildOrchestratorPrompt } from '../agents/orchestrator';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { controlParamName, delegationVocabulary } from './adapters';

const TEST_DIRECTORY = 'runtime-test-native-delegation-wording';

function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

function councilConfig() {
  return CouncilConfigSchema.parse({
    presets: { default: { alpha: { model: 'test/councillor' } } },
  });
}

function orchestratorPromptFor(hostFlavor?: string): string {
  const agents = createAgents(
    runtimeFor({
      council: councilConfig(),
      disabled_agents: [],
    }),
    { hostFlavor },
  );
  const orchestrator = agents.find((a) => a.name === 'orchestrator');
  return orchestrator?.config.prompt as string;
}

describe('delegationVocabulary', () => {
  test("v2 → { tool: 'subagent', agentParam: 'agent', modelParam: 'model', resumeParam: 'sessionID' }", () => {
    expect(delegationVocabulary('v2')).toEqual({
      tool: 'subagent',
      agentParam: 'agent',
      modelParam: 'model',
      resumeParam: 'sessionID',
    });
  });

  test("v1/default → { tool: 'task', agentParam: 'subagent_type', modelParam: undefined, resumeParam: 'task_id' }", () => {
    expect(delegationVocabulary(undefined)).toEqual({
      tool: 'task',
      agentParam: 'subagent_type',
      modelParam: undefined,
      resumeParam: 'task_id',
    });
    expect(delegationVocabulary('v1')).toEqual({
      tool: 'task',
      agentParam: 'subagent_type',
      modelParam: undefined,
      resumeParam: 'task_id',
    });
  });

  test('controlParamName shares the delegation resume param per flavor', () => {
    expect(controlParamName('v2')).toBe('sessionID');
    expect(controlParamName('v1')).toBe('task_id');
    expect(controlParamName(undefined)).toBe('task_id');
    expect(delegationVocabulary('v2').resumeParam).toBe(controlParamName('v2'));
    expect(delegationVocabulary(undefined).resumeParam).toBe(
      controlParamName(undefined),
    );
  });
});

describe('buildOrchestratorPrompt delegation vocabulary', () => {
  test('v2 hostFlavor emits subagent( wording with agent param', () => {
    const prompt = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      'v2',
    );

    expect(prompt).toContain('`subagent(..., sessionID: ...)`');
    expect(prompt).toContain('Prefer `subagent(..., background: true)`');
    expect(prompt).toContain('cannot receive another `subagent` call');
    expect(prompt).toContain("in the subagent tool's `sessionID` argument");
    expect(prompt).toContain('call subagent with `agent: "fixer"`');
    expect(prompt).toContain('`sessionID: "fix-1"` or `sessionID: "ses_abc"`');
    expect(prompt).toContain(
      'The subagent tool also accepts an optional `model` argument ("providerID/modelID")',
    );
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
    expect(prompt).not.toContain('task_id');
  });

  test('v1 (no hostFlavor) keeps the exact v1 delegation sentences', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      'Never use `task(..., task_id: ...)` to fetch output',
    );
    expect(prompt).toContain('any resume starts new model work');
    expect(prompt).toContain('Prefer `task(..., background: true)`');
    expect(prompt).toContain('cannot receive another `task` call');
    expect(prompt).toContain("in the task tool's `task_id` argument");
    expect(prompt).toContain('call task with `subagent_type: "fixer"`');
    expect(prompt).not.toContain('optional `model` argument');
  });

  test('explicit v1/unknown hostFlavor is byte-identical to no hostFlavor', () => {
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v1'),
    ).toBe(buildOrchestratorPrompt());
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v3-ish'),
    ).toBe(buildOrchestratorPrompt());
  });
});

/** v2.0.5+ model-param guidance, appended at the two `vocab.tool` prompt
 * sites (orchestrator base prompt + council block) when the host's
 * subagent tool supports the optional `model` parameter. */
const MODEL_PARAM_SENTENCE = ` The subagent tool also accepts an optional \`model\` argument ("providerID/modelID"). Only set it when the user explicitly asks for a specific model or variant; never guess the ID — look it up with the models tool first, filtering to your own provider.`;

describe('createAgents council dispatch vocabulary', () => {
  test('v2 hostFlavor emits subagent(agent=...) dispatch instructions', () => {
    const prompt = orchestratorPromptFor('v2');

    expect(prompt).toContain('## Council Mode');
    expect(prompt).toContain("subagent(agent='councillor-alpha'");
    expect(prompt).toContain('in PARALLEL via subagent():');
    expect(prompt).toContain("subagent(agent='council'");
    expect(prompt).toContain(MODEL_PARAM_SENTENCE);
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
  });

  test('v1 (no hostFlavor) keeps the exact v1 council dispatch sentence', () => {
    const prompt = orchestratorPromptFor();

    expect(prompt).toContain('## Council Mode');
    expect(prompt).toContain("task(subagent_type='councillor-alpha'");
    expect(prompt).toContain('in PARALLEL via task():');
    expect(prompt).toContain("task(subagent_type='council'");
    expect(prompt).not.toContain(MODEL_PARAM_SENTENCE);
  });

  test('v2 and v1 prompts differ only by delegation vocabulary', () => {
    const v1 = orchestratorPromptFor();
    const v2 = orchestratorPromptFor('v2');

    expect(v2).toContain(
      'Never use `subagent(..., sessionID: ...)` to fetch output',
    );

    // v2 additionally carries the model-param guidance sentence at the
    // two vocab.tool sites; with it stripped, only vocabulary differs.
    const v2Stripped = v2.replaceAll(MODEL_PARAM_SENTENCE, '');
    expect(normalizeV2WordingToV1(v2Stripped)).toBe(v1);
  });
});

/** Reverse v2-native delegation wording back to v1 so both generated
 * prompts can be compared directly.
 *
 * Every substitution is an EXACT generated delegation fragment — notably
 * never a bare `sessionID` token. Any `task_id`/`sessionID` drift outside
 * those fragments (e.g. a control-tool reference) stays visible instead of
 * being normalized away. */
function normalizeV2WordingToV1(text: string): string {
  return (
    text
      .replaceAll('(..., sessionID: ...)', '(..., task_id: ...)')
      .replaceAll(
        'agent: "<agent>", sessionID: "<task-id>"',
        'subagent_type: "<agent>", task_id: "<task-id>"',
      )
      .replaceAll(
        '`subagent` call, even with its `sessionID`',
        '`task` call, even with its `task_id`',
      )
      .replaceAll(
        "in the subagent tool's `sessionID` argument",
        "in the task tool's `task_id` argument",
      )
      .replaceAll(
        'call subagent with `agent: "fixer"` and `sessionID: "fix-1"` or `sessionID: "ses_abc"`',
        'call task with `subagent_type: "fixer"` and `task_id: "fix-1"` or `task_id: "ses_abc"`',
      )
      .replaceAll(
        'Do not leave `sessionID` empty',
        'Do not leave `task_id` empty',
      )
      .replaceAll('empty `sessionID` creates', 'empty `task_id` creates')
      .replaceAll(
        'explicit `sessionID` is refused',
        'explicit `task_id` is refused',
      )
      // Delegation tool name only: `task_*` control tools carry `_` (or nothing)
      // after `task`, never `(`, so this replacement cannot touch them.
      .replaceAll('subagent(', 'task(')
      .replaceAll("agent='", "subagent_type='")
  );
}
