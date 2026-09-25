import { describe, expect, test } from 'bun:test';

import { formatPatch, parsePatch } from './codec';
import { normalizeUnicode } from './matching';
import type { ParsedPatch } from './types';

describe('apply-patch/codec', () => {
  test('parsePatch recognizes add delete update and move', () => {
    const parsed = parsePatch(`*** Begin Patch
*** Add File: added.txt
+alpha
*** Delete File: removed.txt
*** Update File: before.txt
*** Move to: after.txt
@@ ctx
 line-a
-line-b
+line-c
*** End of File
*** End Patch`);

    expect(parsed.hunks).toHaveLength(3);
    expect(parsed.hunks[0]).toEqual({
      type: 'add',
      path: 'added.txt',
      contents: 'alpha\n',
    });
    expect(parsed.hunks[1]).toEqual({ type: 'delete', path: 'removed.txt' });
    expect(parsed.hunks[2]).toEqual({
      type: 'update',
      path: 'before.txt',
      move_path: 'after.txt',
      chunks: [
        {
          old_lines: ['line-a', 'line-b'],
          new_lines: ['line-a', 'line-c'],
          change_context: 'ctx',
          is_end_of_file: true,
        },
      ],
    });
  });

  test('parsePatch tolerates heredocs with aggressive CRLF and preserves EOF', () => {
    const parsed = parsePatch(`cat <<'PATCH'\r
*** Begin Patch\r
*** Update File: sample.txt\r
@@\r
-alpha\r
+beta\r
*** End of File\r
*** End Patch\r
PATCH`);

    expect(parsed.hunks).toEqual([
      {
        type: 'update',
        path: 'sample.txt',
        chunks: [
          {
            old_lines: ['alpha'],
            new_lines: ['beta'],
            change_context: undefined,
            is_end_of_file: true,
          },
        ],
      },
    ]);
  });

  test('U4 rejects End Patch as context before another hunk', () => {
    expect(() =>
      parsePatch(`*** Begin Patch
*** Update File: doc.md
@@
 x
 *** End Patch
-y
+Y
*** Update File: b.txt
@@
-b
+B
*** End Patch`),
    ).toThrow('End Patch');
  });

  test('T2 rejects a chunk after an EOF-marked chunk', () => {
    expect(() =>
      parsePatch(`*** Begin Patch
*** Update File: a.txt
@@
-c
+C
*** End of File
@@
+Z
*** End of File
*** End Patch`),
    ).toThrow('End of File');
  });

  test.each([
    [
      'garbage inside @@',
      '*** Update File: sample.txt\n@@\n-alpha\ngarbage\n+beta\n*** End Patch',
      'unexpected line in patch chunk',
    ],
    [
      'garbage inside Add File',
      '*** Add File: sample.txt\n+alpha\ngarbage\n*** End Patch',
      'unexpected line in Add File body',
    ],
    [
      'malformed Delete File',
      '*** Delete File: sample.txt\n+ghost\n*** End Patch',
      'unexpected line between hunks',
    ],
    [
      'garbage after End Patch',
      '*** Delete File: sample.txt\n*** End Patch\ngarbage',
      'unexpected line after End Patch',
    ],
    [
      'Update File without @@',
      '*** Update File: sample.txt\n*** End Patch',
      'missing @@ chunk body',
    ],
  ])('parsePatch rejects %s', (_, body, message) => {
    expect(() => parsePatch(`*** Begin Patch\n${body}`)).toThrow(message);
  });

  test.each([
    [
      ['alpha', 'beta'],
      ['alpha', 'BETA'],
    ],
    [['a'], ['a', 'a']],
    [
      ['a', 'a', 'a'],
      ['a', 'a'],
    ],
  ])('formatPatch roundtrips old=%j new=%j', (old_lines, new_lines) => {
    const parsed: ParsedPatch = {
      hunks: [
        {
          type: 'update',
          path: 'sample.txt',
          chunks: [{ old_lines, new_lines }],
        },
      ],
    };

    expect(parsePatch(formatPatch(parsed))).toEqual(parsed);
  });

  test.each([
    ['', ''],
    ['\n', '\n'],
    ['a', 'a\n'],
    ['a\n', 'a\n'],
    ['a\nb', 'a\nb\n'],
    ['a\nb\n', 'a\nb\n'],
    ['a\n\n', 'a\n\n'],
  ])('formatPatch preserves Add File contents %j', (contents, expected) => {
    const hunk = { type: 'add' as const, path: 'added.txt', contents };
    const formatted = formatPatch({ hunks: [hunk] });
    const parsed = parsePatch(formatted);

    expect(parsed.hunks).toEqual([{ ...hunk, contents: expected }]);
    expect(formatPatch(parsed)).toBe(formatted);
  });

  test('normalizeUnicode unifies expected typographic variants', () => {
    expect(normalizeUnicode('“uno”…\u00A0dos-tres')).toBe('"uno"... dos-tres');
    expect(normalizeUnicode('‛uno‟―dos')).toBe(`'uno"-dos`);
  });
});
