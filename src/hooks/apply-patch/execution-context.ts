import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { parsePatch } from './codec';
import { ApplyPatchError, getErrorMessage } from './errors';
import { applyHits, resolveUpdateChunksFromText } from './resolution';
import type {
  AddPatchHunk,
  DeletePatchHunk,
  PatchHunk,
  UpdatePatchHunk,
} from './types';

type PathGuardContext = {
  root: string;
  rootReal?: Promise<string>;
  worktree?: string;
  worktreeReal?: Promise<string>;
};

type FileCacheContext = {
  stats: Map<string, Promise<Stats | null>>;
};

export type PreparedFileState =
  | {
      exists: false;
      derived: boolean;
    }
  | {
      exists: true;
      text: string;
      mode?: number;
      derived: boolean;
    };

type ExistingFileState = Extract<PreparedFileState, { exists: true }>;

export type SimulatedStep =
  | { type: 'add'; hunk: AddPatchHunk; filePath: string; finalText: string }
  | { type: 'delete'; hunk: DeletePatchHunk; filePath: string }
  | {
      type: 'update';
      hunk: UpdatePatchHunk;
      filePath: string;
      movePath?: string;
      current: ExistingFileState;
      resolved: ResolvedPreparedUpdate['resolved'];
      nextText: string;
    };

export type PatchExecutionContext = {
  hunks: PatchHunk[];
  pathsNormalized: boolean;
  staged: Map<string, PreparedFileState>;
  getPreparedFileState: (
    filePath: string,
    verb: 'update' | 'delete',
  ) => Promise<ExistingFileState>;
  assertPreparedPathMissing: (
    filePath: string,
    verb: 'add' | 'move',
  ) => Promise<void>;
};

export type ResolvedPreparedUpdate = {
  resolved: Awaited<ReturnType<typeof resolveUpdateChunksFromText>>['resolved'];
  nextText: string;
};

export function isMissingPathError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function real(target: string): Promise<string> {
  const parts: string[] = [];
  let current = path.resolve(target);

  while (true) {
    const exact = await fs.realpath(current).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw new ApplyPatchError(
        'internal',
        `Failed to resolve real path: ${current}`,
        error,
      );
    });
    if (exact) {
      return parts.length === 0 ? exact : path.join(exact, ...parts.reverse());
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return parts.length === 0
        ? current
        : path.join(current, ...parts.reverse());
    }

    parts.push(path.basename(current));
    current = parent;
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createPathGuardContext(
  root: string,
  worktree: string | undefined,
): PathGuardContext {
  return { root, worktree };
}

async function guard(ctx: PathGuardContext, target: string): Promise<void> {
  const targetReal = await real(target);
  // Both resolutions are lazy: whichever rejects first is observed here,
  // and the other is never created, so no promise is left unhandled.
  ctx.rootReal ??= real(ctx.root);
  if (inside(await ctx.rootReal, targetReal)) {
    return;
  }

  if (!ctx.worktree) {
    throw new ApplyPatchError(
      'blocked',
      `patch contains path outside workspace root: ${target}`,
    );
  }

  // Resolve the worktree lazily: patches whose targets all live inside root
  // never pay for it, and its rejection stays observed inside this flow
  // instead of becoming an unhandled promise.
  ctx.worktreeReal ??= ctx.worktree !== '/' ? real(ctx.worktree) : undefined;
  if (!ctx.worktreeReal) {
    throw new ApplyPatchError(
      'blocked',
      `patch contains path outside workspace root: ${target}`,
    );
  }

  if (inside(await ctx.worktreeReal, targetReal)) {
    return;
  }

  throw new ApplyPatchError(
    'blocked',
    `patch contains path outside workspace root: ${target}`,
  );
}

function createFileCacheContext(): FileCacheContext {
  return { stats: new Map() };
}

async function statCached(
  ctx: FileCacheContext,
  filePath: string,
): Promise<Stats | null> {
  let pending = ctx.stats.get(filePath);
  if (!pending) {
    const nextPending = fs.stat(filePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw new ApplyPatchError(
        'internal',
        `Failed to stat file for patch verification: ${filePath}`,
        error,
      );
    });
    ctx.stats.set(filePath, nextPending);
    pending = nextPending;
  }

  return await pending;
}

async function assertRegularFile(
  ctx: FileCacheContext,
  filePath: string,
  verb: 'update' | 'delete',
): Promise<void> {
  const stat = await statCached(ctx, filePath);
  if (!stat || stat.isDirectory()) {
    throw new ApplyPatchError(
      'verification',
      `Failed to read file to ${verb}: ${filePath}`,
    );
  }
}

function collectPatchTargets(root: string, hunks: PatchHunk[]): string[] {
  const targets = new Set<string>();

  for (const hunk of hunks) {
    targets.add(path.resolve(root, hunk.path));

    if (hunk.type === 'update' && hunk.move_path) {
      targets.add(path.resolve(root, hunk.move_path));
    }
  }

  return [...targets];
}

function toRelativePatchPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  return (relative.length === 0 ? '.' : relative).replaceAll('\\', '/');
}

function normalizePatchPath(root: string, value: string): string {
  return path.isAbsolute(value)
    ? toRelativePatchPath(root, path.resolve(value))
    : value;
}

function normalizePatchPaths(
  root: string,
  hunks: PatchHunk[],
): {
  hunks: PatchHunk[];
  changed: boolean;
} {
  const resolvedRoot = path.resolve(root);
  const normalized: PatchHunk[] = [];
  let changed = false;

  for (const hunk of hunks) {
    const normalizedPath = normalizePatchPath(resolvedRoot, hunk.path);

    if (hunk.type !== 'update') {
      changed ||= normalizedPath !== hunk.path;
      normalized.push(
        normalizedPath === hunk.path
          ? hunk
          : {
              ...hunk,
              path: normalizedPath,
            },
      );
      continue;
    }

    const normalizedMovePath = hunk.move_path
      ? normalizePatchPath(resolvedRoot, hunk.move_path)
      : undefined;
    changed ||=
      normalizedPath !== hunk.path || normalizedMovePath !== hunk.move_path;

    normalized.push(
      normalizedPath === hunk.path && normalizedMovePath === hunk.move_path
        ? hunk
        : {
            ...hunk,
            path: normalizedPath,
            move_path: normalizedMovePath,
          },
    );
  }

  return { hunks: normalized, changed };
}

async function guardPatchTargets(
  root: string,
  worktree: string | undefined,
  targets: string[],
): Promise<number> {
  const guardContext = createPathGuardContext(root, worktree);

  for (const target of targets) {
    await guard(guardContext, target);
  }

  return targets.length;
}

export function parseValidatedPatch(patchText: string): PatchHunk[] {
  let hunks: PatchHunk[];

  try {
    hunks = parsePatch(patchText).hunks;
  } catch (error) {
    throw new ApplyPatchError('validation', getErrorMessage(error));
  }

  if (hunks.length === 0) {
    const clean = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (clean === '*** Begin Patch\n*** End Patch') {
      throw new ApplyPatchError('validation', 'empty patch');
    }

    throw new ApplyPatchError('validation', 'no hunks found');
  }

  return hunks;
}

async function readPreparedFileText(
  filePath: string,
  verb: 'update' | 'delete',
): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new ApplyPatchError(
        'verification',
        `Failed to read file to ${verb}: ${filePath}`,
      );
    }

    throw new ApplyPatchError(
      'internal',
      `Failed to read file for patch verification: ${filePath}`,
      error,
    );
  }
}

async function createPatchExecutionContext(
  root: string,
  patchText: string,
  worktree?: string,
): Promise<PatchExecutionContext> {
  const parsedHunks = parseValidatedPatch(patchText);
  await guardPatchTargets(
    root,
    worktree,
    collectPatchTargets(root, parsedHunks),
  );
  const normalized = normalizePatchPaths(root, parsedHunks);
  const files = createFileCacheContext();
  const staged = new Map<string, PreparedFileState>();

  async function assertPreparedPathMissing(
    filePath: string,
    verb: 'add' | 'move',
  ): Promise<void> {
    const existing = staged.get(filePath);
    if (existing) {
      if (!existing.exists) {
        return;
      }

      throw new ApplyPatchError(
        'verification',
        verb === 'add'
          ? `Add File target already exists: ${filePath}`
          : `Move destination already exists: ${filePath}`,
      );
    }

    const stat = await statCached(files, filePath);
    if (!stat) {
      return;
    }

    throw new ApplyPatchError(
      'verification',
      verb === 'add'
        ? `Add File target already exists: ${filePath}`
        : `Move destination already exists: ${filePath}`,
    );
  }

  async function getPreparedFileState(
    filePath: string,
    verb: 'update' | 'delete',
  ): Promise<ExistingFileState> {
    const existing = staged.get(filePath);
    if (existing) {
      if (!existing.exists) {
        throw new ApplyPatchError(
          'verification',
          `Failed to read file to ${verb}: ${filePath}`,
        );
      }

      return existing;
    }

    await assertRegularFile(files, filePath, verb);
    const stat = await statCached(files, filePath);
    const text = await readPreparedFileText(filePath, verb);
    const state: PreparedFileState = {
      exists: true,
      text,
      mode: stat ? stat.mode & 0o7777 : undefined,
      derived: false,
    };
    staged.set(filePath, state);
    return state;
  }

  return {
    hunks: normalized.hunks,
    pathsNormalized: normalized.changed,
    staged,
    getPreparedFileState,
    assertPreparedPathMissing,
  };
}

export async function simulatePatch(
  root: string,
  patchText: string,
  worktree?: string,
): Promise<{
  hunks: PatchHunk[];
  pathsNormalized: boolean;
  steps: SimulatedStep[];
}> {
  const {
    hunks,
    pathsNormalized,
    staged,
    getPreparedFileState,
    assertPreparedPathMissing,
  } = await createPatchExecutionContext(root, patchText, worktree);
  const steps: SimulatedStep[] = [];

  for (const hunk of hunks) {
    const filePath = path.resolve(root, hunk.path);

    if (hunk.type === 'add') {
      await assertPreparedPathMissing(filePath, 'add');
      const finalText = stageAddedText(hunk.contents);
      steps.push({ type: 'add', hunk, filePath, finalText });
      staged.set(filePath, { exists: true, text: finalText, derived: true });
      continue;
    }

    if (hunk.type === 'delete') {
      await getPreparedFileState(filePath, 'delete');
      steps.push({ type: 'delete', hunk, filePath });
      staged.set(filePath, { exists: false, derived: true });
      continue;
    }

    const current = await getPreparedFileState(filePath, 'update');
    const movePath = hunk.move_path
      ? path.resolve(root, hunk.move_path)
      : undefined;
    if (movePath && movePath !== filePath) {
      await assertPreparedPathMissing(movePath, 'move');
    }

    const { resolved, nextText } = resolvePreparedUpdate(
      filePath,
      current.text,
      hunk,
    );
    steps.push({
      type: 'update',
      hunk,
      filePath,
      movePath,
      current,
      resolved,
      nextText,
    });

    if (movePath && movePath !== filePath) {
      staged.set(filePath, { exists: false, derived: true });
      staged.set(movePath, {
        exists: true,
        text: nextText,
        mode: current.mode,
        derived: true,
      });
    } else {
      staged.set(filePath, {
        exists: true,
        text: nextText,
        mode: current.mode,
        derived: true,
      });
    }
  }

  return { hunks, pathsNormalized, steps };
}

export function resolvePreparedUpdate(
  filePath: string,
  currentText: string,
  hunk: UpdatePatchHunk,
): ResolvedPreparedUpdate {
  try {
    const { lines, resolved, eol, hasFinalNewline } =
      resolveUpdateChunksFromText(filePath, currentText, hunk.chunks);

    return {
      resolved,
      nextText: applyHits(
        lines,
        resolved.map((chunk) => chunk.hit),
        eol,
        hasFinalNewline,
      ),
    };
  } catch (error) {
    throw new ApplyPatchError('verification', getErrorMessage(error), error);
  }
}

export function stageAddedText(contents: string): string {
  return contents.length === 0 || contents.endsWith('\n')
    ? contents
    : `${contents}\n`;
}
