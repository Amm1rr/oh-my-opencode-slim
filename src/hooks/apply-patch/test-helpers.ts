import { afterEach } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyPreparedChanges, preparePatchChanges } from './prepared-changes';
import { rewritePatch } from './rewrite';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

export async function createTempDir(prefix = 'apply-patch-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function writeFixture(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf-8');
}

export async function readText(
  root: string,
  relativePath: string,
): Promise<string> {
  return await readFile(path.join(root, relativePath), 'utf-8');
}

export async function applyPatch(
  root: string,
  patchText: string,
): Promise<void> {
  const changes = await preparePatchChanges(root, patchText);
  await applyPreparedChanges(changes);
}

export async function rewritePatchText(
  root: string,
  patchText: string,
  worktree?: string,
): Promise<string> {
  return (await rewritePatch(root, patchText, worktree)).patchText;
}
