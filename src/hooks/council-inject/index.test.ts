import { describe, expect, test } from 'bun:test';
import { createInternalAgentTextPart } from '../../utils';
import {
  buildCouncilModeBlock,
  COUNCIL_INJECT_METADATA_KEY,
  createCouncilInjectHook,
  matchesCouncilTrigger,
} from './index';

const SEATS = ['councillor-a', 'councillor-b', 'councillor-c'];

describe('matchesCouncilTrigger', () => {
  test('matches ASCII keywords with word boundaries', () => {
    expect(matchesCouncilTrigger('run a council on this')).toBe(true);
    expect(matchesCouncilTrigger('please get a second opinion')).toBe(true);
    expect(matchesCouncilTrigger('this plan needs consensus')).toBe(true);
    expect(matchesCouncilTrigger('@council compare these')).toBe(true);
    expect(matchesCouncilTrigger('dispatch @councillor-a now')).toBe(true);
  });

  test('matches CJK keywords by substring', () => {
    expect(matchesCouncilTrigger('拉个议会评估一下')).toBe(true);
    expect(matchesCouncilTrigger('多方代理讨论，要共识')).toBe(true);
    expect(matchesCouncilTrigger('多模型交叉验证')).toBe(true);
  });

  test('does not match plain text without triggers', () => {
    expect(matchesCouncilTrigger('fix the login bug')).toBe(false);
    expect(matchesCouncilTrigger('refactor the parser module')).toBe(false);
  });

  test('does not match keywords inside code fences or inline code', () => {
    expect(
      matchesCouncilTrigger(
        'review my config:\n```jsonc\n"council": { "presets": {} }\n```\nthanks',
      ),
    ).toBe(false);
    expect(
      matchesCouncilTrigger('the `council` key goes in the plugin config'),
    ).toBe(false);
  });

  test('does not match slash commands', () => {
    expect(matchesCouncilTrigger('/council run this')).toBe(false);
  });

  test('does not do negation parsing (recall-biased)', () => {
    expect(matchesCouncilTrigger('上次没用 council，这次来一次')).toBe(true);
  });
});

describe('buildCouncilModeBlock', () => {
  test('v2 wording uses subagent/agent and includes every seat', () => {
    const block = buildCouncilModeBlock(SEATS, {
      tool: 'subagent',
      agentParam: 'agent',
    });

    expect(block).toContain('## Council Mode');
    expect(block).toContain(
      'one call per seat (councillor-a, councillor-b, councillor-c)',
    );
    expect(block).toContain("subagent(agent='councillor-a'");
    expect(block).toContain("subagent(agent='council'");
    // The synthesis call must show the prompt= parameter (the old static
    // block omitted it, teaching the model a bad example).
    expect(block).toMatch(
      /subagent\(agent='council', description='[^']+', prompt=/,
    );
  });

  test('v1 wording uses task/subagent_type', () => {
    const block = buildCouncilModeBlock(SEATS, {
      tool: 'task',
      agentParam: 'subagent_type',
    });

    expect(block).toContain("task(subagent_type='councillor-a'");
    expect(block).not.toContain('subagent(');
  });
});

describe('createCouncilInjectHook', () => {
  const hook = createCouncilInjectHook({
    seats: SEATS,
    wording: { tool: 'subagent', agentParam: 'agent' },
  });
  const transform = hook['experimental.chat.messages.transform'];

  test('appends the block only to matching orchestrator messages', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'fix the parser' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on the plan' }],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
    expect(output.messages[1].parts.length).toBe(2);
    const injected = output.messages[1].parts[1];
    expect(injected).toMatchObject({
      synthetic: true,
      metadata: { [COUNCIL_INJECT_METADATA_KEY]: true },
    });
    expect(injected.text).toContain('## Council Mode');
  });

  test('does not inject for specialist agents (passthrough)', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'explorer', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council please' }],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
  });

  test('does not inject onto internal initiator parts', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [createInternalAgentTextPart('wake: run a council now')],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
  });

  test('is idempotent across repeated transforms on the same payload', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council' }],
        },
      ],
    };

    await transform({}, output);
    const partsAfterFirst = [...output.messages[0].parts];
    await transform({}, output);

    // The tagged-part dedupe keeps the second run from appending again.
    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[0].parts[1]).toEqual(partsAfterFirst[1]);
  });

  test('replays byte-identical blocks on later turns (cache safety)', async () => {
    const turnOne = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on this' }],
        },
      ],
    };
    await transform({}, turnOne);

    // Turn two: the host re-renders history WITHOUT the injected part (it is
    // never persisted) and adds a new user message. The historical block must
    // be re-derived at the same position with the same bytes.
    const turnTwo = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on this' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'thanks, now just fix it' }],
        },
      ],
    };
    await transform({}, turnTwo);

    expect(turnTwo.messages[0].parts.length).toBe(2);
    expect(turnTwo.messages[0].parts[1]).toEqual(turnOne.messages[0].parts[1]);
    expect(turnTwo.messages[1].parts.length).toBe(1);
  });
});
