import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { parsePatch } from './codec';
import { stageAddedText } from './execution-context';
import { nativeDeriveUpdate } from './native-update';
import {
  applyPatch,
  createTempDir,
  readText,
  rewritePatchText,
  writeFixture,
} from './test-helpers';

const patch = (...body: string[]) =>
  ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

function nativeOutcome(
  root: string,
  files: Record<string, string>,
  text: string,
) {
  const state = new Map(Object.entries(files));
  const prepared = parsePatch(text).hunks.map((hunk) => {
    const source = path.normalize(hunk.path);
    if (hunk.type === 'add') {
      return { type: 'add', source, text: stageAddedText(hunk.contents) };
    }
    if (hunk.type === 'delete') {
      if (!state.has(source))
        throw new Error(`Native delete missing: ${source}`);
      return { type: 'delete', source };
    }
    const original = state.get(source);
    if (original === undefined)
      throw new Error(`Native update missing: ${source}`);
    return {
      type: 'update',
      source,
      destination: hunk.move_path && path.normalize(hunk.move_path),
      text: nativeDeriveUpdate(path.join(root, source), original, hunk.chunks),
    };
  });
  for (const step of prepared) {
    if (step.type === 'delete') state.delete(step.source);
    else {
      state.set(step.destination ?? step.source, step.text as string);
      if (step.destination) state.delete(step.source);
    }
  }
  return Object.fromEntries(state);
}

describe('apply-patch/native regressions', () => {
  test.each([
    {
      name: 'T4 unanchored append',
      files: { 'a.txt': 'a\nb\n' },
      input: patch('*** Update File: a.txt', '@@', '+Z'),
      expected: { 'a.txt': 'a\nb\nZ\n' },
    },
    {
      name: 'T5 blank line between hunks',
      files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@',
        '-a',
        '+A',
        '',
        '*** Update File: b.txt',
        '@@',
        '-b',
        '+B',
      ),
      expected: { 'a.txt': 'A\n', 'b.txt': 'B\n' },
    },
    {
      name: 'T5b blank line before End Patch',
      files: { 'a.txt': 'a\n' },
      input: patch('*** Update File: a.txt', '@@', '-a', '+A', ''),
      expected: { 'a.txt': 'A\n' },
    },
    {
      name: 'T6 fence outside markers',
      files: { 'a.txt': 'a\n' },
      input: `${patch('*** Update File: a.txt', '@@', '-a', '+A')}\n\`\`\``,
      expected: { 'a.txt': 'A\n' },
    },
    {
      name: 'T6b fence before and after markers',
      files: { 'a.txt': 'a\n' },
      input: `\`\`\`patch\n${patch('*** Update File: a.txt', '@@', '-a', '+A')}\n\`\`\``,
      expected: { 'a.txt': 'A\n' },
    },
    {
      name: 'T7 rename without chunks',
      files: { 'a.txt': 'a\n' },
      input: patch('*** Update File: a.txt', '*** Move to: b.txt'),
      expected: { 'a.txt': null, 'b.txt': 'a\n' },
    },
    {
      name: 'T8 unified-diff header as absent context',
      files: { 'a.txt': 'a\nb\nc\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
      ),
      expected: { 'a.txt': 'a\nB\nc\n' },
    },
    {
      name: 'T8b stale @@ context',
      files: { 'a.txt': 'def f(x):\n    return x\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@ def f(x, y):',
        '-    return x',
        '+    return x + 1',
      ),
      expected: { 'a.txt': 'def f(x):\n    return x + 1\n' },
    },
    {
      name: 'T9 @@ context already consumed by previous chunk',
      files: { 'a.txt': 'L0\nL1\nL2\nL3\nL4\nL5\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@',
        ' L1',
        '-L2',
        '+X',
        ' L3',
        '@@ L3',
        '-L4',
        '+Y',
      ),
      expected: { 'a.txt': 'L0\nL1\nX\nL3\nY\nL5\n' },
    },
    {
      name: 'T11 folded EOF chunks keep only the final marker',
      files: { 'a.txt': 'a\nb\nc\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@',
        '-c',
        '+C',
        '*** End of File',
        '*** Update File: a.txt',
        '@@',
        '+Z',
        '*** End of File',
      ),
      expected: { 'a.txt': 'a\nb\nC\nZ\n' },
    },
    {
      name: 'P0-4 folded insertion in the middle keeps native-matchable old lines',
      files: { 'a.txt': 'a\nc\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@ a',
        '+X',
        '*** Update File: a.txt',
        '*** Move to: b.txt',
        '@@',
        ' a',
      ),
      expected: { 'a.txt': null, 'b.txt': 'a\nX\nc\n' },
    },
    {
      name: 'T12 native retries without trailing empty context line',
      files: { 'a.txt': 'a\nb\n' },
      input: patch('*** Update File: a.txt', '@@', ' a', '-b', '+B', ' '),
      expected: { 'a.txt': 'a\nB\n' },
    },
    {
      name: 'T13 native prioritizes trim over unicode',
      files: { 'a.txt': 'x\n“k”\ny\n  "k"\ny\n' },
      input: patch('*** Update File: a.txt', '@@ "k"', '-y', '+Y'),
      expected: { 'a.txt': 'x\n“k”\ny\n  "k"\nY\n' },
    },
    {
      name: 'T14 Add with final empty line',
      files: {},
      input: patch('*** Add File: n.txt', '+a', '+'),
      expected: { 'n.txt': 'a\n' },
    },
    {
      name: 'T14b Add with only an empty line',
      files: {},
      input: patch('*** Add File: n.txt', '+'),
      expected: { 'n.txt': '' },
    },
    {
      name: 'T15 missing @@ anchor on EOF insertion is removed',
      files: { 'a.txt': 'a\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@ nope',
        '+Z',
        '*** End of File',
      ),
      expected: { 'a.txt': 'a\nZ\n' },
    },
    {
      name: 'T17 second update uses a freshly inserted @@ anchor',
      files: { 'a.txt': 'L0\nL1\nL2\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@ L1',
        '+N',
        '*** Update File: a.txt',
        '@@ N',
        '-L2',
        '+M',
      ),
      expected: { 'a.txt': 'L0\nL1\nN\nM\n' },
    },
    {
      name: 'U1 fuzzy trailing-space edge must retain file bytes',
      files: { 'a.txt': 'foo  \nold\nbar\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@',
        ' foo',
        '-stale',
        '+new',
        ' bar',
      ),
      expected: { 'a.txt': 'foo  \nnew\nbar\n' },
    },
    {
      name: 'U2 fuzzy unicode edge must retain file bytes',
      files: { 'a.py': 'msg = “hi”\nold()\nend()\n' },
      input: patch(
        '*** Update File: a.py',
        '@@',
        ' msg = "hi"',
        '-stale()',
        '+new()',
        ' end()',
      ),
      expected: { 'a.py': 'msg = “hi”\nnew()\nend()\n' },
    },
    {
      name: 'U3 EOF insertion precedes a real final empty line',
      files: { 'a.txt': 'a\n\n' },
      input: patch('*** Update File: a.txt', '@@', '+X', '*** End of File'),
      expected: { 'a.txt': 'a\nX\n' },
    },
  ])('$name', async ({ files, input, expected }) => {
    const root = await createTempDir();
    for (const [file, text] of Object.entries(files)) {
      await writeFixture(root, file, text);
    }
    const rewritten = await rewritePatchText(root, input);
    expect(nativeOutcome(root, files, rewritten)).toEqual(
      Object.fromEntries(
        Object.entries(expected).filter(([, text]) => text !== null),
      ),
    );
    await applyPatch(root, rewritten);
    for (const [file, text] of Object.entries(expected)) {
      if (text === null) {
        await expect(readText(root, file)).rejects.toThrow();
      } else {
        expect(await readText(root, file)).toBe(text);
      }
    }
  });

  test.each([
    {
      name: 'T1 repeated closing brace makes EOF-first match unsafe',
      files: {
        'a.ts':
          'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n',
      },
      input: patch(
        '*** Update File: a.ts',
        '@@',
        ' }',
        '+',
        '+export { a, b };',
        '*** End of File',
      ),
    },
    {
      name: 'T10 prefix/suffix cannot delete an unbounded span',
      files: { 'a.txt': 'start\nold\nx1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\nend\n' },
      input: patch(
        '*** Update File: a.txt',
        '@@',
        ' start',
        '-stale',
        '+new',
        ' end',
      ),
    },
    {
      name: 'T16 Add followed by Delete cannot be verified by native',
      files: {},
      input: patch('*** Add File: n.txt', '+a', '*** Delete File: n.txt'),
    },
  ])('$name is blocked', async ({ files, input }) => {
    const root = await createTempDir();
    for (const [file, text] of Object.entries(files)) {
      await writeFixture(root, file, text);
    }
    await expect(rewritePatchText(root, input)).rejects.toThrow(
      'apply_patch verification failed:',
    );
  });
});
