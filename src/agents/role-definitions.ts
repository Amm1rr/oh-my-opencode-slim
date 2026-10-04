import {
  type SpecialistRole,
  SUPPORTED_SPECIALIST_ROLES,
} from '../config/agent-roles';
import type { AgentDefinition } from './orchestrator';
import {
  type AgentPermission,
  createReadOnlyAgentPermission,
} from './permissions';
import {
  DESIGNER_PROMPT,
  EXPLORER_PROMPT,
  FIXER_PROMPT,
  LIBRARIAN_PROMPT,
  OBSERVER_PROMPT,
  ORACLE_PROMPT,
} from './role-prompts';

export interface SpecialistRoleDefinition {
  readonly id: SpecialistRole;
  readonly prompt: string;
  readonly description: string;
}

export const SPECIALIST_ROLES = SUPPORTED_SPECIALIST_ROLES;
export type { SpecialistRole };

export const ROLE_DEFINITIONS: Readonly<
  Record<SpecialistRole, SpecialistRoleDefinition>
> = Object.freeze({
  explorer: Object.freeze({
    id: 'explorer',
    prompt: EXPLORER_PROMPT,
    description:
      "Fast codebase search and pattern matching. Use for finding files, locating code patterns, and answering 'where is X?' questions.",
  }),
  librarian: Object.freeze({
    id: 'librarian',
    prompt: LIBRARIAN_PROMPT,
    description:
      'External documentation and library research. Use for official docs lookup, GitHub examples, and understanding library internals.',
  }),
  oracle: Object.freeze({
    id: 'oracle',
    prompt: ORACLE_PROMPT,
    description:
      'Strategic technical advisor. Use for architecture decisions, complex debugging, code review, simplification, and engineering guidance.',
  }),
  designer: Object.freeze({
    id: 'designer',
    prompt: DESIGNER_PROMPT,
    description:
      'UI/UX design, review, and implementation. Use for styling, responsive design, component architecture and visual polish.',
  }),
  fixer: Object.freeze({
    id: 'fixer',
    prompt: FIXER_PROMPT,
    description:
      'Fast implementation specialist. Receives complete context and task spec, executes code changes efficiently.',
  }),
  observer: Object.freeze({
    id: 'observer',
    prompt: OBSERVER_PROMPT,
    description:
      'Visual analysis. Use for interpreting images, screenshots, PDFs, and diagrams - extracts structured observations without loading raw files into main context. Requires a vision-capable model.',
  }),
});

/** Roles whose contract is read-only: they inspect and advise, never mutate.
 * The matrix is built into the definition so the read-only boundary holds
 * with zero configuration; an explicit agents.<name>.permission in the
 * plugin config still replaces it (existing ?? semantics). MCP keys are
 * deliberately NOT baked here: the registry derives every <mcp>_* rule
 * from the effective agent mcps list (user-narrowable), and a baked allow
 * would defeat that narrowing because the registry fill only writes
 * absent keys. */
export const READ_ONLY_ROLE_IDS: ReadonlySet<SpecialistRole> = new Set([
  'explorer',
  'librarian',
  'oracle',
  'observer',
]);

function createRolePermission(
  role: SpecialistRole,
): AgentPermission | undefined {
  if (!READ_ONLY_ROLE_IDS.has(role)) return undefined;
  return {
    ...createReadOnlyAgentPermission(),
    // The blanket read allow must re-state the host's env-file safeguards
    // AFTER itself: rules evaluate last-match-wins, so a bare read: allow
    // would silently shadow the .env ask defaults and let the advisory
    // roles read secrets without a prompt.
    read: {
      '*': 'allow',
      '*.env': 'ask',
      '*.env.*': 'ask',
      '*.env.example': 'allow',
    },
    webfetch: 'allow',
    websearch: 'allow',
  };
}

export function createRoleAgent(
  role: SpecialistRoleDefinition,
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const prompt = customPrompt
    ? customPrompt
    : customAppendPrompt
      ? `${role.prompt}\n\n${customAppendPrompt}`
      : role.prompt;
  const permission = createRolePermission(role.id);

  return {
    name: role.id,
    description: role.description,
    config: permission ? { model, prompt, permission } : { model, prompt },
  };
}
