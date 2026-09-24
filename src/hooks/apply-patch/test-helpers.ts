import { afterEach } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simulatePatch } from './execution-context';
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
  const { steps } = await simulatePatch(root, patchText);
  for (const step of steps) {
    if (step.type === 'delete') {
      await unlink(step.filePath);
    } else if (step.type === 'add') {
      await mkdir(path.dirname(step.filePath), { recursive: true });
      await writeFile(step.filePath, step.finalText);
    } else {
      const target = step.movePath ?? step.filePath;
      if (target !== step.filePath) {
        await mkdir(path.dirname(target), { recursive: true });
        await rename(step.filePath, target);
      }
      await writeFile(target, step.nextText);
    }
  }
}

export async function rewritePatchText(
  root: string,
  patchText: string,
  worktree?: string,
): Promise<string> {
  return (await rewritePatch(root, patchText, worktree)).patchText;
}
