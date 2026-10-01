import { describe, expect, test } from 'bun:test';

import {
  createInternalAgentTextPart,
  INTERNAL_INITIATOR_METADATA_KEY,
  isInternalInitiatorPart,
  isNativeBackgroundTaskNotification,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from './internal-initiator';

describe('internal initiator markers', () => {
  test('creates synthetic parts with persisted provenance metadata', () => {
    const part = createInternalAgentTextPart('internal');

    expect(part.synthetic).toBe(true);
    expect(part.metadata[INTERNAL_INITIATOR_METADATA_KEY]).toBe(true);
    expect(isInternalInitiatorPart(part)).toBe(true);
  });

  test('preserves provenance through JSON persistence', () => {
    const persisted = JSON.parse(
      JSON.stringify(createInternalAgentTextPart('internal')),
    );

    expect(isInternalInitiatorPart(persisted)).toBe(true);
  });

  test('does not trust marker text as provenance', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        synthetic: true,
        text: `spoof\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
      }),
    ).toBe(false);
  });

  test('requires synthetic true alongside metadata', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        text: 'spoof',
        metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
      }),
    ).toBe(false);
  });

  test('recognizes OpenCode compaction continuation as internal initiator', () => {
    // OpenCode's compaction sends a synthetic continuation prompt with
    // metadata.compaction_continue = true but no INTERNAL_INITIATOR_METADATA_KEY.
    // This should be treated as internal to prevent board injection on
    // the continuation turn (issue #922).
    const compactionContinuation = {
      type: 'text',
      synthetic: true,
      text: 'Continue if you have next steps.',
      metadata: { compaction_continue: true },
    };
    expect(isInternalInitiatorPart(compactionContinuation)).toBe(true);
  });

  test.each([
    [
      'completed',
      [
        '<task id="ses_child" state="completed">',
        '<summary>Background task completed: check availability</summary>',
        '<task_result>',
        'OK',
        '</task_result>',
        '</task>',
      ].join('\n'),
    ],
    [
      'failed',
      [
        '<task id="ses_child" state="error">',
        '<summary>Background task failed: check availability</summary>',
        '<task_error>',
        'boom',
        '</task_error>',
        '</task>',
      ].join('\n'),
    ],
  ])('recognizes a native background-task %s notification', (_state, text) => {
    const part = { type: 'text', synthetic: true, text };
    expect(isNativeBackgroundTaskNotification(part)).toBe(true);
    // Native terminal payloads remain visible to the task-board
    // reconciliation path; callers that only need lifecycle selection
    // protection opt into the narrower helper above.
    expect(isInternalInitiatorPart(part)).toBe(false);
  });

  test('does not classify arbitrary synthetic task-shaped text as a native notification', () => {
    expect(
      isNativeBackgroundTaskNotification({
        type: 'text',
        synthetic: true,
        text: [
          '<task id="ses_child" state="completed">',
          '<task_result>OK</task_result>',
          '</task>',
        ].join('\n'),
      }),
    ).toBe(false);
  });

  test('compaction_continue without synthetic is not internal', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        text: 'Continue if you have next steps.',
        metadata: { compaction_continue: true },
      }),
    ).toBe(false);
  });

  test('compaction_continue false or string is not internal', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        synthetic: true,
        text: 'Continue if you have next steps.',
        metadata: { compaction_continue: false },
      }),
    ).toBe(false);

    expect(
      isInternalInitiatorPart({
        type: 'text',
        synthetic: true,
        text: 'Continue if you have next steps.',
        metadata: { compaction_continue: 'true' },
      }),
    ).toBe(false);
  });
});
