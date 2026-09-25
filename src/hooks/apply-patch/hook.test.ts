import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parsePatch } from './codec';
import { createApplyPatchHook } from './index';
import { applyPatch, createTempDir, writeFixture } from './test-helpers';

function createHook() {
  return createApplyPatchHook({
    client: {} as never,
    directory: '/tmp/hook-root',
    worktree: '/tmp/hook-root',
  } as never);
}

async function runHook(root: string, patchText: string, worktree?: string) {
  const hook = worktree
    ? createApplyPatchHook({
        client: {} as never,
        directory: root,
        worktree,
      } as never)
    : createHook();
  const output = { args: { patchText } };
  await hook['tool.execute.before'](
    { tool: 'apply_patch', directory: root },
    output,
  );
  return output.args.patchText;
}

describe('apply-patch/hook', () => {
  test('ignores tools other than apply_patch', async () => {
    const hook = createHook();
    const patchText = '*** Begin Patch\n*** End Patch';
    const output = { args: { patchText } };

    await hook['tool.execute.before']({ tool: 'read' }, output);

    expect(output.args.patchText).toBe(patchText);
  });

  test('blocks an unrecoverable patch as verification before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-missing
+omega
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find expected lines',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('passes through an absolute target outside root/worktree before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const outsideDir = await createTempDir('apply-patch-hook-outside-');
    const outsidePath = path.join(outsideDir, 'outside.txt');
    await writeFile(outsidePath, 'outside\n', 'utf-8');
    const patchText = `*** Begin Patch
*** Update File: ${outsidePath}
@@
-outside
+changed
*** End Patch`;
    expect(await runHook(root, patchText, root)).toBe(patchText);
    expect(await readFile(outsidePath, 'utf-8')).toBe('outside\n');
  });

  test('rewrites a stale prefix patch and remains applicable', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nA\nB-stale\nC\nD\nE\nbottom\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 A
-B
-C
-D
-E
+B
+C
+D
+X
*** End Patch`;
    const rewrittenText = await runHook(root, patchText);
    const rewritten = parsePatch(rewrittenText).hunks[0];
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.old_lines,
    ).toEqual(['A', 'B-stale', 'C', 'D', 'E']);

    await applyPatch(root, rewrittenText);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nA\nB\nC\nD\nX\nbottom\n',
    );
  });

  test('rewrites by replacing readonly args instead of mutating them', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const args = Object.freeze({ patchText });
    const output = { args };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    expect(output.args).not.toBe(args);
    expect(output.args.patchText).toContain('-stale-value');
    expect(output.args.patchText).toContain('+new-value');
  });

  test('fails open when output args cannot be replaced', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const args = Object.freeze({ patchText });
    const output = {} as { args?: typeof args };
    Object.defineProperty(output, 'args', {
      configurable: false,
      enumerable: true,
      get: () => args,
    });

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).resolves.toBeUndefined();

    expect(output.args).toBe(args);
    expect(output.args?.patchText).toBe(patchText);
  });

  test('blocks a malformed @@ at runtime before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
garbage
-beta
+BETA
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in patch chunk: garbage',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('blocks internal guard errors before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const lockedDir = path.join(root, 'locked');
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o000);
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Add File: locked/child.txt
+fresh
*** End Patch`;
    const output = { args: { patchText } };

    try {
      await expect(
        hook['tool.execute.before'](
          { tool: 'apply_patch', directory: root },
          output,
        ),
      ).rejects.toThrow('apply_patch internal error:');

      expect(output.args.patchText).toBe(patchText);
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });

  test('rewrites anchored insertion to avoid native EOF handling', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nanchor-insert\nafter-anchor\nend\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ anchor-insert
+middle-inserted
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    await applyPatch(root, output.args.patchText as string);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nanchor-insert\nmiddle-inserted\nafter-anchor\nend\n',
    );
  });

  test('rewrites only the update hunk in a patch with add + update', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale-value\nsuffix\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Add File: added.txt
+fresh
*** Update File: sample.txt
@@ top
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    const rewritten = parsePatch(output.args.patchText as string);
    expect(rewritten.hunks[0]).toEqual({
      type: 'add',
      path: 'added.txt',
      contents: 'fresh',
    });
    expect(rewritten.hunks[1]).toEqual({
      type: 'update',
      path: 'sample.txt',
      chunks: [
        {
          old_lines: ['prefix', 'stale-value', 'suffix'],
          new_lines: ['prefix', 'new-value', 'suffix'],
          change_context: 'top',
          is_end_of_file: undefined,
        },
      ],
    });

    await applyPatch(root, output.args.patchText as string);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nprefix\nnew-value\nsuffix\n',
    );
    expect(await readFile(path.join(root, 'added.txt'), 'utf-8')).toBe(
      'fresh\n',
    );
  });

  test('normalizes an absolute path inside worktree even when it is outside root', async () => {
    const worktree = await createTempDir('apply-patch-worktree-');
    const root = path.join(worktree, 'subdir');
    await mkdir(root, { recursive: true });
    const siblingPath = path.join(worktree, 'shared.txt');
    const hook = createApplyPatchHook({
      client: {} as never,
      directory: root,
      worktree,
    } as never);
    const patchText = `*** Begin Patch
*** Add File: ${siblingPath}
+fresh
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).resolves.toBeUndefined();

    expect(parsePatch(output.args.patchText as string).hunks[0]).toMatchObject({
      type: 'add',
      path: '../shared.txt',
      contents: 'fresh',
    });
  });

  test('passes through mixed patches with outside paths without partial rewrite', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const outsideDir = await createTempDir('apply-patch-hook-outside-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    await writeFixture(outsideDir, 'outside.txt', 'legacy\n');
    const hook = createHook();
    const outsideAdded = path.join(path.dirname(root), 'outside-added.txt');
    const patchText = `*** Begin Patch
*** Add File: ../outside-added.txt
+fresh
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** Delete File: ../${path.basename(outsideDir)}/outside.txt
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).resolves.toBeUndefined();

    expect(output.args.patchText).toBe(patchText);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'prefix\nstale-value\nsuffix\n',
    );
    expect(await stat(outsideAdded).catch(() => null)).toBeNull();
    expect(await readFile(path.join(outsideDir, 'outside.txt'), 'utf-8')).toBe(
      'legacy\n',
    );
  });

  test('does not expose the tool.execute.after hook', () => {
    const hook = createHook() as Record<string, unknown>;

    expect(hook['tool.execute.after']).toBeUndefined();
  });

  test('does not alter an exact patch', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
 beta
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    expect(output.args.patchText).toBe(patchText);
  });
});
