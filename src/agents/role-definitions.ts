import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
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

/** Enforced tool matrix for read-only roles: the same strict base the
 * councillor seats use (wildcard deny + inspection allows), plus the web
 * research tools — web reads are read-only operations, and the research
 * roles legitimately consult external docs. This enforces the read-only
 * contract with permissions, not just prompt guidance. Writers keep the
 * host default, tightened at assembly by the orchestrator-default denies. */
const READ_ONLY_ROLE_IDS: ReadonlySet<SpecialistRole> = new Set([
  'explorer',
  'librarian',
  'oracle',
  'observer',
]);

function createRolePermission(
  role: SpecialistRole,
): AgentPermission | undefined {
  if (!READ_ONLY_ROLE_IDS.has(role)) return undefined;
  const permission: AgentPermission = {
    ...createReadOnlyAgentPermission(),
    webfetch: 'allow',
    websearch: 'allow',
  };
  // The class map must allow the role's own declared default MCP
  // dependencies: marketplace packages extending the builtin project their
  // inherited MCP grants through this map's ceiling (permissionEffect), so
  // denying them here would cut the extension's required tools.
  for (const mcp of DEFAULT_AGENT_MCPS[role] ?? []) {
    permission[`${mcp.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`] = 'allow';
  }
  return permission;
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
