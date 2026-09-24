# src/hooks/apply-patch/

## Purpose

Preflights `apply_patch` calls before OpenCode's native tool runs. It validates the patch, guards target paths, simulates hunks against in-memory file state, and rewrites patches when paths or matched content need canonicalization. The hook does not apply or roll back changes on disk.

## Entry point and contract

- `index.ts` exports `createApplyPatchHook(ctx)` for `tool.execute.before`. Only calls with `input.tool === 'apply_patch'` and a string `output.args.patchText` are processed.
- The root is `input.directory || ctx.directory || process.cwd()`; the worktree is `ctx.worktree || root`.
- An unchanged patch keeps the original args and bytes. A rewrite assigns a **new** args object; if the assignment is read-only, the hook skips without throwing.
- Only an outside-workspace `blocked` error fails open, passing the original patch to the native tool. Validation, verification, and internal errors leave args intact and throw. `errors.ts` supplies `ApplyPatchError` with stable `kind`, `code`, message, and optional cause.

## Pipeline

1. `codec.ts` normalizes heredocs/line endings and **strictly** parses `*** Begin Patch`/`*** End Patch` with Add, Delete, Update, and optional Move hunks. `formatPatch()` renders canonical patches; update chunks render in linear time using their common prefix/suffix and replacement blocks.
2. `execution-context.ts` parses, resolves and guards all target paths (including move destinations), and simulates add/delete/update hunks in their original order. `simulatePatch()` returns normalized hunks, a paths-normalized flag, and sequential steps; its staged state allows same-file and add/move dependencies without writing files.
3. `resolution.ts` uses `resolveUpdate(file, text, chunks)` to produce resolved canonical chunks and the next text, preserving CRLF and final-newline state. Empty old-line insertions require a unique anchor except at explicit EOF. `applyHits()` computes the result from source lines and accepted hits.
4. `matching.ts` searches globally by comparator level: exact → unicode → trim-end → unicode-trim-end → trim → unicode-trim. EOF matches are tried at the end first, then from the start offset. Prefix/suffix rescue searches both edges in one pass using unicode-trim-end, **not** full-trim; ambiguous locations fail. LCS rescue is limited to 48 old lines and 64 candidates, needs at least 70% overlap (minimum two lines), requires both borders and rejects tied best matches. LCS borders retain the full comparator chain.
5. `rewrite.ts` walks simulated steps in order. It canonicalizes tolerant matches and absolute paths, merges overlapping canonical ranges, and folds dependent same-file/add/move updates only when no intervening hunk touches their paths. Fallback chunks must reproduce the simulated content before being emitted. Only rewritten patches are serialized; byte-identical input stays byte-identical.

## Safety and configuration

- The hook has no `ApplyPatchRuntimeOptions`: prefix/suffix and LCS rescue are always enabled. There is no prepared-changes/rollback engine or disk-applying operation in production; the test helper applies simulated steps with plain filesystem calls.
- The preflight checks paths against the real root and worktree before reading. Nonexistent or ambiguous targets and overlapping chunks fail verification rather than guessing. All changes to files are left to the native `apply_patch` tool.
- The only external dependency of the hook beyond OpenCode's plugin context is the shared structured logger (`src/utils/logger.ts`).

## Verification

Run `bun test src/hooks/apply-patch src/cache-safety-tripwire.test.ts`, `bun run typecheck`, and `bunx biome check src/hooks/apply-patch src/cache-safety-tripwire.test.ts`. The tripwire also guards against stale allowlist entries when files are removed.
