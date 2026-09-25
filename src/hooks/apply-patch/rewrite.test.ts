import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import path from 'node:path';

import { parsePatch } from './codec';
import { ApplyPatchError } from './errors';
import { rewritePatch } from './rewrite';
import {
  applyPatch,
  createTempDir,
  readText,
  rewritePatchText,
  writeFixture,
} from './test-helpers';

describe('apply-patch/rewrite', () => {
  test('rewritePatchText leaves a healthy patch intact', async () => {
    const root = await createTempDir();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );

    expect(await rewritePatchText(root, patchText)).toBe(patchText);
    expect(await rewritePatch(root, patchText)).toMatchObject({
      patchText,
      changed: false,
    });
  });

  test('rewritePatchText unwraps an exact patch wrapped in a heredoc', async () => {
    const root = await createTempDir();
    const cleanPatchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    const patchText = `cat <<'PATCH'
${cleanPatchText}
PATCH`;
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );

    expect(await rewritePatchText(root, patchText)).toBe(cleanPatchText);
    expect(await rewritePatch(root, patchText)).toMatchObject({
      patchText: cleanPatchText,
      changed: true,
    });
  });

  test('rewritePatchText normalizes exact CRLF + heredoc input and the patch still works', async () => {
    const root = await createTempDir();
    const cleanPatchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    const patchText = [
      "cat <<'PATCH'",
      '*** Begin Patch',
      '*** Update File: sample.txt',
      '@@ exact-top',
      '-exact-old',
      '+exact-new',
      ' exact-bottom',
      '*** End Patch',
      'PATCH',
    ].join('\r\n');
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );

    const rewritten = await rewritePatchText(root, patchText);

    expect(rewritten).toBe(cleanPatchText);
    await applyPatch(root, rewritten);
    expect(await readText(root, 'sample.txt')).toBe(
      'line-01\nexact-top\nexact-new\nexact-bottom\nline-05\n',
    );
  });

  test('rewritePatchText rewrites a stale patch and preserves new_lines byte-for-byte', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale-value\nsuffix\nbottom\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old-value
+ \tverbatim  ""  Ω  
 suffix
*** End Patch`;

    const rewritten = parsePatch(await rewritePatchText(root, patchText))
      .hunks[0];

    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.old_lines,
    ).toEqual(['prefix', 'stale-value', 'suffix']);
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.new_lines,
    ).toEqual(['prefix', ' \tverbatim  ""  Ω  ', 'suffix']);
  });

  test('rewritePatchText removes EOF when a rescue moves the chunk away from the real end', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale\nsuffix\nbottom\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old
+new
 suffix
*** End of File
*** End Patch`;

    const rewrittenText = await rewritePatchText(root, patchText);
    const rewritten = parsePatch(rewrittenText).hunks[0];

    expect(rewrittenText.includes('*** End of File')).toBeFalse();
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update'
        ? rewritten.chunks[0]?.is_end_of_file
        : undefined,
    ).toBeUndefined();
  });

  test('rewritePatchText keeps EOF when the resolved chunk still ends at the real end', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nstale\nomega');
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
-old
-omega
+alpha
+new
+omega
*** End of File
*** End Patch`;

    const rewrittenText = await rewritePatchText(root, patchText);
    const rewritten = parsePatch(rewrittenText).hunks[0];

    expect(rewrittenText.includes('*** End of File')).toBeTrue();
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update'
        ? rewritten.chunks[0]?.is_end_of_file
        : undefined,
    ).toBeTrue();
  });

  test.each([
    [
      'unicode',
      'sample.txt',
      'const title = “Hola”;\n',
      'const title = "Hola";',
      'const title = “Hola”;',
      'const title = "Hola mundo";',
    ],
    ['trim-end', 'sample.txt', 'alpha  \n', 'alpha', 'alpha  ', 'omega'],
    ['trim', 'sample.txt', '  alpha  \n', 'alpha', '  alpha  ', 'omega'],
    [
      'indent',
      'sample.yml',
      'root:\n  child:\n    enabled: false\nnext: true\n',
      'enabled: false',
      '    enabled: false',
      'enabled: true',
    ],
  ])(
    'canonicalizes %s matches',
    async (_, file, text, oldLine, canonicalOld, newLine) => {
      const root = await createTempDir();
      await writeFixture(root, file, text);
      const rewritten = parsePatch(
        await rewritePatchText(
          root,
          `*** Begin Patch
*** Update File: ${file}
@@
-${oldLine}
+${newLine}
*** End Patch`,
        ),
      ).hunks[0];

      expect(rewritten.type).toBe('update');
      if (rewritten.type === 'update') {
        expect(rewritten.chunks[0]?.old_lines).toEqual([canonicalOld]);
        expect(rewritten.chunks[0]?.new_lines).toEqual([newLine]);
      }
    },
  );

  test('rewritePatchText rejects malformed @@ instead of silently sanitizing it', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
garbage
-beta
+BETA
*** End Patch`,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in patch chunk: garbage',
    );
  });

  test('rewritePatchText rejects a malformed Add File', async () => {
    const root = await createTempDir();

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Add File: added.txt
+fresh
garbage
*** End Patch`,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in Add File body: garbage',
    );
  });

  test.each([
    [
      'Update File',
      'sample.txt',
      '*** Update File: %s\n@@\n-alpha\n+omega',
      { type: 'update', path: 'sample.txt' },
    ],
    [
      'Add File',
      'added.txt',
      '*** Add File: %s\n+fresh',
      { type: 'add', path: 'added.txt', contents: 'fresh' },
    ],
    [
      'Move to',
      'nested/after.txt',
      '*** Update File: before.txt\n*** Move to: %s\n@@\n alpha\n-beta\n+BETA',
      { type: 'update', path: 'before.txt', move_path: 'nested/after.txt' },
    ],
  ])('normalizes an absolute %s path', async (_, relative, body, expected) => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');
    const rewritten = await rewritePatch(
      root,
      `*** Begin Patch\n${body.replace('%s', path.join(root, relative))}\n*** End Patch`,
    );
    expect(rewritten.changed).toBeTrue();
    expect(parsePatch(rewritten.patchText).hunks[0]).toMatchObject(expected);
  });

  test.each(['absolute', 'symlink', 'relative'])(
    'blocks %s paths outside root/worktree',
    async (kind) => {
      const root = await createTempDir();
      const outsidePath = path.join(path.dirname(root), 'outside.txt');
      if (kind === 'symlink') {
        await writeFixture(root, 'before.txt', 'alpha\nbeta\n');
        await symlink(await createTempDir(), path.join(root, 'linked-outside'));
      }
      const target = kind === 'absolute' ? outsidePath : '../outside-added.txt';
      const body =
        kind === 'symlink'
          ? '*** Update File: before.txt\n*** Move to: linked-outside/missing/child.txt\n@@\n alpha\n-beta\n+BETA'
          : `*** Add File: ${target}\n+fresh`;
      const error = await rewritePatchText(
        root,
        `*** Begin Patch\n${body}\n*** End Patch`,
        kind === 'absolute' ? undefined : root,
      ).catch((caughtError) => caughtError);

      expect(error).toBeInstanceOf(ApplyPatchError);
      expect((error as ApplyPatchError).kind).toBe('blocked');
      expect((error as Error).message).toContain(
        'apply_patch blocked: patch contains path outside workspace root:',
      );
      if (kind === 'absolute') {
        expect((error as Error).message).toBe(
          `apply_patch blocked: patch contains path outside workspace root: ${outsidePath}`,
        );
      }
    },
  );

  test('rewritePatchText does not redirect an absolute root target to its basename', async () => {
    const root = await createTempDir();

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Add File: ${root}
+fresh
*** End Patch`,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Add File target already exists: ${root}`,
    );
  });

  test('rewritePatchText rejects Add File on an existing path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'added.txt', 'legacy\n');

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Add File: added.txt
+fresh
*** End Patch`,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Add File target already exists: ${path.join(root, 'added.txt')}`,
    );
  });

  test('P3 accepts a sibling filename beginning with two dots', async () => {
    const root = await createTempDir();
    await writeFixture(root, '..foo.txt', 'a\n');
    const input = `*** Begin Patch\n*** Update File: ..foo.txt\n@@\n-a\n+b\n*** End Patch`;
    await applyPatch(root, await rewritePatchText(root, input));
    expect(await readText(root, '..foo.txt')).toBe('b\n');
  });

  test.skipIf(process.platform === 'win32')(
    'P3 rejects a FIFO before attempting to read it',
    async () => {
      const root = await createTempDir();
      execFileSync('mkfifo', [path.join(root, 'pipe.txt')]);
      await expect(
        rewritePatchText(
          root,
          `*** Begin Patch\n*** Update File: pipe.txt\n@@\n-a\n+b\n*** End Patch`,
        ),
      ).rejects.toThrow('Failed to read file to update');
    },
  );

  test('rewritePatchText rejects Move to on a different existing destination', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');
    await writeFixture(root, 'nested/after.txt', 'legacy\n');

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Move destination already exists: ${path.join(root, 'nested/after.txt')}`,
    );
  });

  test.each(['a.txt', './a.txt'])(
    'T3/T3b blocks Move to the same resolved path: %s',
    async (destination) => {
      const root = await createTempDir();
      await writeFixture(root, 'a.txt', 'x\n');
      await expect(
        rewritePatchText(
          root,
          `*** Begin Patch\n*** Update File: a.txt\n*** Move to: ${destination}\n@@\n-x\n+y\n*** End Patch`,
        ),
      ).rejects.toThrow('Move destination is the source');
      expect(await readText(root, 'a.txt')).toBe('x\n');
    },
  );

  test.each([
    ['missing', 'missing.txt', undefined, '*** Delete File: missing.txt'],
    [
      'duplicate',
      'obsolete.txt',
      'legacy\n',
      '*** Delete File: obsolete.txt\n*** Delete File: obsolete.txt',
    ],
    [
      'after move',
      'before.txt',
      'alpha\nbeta\n',
      '*** Update File: before.txt\n*** Move to: nested/after.txt\n@@\n alpha\n-beta\n+BETA\n*** Delete File: before.txt',
    ],
  ])('rejects Delete File %s', async (_, file, initial, body) => {
    const root = await createTempDir();
    if (initial !== undefined) await writeFixture(root, file, initial);
    await expect(
      rewritePatchText(root, `*** Begin Patch\n${body}\n*** End Patch`),
    ).rejects.toThrow(
      `apply_patch verification failed: Failed to read file to delete: ${path.join(root, file)}`,
    );
  });

  test('rewritePatchText keeps a valid Delete File and apply still works', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'obsolete.txt', 'legacy\n');
    const patchText = `*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch`;

    expect(await rewritePatchText(root, patchText)).toBe(patchText);

    await applyPatch(root, patchText);
    await expect(readText(root, 'obsolete.txt')).rejects.toThrow();
  });

  test('rewritePatch groups two exact Update File hunks on the same path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\ndelta\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: sample.txt
@@
 gamma
-delta
+DELTA
*** End Patch`,
    );

    const rewritten = parsePatch(result.patchText);
    expect(result.changed).toBeTrue();
    expect(rewritten.hunks).toHaveLength(1);
    expect(rewritten.hunks[0]).toEqual({
      type: 'update',
      path: 'sample.txt',
      move_path: undefined,
      chunks: [
        {
          old_lines: ['beta'],
          new_lines: ['BETA'],
          change_context: 'alpha',
          is_end_of_file: undefined,
        },
        {
          old_lines: ['delta'],
          new_lines: ['DELTA'],
          change_context: 'gamma',
          is_end_of_file: undefined,
        },
      ],
    });
  });

  test('rewritePatch groups a second update that depends on the first', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');

    const rewrittenText = await rewritePatchText(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: sample.txt
@@
 alpha
-BETA
+BETA!
 gamma
*** End Patch`,
    );

    expect(parsePatch(rewrittenText).hunks).toEqual([
      {
        type: 'update',
        path: 'sample.txt',
        move_path: undefined,
        chunks: [
          {
            old_lines: ['beta'],
            new_lines: ['BETA!'],
            change_context: 'alpha',
            is_end_of_file: undefined,
          },
        ],
      },
    ]);

    await applyPatch(root, rewrittenText);
    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA!\ngamma\n');
  });

  test('rewritePatch collapses Add File + exact Update File into a self-contained add', async () => {
    const root = await createTempDir();

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: added.txt
+alpha
+beta
*** Update File: added.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
    );

    expect(result.changed).toBeTrue();
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'add',
        path: 'added.txt',
        contents: 'alpha\nBETA',
      },
    ]);
  });

  test('rewritePatch collapses Add File + Update File + Move to into a self-contained final add', async () => {
    const root = await createTempDir();

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: before.txt
+alpha
+beta
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
    );

    expect(result.changed).toBeTrue();
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'add',
        path: 'nested/after.txt',
        contents: 'alpha\nBETA',
      },
    ]);
  });

  test('rewritePatch collapses an exact move followed by an update on the destination', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\ngamma\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: nested/after.txt
@@
 alpha
 BETA
-gamma
+GAMMA
*** End Patch`,
    );

    expect(result.changed).toBeTrue();
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'update',
        path: 'before.txt',
        move_path: 'nested/after.txt',
        chunks: [
          {
            old_lines: ['beta', 'gamma'],
            new_lines: ['BETA', 'GAMMA'],
            change_context: 'alpha',
            is_end_of_file: true,
          },
        ],
      },
    ]);
  });

  test('rewritePatch minimizes whole-file collapse when the fallback remains verifiable', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\ngamma\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
 beta
 gamma
*** Update File: nested/after.txt
@@
 alpha
-beta
+BETA
 gamma
*** End Patch`,
    );

    expect(result.changed).toBeTrue();
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'update',
        path: 'before.txt',
        move_path: 'nested/after.txt',
        chunks: [
          {
            old_lines: ['beta'],
            new_lines: ['BETA'],
            change_context: 'alpha',
            is_end_of_file: undefined,
          },
        ],
      },
    ]);

    await applyPatch(root, result.patchText);
    expect(await readText(root, 'nested/after.txt')).toBe(
      'alpha\nBETA\ngamma\n',
    );
  });

  test('rewritePatchText fails when rescue is ambiguous', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'left\nstale-one\nright\nseparator\nleft\nstale-two\nright\n',
    );

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Update File: sample.txt
@@
 left
-old
+new
 right
*** End Patch`,
      ),
    ).rejects.toThrow('apply_patch verification failed:');
  });

  test('applyPatch supports move + update when the block is stale', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'before.txt',
      'top\nprefix\nstale-value\nsuffix\nbottom\n',
    );

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@ top
 prefix
-old-value
+new-value
 suffix
*** End Patch`,
    );

    expect(await readText(root, 'nested/after.txt')).toBe(
      'top\nprefix\nnew-value\nsuffix\nbottom\n',
    );
    await expect(readText(root, 'before.txt')).rejects.toThrow();
  });

  test('applyPatch preserves CRLF with stale rescue + exact chunk', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'top\r\nprefix\r\nstale-value\r\nsuffix\r\nkeep\r\ntail-old\r\n',
    );

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old-value
+new-value
 suffix
@@ suffix
 keep
-tail-old
+tail-new
*** End Patch`,
    );

    expect(await readText(root, 'sample.txt')).toBe(
      'top\r\nprefix\r\nnew-value\r\nsuffix\r\nkeep\r\ntail-new\r\n',
    );
  });

  test('applyPatch accumulates two Update File hunks on the same path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: sample.txt
@@
 alpha
 BETA
-gamma
+GAMMA
*** End Patch`,
    );

    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA\nGAMMA\n');
  });

  test.each([
    {
      name: 'add + update',
      initial: { 'sample.txt': 'alpha\nbeta\n' },
      patch:
        '*** Add File: added.txt\n+fresh\n*** Update File: sample.txt\n@@\n alpha\n-beta\n+BETA',
      expected: {
        'added.txt': 'fresh\n',
        'sample.txt': 'alpha\nBETA\n',
      } as Record<string, string | null>,
    },
    {
      name: 'update + delete',
      initial: { 'sample.txt': 'alpha\nbeta\n', 'obsolete.txt': 'legacy\n' },
      patch:
        '*** Update File: sample.txt\n@@\n alpha\n-beta\n+BETA\n*** Delete File: obsolete.txt',
      expected: {
        'sample.txt': 'alpha\nBETA\n',
        'obsolete.txt': null,
      } as Record<string, string | null>,
    },
    {
      name: 'move + add',
      initial: { 'before.txt': 'alpha\nbeta\n' },
      patch:
        '*** Update File: before.txt\n*** Move to: nested/after.txt\n@@\n alpha\n-beta\n+BETA\n*** Add File: before.txt\n+replacement',
      expected: {
        'nested/after.txt': 'alpha\nBETA\n',
        'before.txt': 'replacement\n',
      } as Record<string, string | null>,
    },
  ])(
    'applyPatch applies $name in the same patch',
    async ({ initial, patch, expected }) => {
      const root = await createTempDir();
      for (const [file, text] of Object.entries(initial)) {
        await writeFixture(root, file, text);
      }
      await applyPatch(root, `*** Begin Patch\n${patch}\n*** End Patch`);
      for (const [file, text] of Object.entries(expected)) {
        if (text === null) {
          await expect(readText(root, file)).rejects.toThrow();
        } else {
          expect(await readText(root, file)).toBe(text);
        }
      }
    },
  );

  test('rewritePatch re-emits a folded move after a later delete of its destination', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'a.txt', 'alpha\n');
    await writeFixture(root, 'b.txt', 'beta\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: b.txt
@@
-beta
+BETA
*** Delete File: b.txt
*** Update File: a.txt
*** Move to: b.txt
@@
-ALPHA
+ALPHA-MOVED
*** End Patch`,
    );

    // The folded update+move over a.txt must be emitted after Delete b.txt
    // so the destination is free, not hoisted above it.
    const hunks = parsePatch(result.patchText).hunks;
    const deleteIndex = hunks.findIndex((hunk) => hunk.type === 'delete');
    const lastIndex = hunks.length - 1;
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(hunks[lastIndex]).toMatchObject({
      type: 'update',
      path: 'a.txt',
      move_path: 'b.txt',
    });
    expect(deleteIndex).toBeLessThan(lastIndex);

    await applyPatch(root, result.patchText);
    expect(await readText(root, 'b.txt')).toBe('ALPHA-MOVED\n');
  });

  test('rewritePatch serializes non-overlapping canonical chunks when a rescue shares context', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'a\nold\nz\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 a
-stale
+fresh
 z
@@
-z
+Z2
*** End Patch`,
    );

    // The stale first chunk is rescued with shared suffix `z`; the second
    // chunk edits that same `z`. The rewritten patch must not consume `z`
    // twice and must re-apply cleanly.
    await applyPatch(root, result.patchText);
    expect(await readText(root, 'sample.txt')).toBe('a\nfresh\nZ2\n');
  });

  test('EOF insertion into an empty file does not create a leading blank line', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'empty.txt', '');

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: empty.txt
@@
+hello
*** End of File
*** End Patch`,
    );

    // Zero-line representation: no phantom leading blank line. The missing
    // final newline matches the empty file's original terminator state.
    expect(await readText(root, 'empty.txt')).toBe('hello');
  });

  test('rewritePatch emits a folded add with canonical terminator when finalText lacks a final newline', async () => {
    const root = await createTempDir();

    // Empty Add (no `+` lines) followed by an EOF update on the empty file:
    // finalText is 'hello' with NO final newline, which the renderer would
    // silently drop without canonical termination.
    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: made.txt
*** Update File: made.txt
@@
+hello
*** End of File
*** End Patch`,
    );

    const hunks = parsePatch(result.patchText).hunks;
    expect(hunks[hunks.length - 1]).toMatchObject({
      type: 'add',
      contents: 'hello',
    });

    await applyPatch(root, result.patchText);
    expect(await readText(root, 'made.txt')).toBe('hello\n');
  });

  test('rewritePatch keeps a later add on the freed move source after the folded group', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'a.txt', 'alpha\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
-alpha
+ALPHA
*** Add File: a.txt
+recreated
*** Update File: b.txt
@@
-ALPHA
+ALPHA-MOVED
*** End Patch`,
    );

    // The add on the freed source a.txt must stay AFTER the folded move
    // group, or it would collide with the still-existing original a.txt.
    const hunks = parsePatch(result.patchText).hunks;
    const addIndex = hunks.findIndex(
      (hunk) => hunk.type === 'add' && hunk.path === 'a.txt',
    );
    const moveIndex = hunks.findIndex(
      (hunk) => hunk.type === 'update' && hunk.move_path === 'b.txt',
    );
    expect(moveIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(moveIndex);

    await applyPatch(root, result.patchText);
    expect(await readText(root, 'a.txt')).toBe('recreated\n');
    expect(await readText(root, 'b.txt')).toBe('ALPHA-MOVED\n');
  });
});
