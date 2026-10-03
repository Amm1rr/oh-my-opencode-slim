import { expect, mock, test } from 'bun:test';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
import { createTaskReviveTool } from './task-revive';

test('rejects untracked adoption explicitly through the v2 adapter without a live status map', async () => {
  const wait = mock(async () => {});
  const prompt = mock(async () => ({}));
  const interrupt = mock(async () => {});
  const input = buildPluginInput({
    session: {
      get: async () => ({
        id: 'ses_v2_adoption',
        parentID: 'ses_parent',
        agent: 'explorer',
      }),
      wait,
      prompt,
      interrupt,
    },
    location: { directory: '/test/project' },
  } as unknown as V2Context);
  const board = new BackgroundJobBoard();
  const revivedRunTracker = {
    captureBaseline: async () => 'baseline',
    register: mock(() => {}),
    probe: async () => false,
  } as unknown as RevivedRunTracker;
  const { task_revive } = createTaskReviveTool({
    input,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    revivedRunTracker,
    waitForIdleTimeoutMs: 100,
  });

  expect(input.client.session.status).toBeUndefined();
  await expect(
    task_revive.execute(
      { sessionID: 'ses_v2_adoption', prompt: 'Continue the retained work' },
      { sessionID: 'ses_parent', agent: 'orchestrator' } as never,
    ),
  ).rejects.toThrow(
    'Retrying task_revive on this host will not resolve the missing capability',
  );
  expect(board.get('ses_v2_adoption')).toBeUndefined();
  expect(wait).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
  expect(interrupt).not.toHaveBeenCalled();
  expect(revivedRunTracker.register).not.toHaveBeenCalled();
});
