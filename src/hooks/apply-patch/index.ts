import type { PluginInput } from '@opencode-ai/plugin';

import { log } from '../../utils/logger';
import { ApplyPatchError, isApplyPatchError } from './errors';
import { rewritePatch } from './rewrite';
import type { ApplyPatchRuntimeOptions } from './types';

const APPLY_PATCH_RESCUE_OPTIONS: ApplyPatchRuntimeOptions = {
  prefixSuffix: true,
  lcsRescue: true,
};

interface ToolExecuteBeforeInput {
  tool: string;
  directory?: string;
}

interface ToolExecuteBeforeOutput {
  args?: {
    patchText?: unknown;
    [key: string]: unknown;
  };
}

function replacePatchArgs(
  output: ToolExecuteBeforeOutput,
  args: NonNullable<ToolExecuteBeforeOutput['args']>,
  patchText: string,
): boolean {
  const nextArgs = { ...args, patchText };

  try {
    output.args = nextArgs;
  } catch {
    return false;
  }

  return output.args?.patchText === patchText;
}

export function createApplyPatchHook(ctx: PluginInput) {
  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (input.tool !== 'apply_patch') {
        return;
      }

      const args = output.args;
      if (!args || typeof args.patchText !== 'string') {
        return;
      }
      const patchText = args.patchText;

      const root = input.directory || ctx.directory || process.cwd();
      const worktree = ctx.worktree || root;
      try {
        const result = await rewritePatch(
          root,
          patchText,
          APPLY_PATCH_RESCUE_OPTIONS,
          worktree,
        );

        if (result.changed) {
          if (replacePatchArgs(output, args, result.patchText)) {
            log('apply-patch hook rewrite');
          } else {
            log('apply-patch hook skipped', {
              reason: 'readonly output args',
              failOpen: true,
              rescueOptions: APPLY_PATCH_RESCUE_OPTIONS,
              rewriteStage: 'before-native',
            });
          }
          return;
        }

        log('apply-patch hook unchanged');
        return;
      } catch (error) {
        const normalizedError = isApplyPatchError(error)
          ? error
          : new ApplyPatchError(
              'internal',
              `Unexpected hook failure before native apply: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );

        if (
          normalizedError.kind === 'blocked' &&
          // Only the plugin-side outside-workspace preflight should fail open.
          // Keep the code check explicit so any future blocked error remains
          // fail-closed by default.
          normalizedError.code === 'outside_workspace'
        ) {
          log('apply-patch hook skipped', {
            kind: normalizedError.kind,
            code: normalizedError.code,
            reason: normalizedError.message,
            failOpen: true,
            rescueOptions: APPLY_PATCH_RESCUE_OPTIONS,
            rewriteStage: 'before-native',
          });
          return;
        }

        log(`apply-patch hook ${normalizedError.kind}`, {
          kind: normalizedError.kind,
          code: normalizedError.code,
          reason: normalizedError.message,
          failOpen: false,
          rescueOptions: APPLY_PATCH_RESCUE_OPTIONS,
          rewriteStage: 'before-native',
        });
        throw normalizedError;
      }
    },
  };
}
