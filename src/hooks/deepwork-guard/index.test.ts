import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import {
  createDeepworkGuardHook,
  guardOptionsFrom,
  missingReceipts,
  recordClaim,
  recordReceipt,
  referencedArtifacts,
  taskSlug,
  unreceiptedArtifacts,
} from './index';

function makeCtx(directory: string): PluginInput {
  return { client: {}, directory } as PluginInput;
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'deepwork-guard-'));
  mkdirSync(path.join(root, '.slim', 'deepwork'), { recursive: true });
  return root;
}

function clean(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('deepwork guard', () => {
  test('taskSlug resolves task-directory writes only', () => {
    const root = makeRoot();
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    expect(
      taskSlug(deepworkRoot, path.join(deepworkRoot, 'my-task', 'progress.md')),
    ).toBe('my-task');
    expect(
      taskSlug(
        deepworkRoot,
        path.join(deepworkRoot, 'my-task', 'nested', 'a.md'),
      ),
    ).toBe('my-task');
    expect(
      taskSlug(deepworkRoot, path.join(deepworkRoot, 'ses-1.md')),
    ).toBeNull();
    expect(
      taskSlug(
        deepworkRoot,
        path.join(deepworkRoot, '.runtime', 'receipts', 'x.jsonl'),
      ),
    ).toBeNull();
    expect(
      taskSlug(deepworkRoot, path.join(deepworkRoot, 'foo.py')),
    ).toBeNull();
    expect(taskSlug(deepworkRoot, path.join(root, 'src', 'a.ts'))).toBeNull();
    clean(root);
  });

  test('guardOptionsFrom: off switch, mode flip, invalid fallback', () => {
    expect(guardOptionsFrom(['deepwork-guard'], 'enforce')).toEqual({
      enabled: false,
      mode: 'shadow',
    });
    expect(guardOptionsFrom([], 'enforce')).toEqual({
      enabled: true,
      mode: 'enforce',
    });
    expect(guardOptionsFrom([], 'shadow')).toEqual({
      enabled: true,
      mode: 'shadow',
    });
    expect(guardOptionsFrom([], undefined)).toEqual({
      enabled: true,
      mode: 'shadow',
    });
    expect(guardOptionsFrom([], 'block')).toEqual({
      enabled: true,
      mode: 'shadow',
    });
  });

  test('claim: first writer owns, owner refreshes, foreign untouched', () => {
    const root = makeRoot();
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    recordClaim(deepworkRoot, 't1', 'ses-a', 1000);
    const claimPath = path.join(deepworkRoot, '.runtime', 'claims', 't1.json');
    expect(JSON.parse(readFileSync(claimPath, 'utf-8'))).toMatchObject({
      owner: 'ses-a',
      since: 1000,
    });
    recordClaim(deepworkRoot, 't1', 'ses-a', 2000);
    expect(JSON.parse(readFileSync(claimPath, 'utf-8'))).toMatchObject({
      owner: 'ses-a',
      since: 1000,
      lastActive: 2000,
    });
    recordClaim(deepworkRoot, 't1', 'ses-b', 3000);
    expect(JSON.parse(readFileSync(claimPath, 'utf-8'))).toMatchObject({
      owner: 'ses-a',
      lastActive: 2000,
    });
    clean(root);
  });

  test('receipt: records path, bytes, session; missing file records nothing', () => {
    const root = makeRoot();
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const dir = path.join(deepworkRoot, 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.md'), 'hello receipt');
    recordReceipt(
      deepworkRoot,
      {
        slug: 't1',
        filePath: path.join(dir, 'a.md'),
        refPath: '.slim/deepwork/t1/a.md',
      },
      'ses-a',
    );
    const receiptsPath = path.join(
      deepworkRoot,
      '.runtime',
      'receipts',
      't1.jsonl',
    );
    const lines = readFileSync(receiptsPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      path: '.slim/deepwork/t1/a.md',
      bytes: 'hello receipt'.length,
      sessionID: 'ses-a',
    });
    recordReceipt(
      deepworkRoot,
      {
        slug: 't1',
        filePath: path.join(dir, 'ghost.md'),
        refPath: '.slim/deepwork/t1/ghost.md',
      },
      'ses-a',
    );
    expect(readFileSync(receiptsPath, 'utf-8').trim().split('\n')).toHaveLength(
      1,
    );
    clean(root);
  });

  test('referencedArtifacts extracts same-slug refs only', () => {
    const content = [
      'see `.slim/deepwork/t1/a.md` and .slim/deepwork/t1/b.md',
      'other: .slim/deepwork/t2/c.md',
      'runtime: .slim/deepwork/t1/.runtime/receipts/t1.jsonl',
    ].join('\n');
    expect(referencedArtifacts(content, 't1')).toEqual([
      '.slim/deepwork/t1/a.md',
      '.slim/deepwork/t1/b.md',
    ]);
  });

  test('missingReceipts compares refs against recorded paths', () => {
    const root = makeRoot();
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const receiptsDir = path.join(deepworkRoot, '.runtime', 'receipts');
    mkdirSync(receiptsDir, { recursive: true });
    writeFileSync(
      path.join(receiptsDir, 't1.jsonl'),
      `${JSON.stringify({ path: '.slim/deepwork/t1/a.md' })}\n`,
    );
    expect(
      missingReceipts(deepworkRoot, 't1', ['.slim/deepwork/t1/a.md']),
    ).toEqual([]);
    expect(
      missingReceipts(deepworkRoot, 't1', [
        '.slim/deepwork/t1/a.md',
        '.slim/deepwork/t1/ghost.md',
      ]),
    ).toEqual(['.slim/deepwork/t1/ghost.md']);
    clean(root);
  });

  test('unreceiptedArtifacts: receipted refs pass, missing refs reported', () => {
    const root = makeRoot();
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const receiptsDir = path.join(deepworkRoot, '.runtime', 'receipts');
    mkdirSync(receiptsDir, { recursive: true });
    writeFileSync(
      path.join(receiptsDir, 't1.jsonl'),
      `${JSON.stringify({ path: '.slim/deepwork/t1/real.md' })}\n`,
    );
    expect(
      unreceiptedArtifacts(
        deepworkRoot,
        't1',
        'status: completed\n\nsee `.slim/deepwork/t1/real.md`\n',
      ),
    ).toEqual([]);
    expect(
      unreceiptedArtifacts(
        deepworkRoot,
        't1',
        'status: completed\n\nsee `.slim/deepwork/t1/ghost.md`\n',
      ),
    ).toEqual(['.slim/deepwork/t1/ghost.md']);
    clean(root);
  });

  test('referencedArtifacts strips trailing sentence punctuation', () => {
    expect(
      referencedArtifacts(
        'see .slim/deepwork/t1/a.md. Also `.slim/deepwork/t1/b.md`.',
        't1',
      ),
    ).toEqual(['.slim/deepwork/t1/a.md', '.slim/deepwork/t1/b.md']);
  });

  test('write completions are blocked before landing in enforce mode', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.opencode'), { recursive: true });
    writeFileSync(
      path.join(root, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ deepworkGuardMode: 'enforce' }),
    );
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    expect(() =>
      hook['tool.execute.before'](
        { tool: 'write', sessionID: 'ses-a', callID: 'c1' },
        {
          args: {
            path: path.join(deepworkRoot, 't1', 'progress.md'),
            content: 'status: completed\n\nsee `.slim/deepwork/t1/ghost.md`\n',
          },
        },
      ),
    ).toThrow(/Completion blocked/);
    clean(root);
  });

  test('failed edits record no receipt (unchanged file)', () => {
    const root = makeRoot();
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const dir = path.join(deepworkRoot, 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.md'), 'old content');
    hook['tool.execute.before'](
      { tool: 'edit', sessionID: 'ses-a', callID: 'c1' },
      {
        args: { path: path.join(dir, 'a.md'), oldString: 'x', newString: 'y' },
      },
    );
    // The edit fails: the file is untouched, so no receipt is recorded.
    hook['tool.execute.after'](
      { tool: 'edit', sessionID: 'ses-a', callID: 'c1' },
      {},
    );
    expect(
      existsSync(path.join(deepworkRoot, '.runtime', 'receipts', 't1.jsonl')),
    ).toBe(false);
    clean(root);
  });

  test('edit completions are blocked before landing in enforce mode', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.opencode'), { recursive: true });
    writeFileSync(
      path.join(root, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ deepworkGuardMode: 'enforce' }),
    );
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const progressPath = path.join(deepworkRoot, 't1', 'progress.md');
    mkdirSync(path.dirname(progressPath), { recursive: true });
    writeFileSync(
      progressPath,
      'status: active\n\nsee `.slim/deepwork/t1/ghost.md`\n',
    );
    // The edit's fragment carries no artifact refs, but the before phase
    // simulates the resulting content and blocks the flip before it lands.
    expect(() =>
      hook['tool.execute.before'](
        { tool: 'edit', sessionID: 'ses-a', callID: 'c1' },
        {
          args: {
            path: progressPath,
            oldString: 'status: active',
            newString: 'status: completed',
          },
        },
      ),
    ).toThrow(/Completion blocked/);
    clean(root);
  });

  test('the after phase catches landed flips the simulation misses', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.opencode'), { recursive: true });
    writeFileSync(
      path.join(root, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ deepworkGuardMode: 'enforce' }),
    );
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const progressPath = path.join(deepworkRoot, 't1', 'progress.md');
    mkdirSync(path.dirname(progressPath), { recursive: true });
    writeFileSync(
      progressPath,
      'status: active\n\nsee `.slim/deepwork/t1/ghost.md`\n',
    );
    // A body edit the simulation clears (no flip in the resulting content):
    // the before phase passes, the file lands flipped anyway, and the after
    // phase validates from the landed file and alerts in enforce mode.
    hook['tool.execute.before'](
      { tool: 'edit', sessionID: 'ses-a', callID: 'c1' },
      {
        args: {
          path: progressPath,
          oldString: 'see notes',
          newString: 'see docs',
        },
      },
    );
    writeFileSync(
      progressPath,
      'status: completed\n\nsee `.slim/deepwork/t1/ghost.md`\n',
    );
    const output = { output: 'edited' };
    hook['tool.execute.after'](
      { tool: 'edit', sessionID: 'ses-a', callID: 'c1' },
      output,
    );
    expect(String(output.output)).toContain('Completion not accepted');
    clean(root);
  });

  test('hook: task writes record claim + receipt; completion prunes', () => {
    const root = makeRoot();
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    hook['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-a', callID: 'c1' },
      {
        args: { path: path.join(deepworkRoot, 't1', 'a.md'), content: 'x' },
      },
    );
    mkdirSync(path.join(deepworkRoot, 't1'), { recursive: true });
    writeFileSync(path.join(deepworkRoot, 't1', 'a.md'), 'artifact');
    hook['tool.execute.after'](
      { tool: 'write', sessionID: 'ses-a', callID: 'c1' },
      {},
    );
    expect(
      existsSync(path.join(deepworkRoot, '.runtime', 'claims', 't1.json')),
    ).toBe(true);
    expect(
      existsSync(path.join(deepworkRoot, '.runtime', 'receipts', 't1.jsonl')),
    ).toBe(true);
    hook['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-a', callID: 'c2' },
      {
        args: {
          path: path.join(deepworkRoot, 't1', 'progress.md'),
          content: 'status: completed\n\nsee `.slim/deepwork/t1/a.md`\n',
        },
      },
    );
    writeFileSync(
      path.join(deepworkRoot, 't1', 'progress.md'),
      'status: completed\n\nsee `.slim/deepwork/t1/a.md`\n',
    );
    hook['tool.execute.after'](
      { tool: 'write', sessionID: 'ses-a', callID: 'c2' },
      {},
    );
    expect(
      existsSync(path.join(deepworkRoot, '.runtime', 'receipts', 't1.jsonl')),
    ).toBe(false);
    // The claim is released with the receipts: the completed task is
    // cleanly adoptable (Trellis clears pointers at archive).
    expect(
      existsSync(path.join(deepworkRoot, '.runtime', 'claims', 't1.json')),
    ).toBe(false);
    clean(root);
  });

  test('completion re-edits do not re-trigger the gate (flip idempotence)', () => {
    const root = makeRoot();
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    const progressPath = path.join(deepworkRoot, 't1', 'progress.md');
    mkdirSync(path.join(deepworkRoot, 't1'), { recursive: true });
    // The file is already completed; a re-edit (typo fix) referencing a
    // ghost artifact must NOT trigger the gate.
    writeFileSync(
      progressPath,
      'status: completed\n\nsee `.slim/deepwork/t1/a.md`\n',
    );
    expect(() =>
      hook['tool.execute.before'](
        { tool: 'edit', sessionID: 'ses-a', callID: 'c1' },
        {
          args: {
            path: progressPath,
            newString:
              'status: completed\n\nsee `.slim/deepwork/t1/ghost.md`\n',
          },
        },
      ),
    ).not.toThrow();
    clean(root);
  });

  test('phantom writes produce no receipt and fail the gate', () => {
    const root = makeRoot();
    const hook = createDeepworkGuardHook(makeCtx(root));
    const deepworkRoot = path.join(root, '.slim', 'deepwork');
    // A lane "writes" a file that never lands: the before-hook captures it,
    // the after-hook's stat fails, no receipt is recorded.
    hook['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-a', callID: 'c1' },
      {
        args: { path: path.join(deepworkRoot, 't1', 'ghost.md'), content: 'x' },
      },
    );
    hook['tool.execute.after'](
      { tool: 'write', sessionID: 'ses-a', callID: 'c1' },
      {},
    );
    expect(
      existsSync(path.join(deepworkRoot, '.runtime', 'receipts', 't1.jsonl')),
    ).toBe(false);
    const content = 'status: completed\n\nsee `.slim/deepwork/t1/ghost.md`\n';
    expect(unreceiptedArtifacts(deepworkRoot, 't1', content)).toEqual([
      '.slim/deepwork/t1/ghost.md',
    ]);
    clean(root);
  });

  test('completion gate format is pinned to the SKILL.md contract', () => {
    // SSoT: the gate's flip detection parses the contract's stated tombstone
    // format; a contract format change must update both together.
    const skill = readFileSync(
      path.join(import.meta.dir, '../../skills/deepwork/SKILL.md'),
      'utf-8',
    );
    expect(skill).toContain('`status: completed`');
  });
});
