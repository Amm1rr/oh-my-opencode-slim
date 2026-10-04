export type AgentPermission = Record<
  string,
  'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>
>;

/** Permission keys that accept only a scalar action — never a pattern map.
 * Mirrors opencode's v1 permission config typing; enforced by the config
 * schema's refinement. */
export const STRING_ONLY_PERMISSION_KEYS = [
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'codesearch',
  'doom_loop',
] as const;

/**
 * Strict read-only tool permissions for advisory agents.
 *
 * Start with wildcard deny so newly-added tools are unavailable by default,
 * then allow only inspection/search tools. Explicitly deny known mutating and
 * delegation tools to make the read-only boundary obvious in generated config.
 */
export function createReadOnlyAgentPermission(): AgentPermission {
  return {
    '*': 'deny',
    bash: 'deny',
    edit: 'deny',
    write: 'deny',
    apply_patch: 'deny',
    ast_grep_replace: 'deny',
    task: 'deny',
    question: 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    lsp: 'allow',
    list: 'allow',
    codesearch: 'allow',
    ast_grep_search: 'allow',
  } as AgentPermission;
}

/**
 * Strict deny-all permissions for the council synthesis agent.
 *
 * The council agent is text-in/text-out only — it must NOT use any
 * file-inspection tools. Councillors already perform codebase exploration;
 * the council only reconciles their text output.
 */
export function createSynthesisOnlyPermission(): AgentPermission {
  return {
    '*': 'deny',
    bash: 'deny',
    edit: 'deny',
    write: 'deny',
    apply_patch: 'deny',
    ast_grep_replace: 'deny',
    task: 'deny',
    question: 'deny',
    read: 'deny',
    glob: 'deny',
    grep: 'deny',
    lsp: 'deny',
    list: 'deny',
    codesearch: 'deny',
    ast_grep_search: 'deny',
  } as AgentPermission;
}
