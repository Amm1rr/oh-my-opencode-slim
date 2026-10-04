import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt } from './orchestrator';

describe('orchestrator prompt', () => {
  test('requires the question tool for blocking user input', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('use the `question` tool');
    expect(prompt).toContain('Enable custom input');
    expect(prompt).toContain('concise pasted response or command output');
    expect(prompt).toContain('small bounded set of options');
    expect(prompt).toContain('ordinary dialogue that does not block work');
  });

  test('requires wait_for_user for external manual work', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).toContain('give the user concrete manual steps');
    expect(prompt).toContain('end the turn');
    expect(prompt).toContain('never use `wait_for_user` to await them');
    expect(prompt).toContain('Do not rely on ordinary text alone');
  });

  test('sends existing-session work to task_revive without requiring the reusable list', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      '`task_revive(task_id: "<task-id>", prompt: "...")`',
    );
    expect(prompt).toContain(
      'even when that session is not listed under Reusable Sessions',
    );
    expect(prompt).toContain(
      'not required before continuing an existing session',
    );
    expect(prompt).not.toContain(
      'Only sessions listed under Reusable Sessions may be resumed',
    );
    expect(prompt).not.toContain(
      'use `task_revive` only for Retained / Recovery tasks',
    );
  });

  test('falls back to question when wait_for_user is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, false);

    expect(prompt).not.toContain(
      'call `wait_for_user` as your final tool action',
    );
    expect(prompt).toContain('`wait_for_user` is disabled');
    expect(prompt).toContain(
      'use the `question` tool as the blocking boundary',
    );
  });

  test('omits end-turn instruction when wake scheduler is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, true, false);

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).not.toContain('End Turn After Background Tasks');
    expect(prompt).toContain('Do not immediately wait after spawning');
  });

  test('defaults to board-aware wording while board injection is on', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('the Background Job Board');
    expect(prompt).toContain('The board is ambient status');
  });

  test('drops every Background Job Board reference when board injection is off', () => {
    const prompt = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      undefined,
      false,
    );

    expect(prompt).not.toContain('Background Job Board');
    expect(prompt).not.toContain('If the board lists');
    expect(prompt).not.toContain('The board is ambient status');
    // The pull channel replaces the panel in every affected line.
    expect(prompt).toContain(
      'the system resumes automatically via background completion notifications and the orchestrator wake scheduler',
    );
    expect(prompt).toContain(
      'check `task_status` and the current conversation for an existing task',
    );
    expect(prompt).toContain('Background status is ambient');
    expect(prompt.match(/`task_status`/g)?.length ?? 0).toBeGreaterThan(2);
  });
});
