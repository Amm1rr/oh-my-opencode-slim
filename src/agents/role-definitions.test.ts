import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createObserverAgent } from './observer';
import { createOracleAgent } from './oracle';
import { buildOrchestratorPrompt } from './orchestrator';
import {
  READ_ONLY_ROLE_IDS,
  ROLE_DEFINITIONS,
  SPECIALIST_ROLES,
} from './role-definitions';
import { ROLE_ROUTING_BLOCKS } from './role-routing';

const FACTORIES = {
  explorer: createExplorerAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
  observer: createObserverAgent,
} as const;

// Writers: every SUPPORTED_SPECIALIST_ROLES member not in READ_ONLY_ROLE_IDS
// must be listed here — the completeness test below fails when a new role
// ships without a class.
const WRITER_ROLE_IDS = ['designer', 'fixer'] as const;

describe('specialist role definitions', () => {
  test('enforces the read-only tool matrix on read-only roles only', () => {
    for (const role of READ_ONLY_ROLE_IDS) {
      const agent = FACTORIES[role]('test/model');
      const permission = agent.config.permission as Record<string, unknown>;
      expect(permission).toBeDefined();
      expect(permission['*']).toBe('deny');
      expect(permission.edit).toBe('deny');
      expect(permission.write).toBe('deny');
      expect(permission.bash).toBe('deny');
      expect(permission.apply_patch).toBe('deny');
      expect(permission.ast_grep_replace).toBe('deny');
      // The blanket read allow re-states the host's env-file safeguards after
      // itself — a bare allow would shadow the .env ask defaults.
      expect(permission.read).toEqual({
        '*': 'allow',
        '*.env': 'ask',
        '*.env.*': 'ask',
        '*.env.example': 'allow',
      });
      expect(permission.glob).toBe('allow');
      expect(permission.grep).toBe('allow');
      expect(permission.ast_grep_search).toBe('allow');
      expect(permission.webfetch).toBe('allow');
      expect(permission.websearch).toBe('allow');
      // Order pin: opencode evaluates the compiled rules last-match-wins,
      // so the wildcard base must precede every allow — the original bug
      // moved it behind them and denied the whole read class.
      const keys = Object.keys(permission);
      expect(keys.indexOf('*')).toBeLessThan(keys.indexOf('read'));
      // The registry derives every <mcp>_* rule from the effective agent
      // mcps list and only fills ABSENT keys, so a baked MCP allow here
      // would defeat user mcps narrowing. The matrix must carry none.
      for (const key of keys) {
        expect(key.endsWith('_*')).toBe(false);
      }
    }
    for (const role of WRITER_ROLE_IDS) {
      const agent = FACTORIES[role]('test/model');
      expect(agent.config.permission).toBeUndefined();
    }
  });

  test('every specialist role is classified read-only or writer', () => {
    // Completeness: a new role must join one class explicitly — shipping
    // mapless by omission is what this pins against.
    const classified = new Set<string>([
      ...READ_ONLY_ROLE_IDS,
      ...WRITER_ROLE_IDS,
    ]);
    for (const role of SPECIALIST_ROLES) {
      expect(classified.has(role)).toBe(true);
    }
    expect(classified.size).toBe(SPECIALIST_ROLES.length);
  });

  test('read-only roles may only declare read-only MCP dependencies', () => {
    // The registry fill derives every <mcp>_* allow from DEFAULT_AGENT_MCPS
    // (through the effective agent mcps list), which makes the declaration
    // a security-relevant edit point: a write-capable MCP declared here
    // would be silently allowed through the read-only boundary. Pin the
    // known read-only set.
    const READ_ONLY_MCP_ALLOWLIST = new Set(['context7', 'gh_grep']);
    for (const role of READ_ONLY_ROLE_IDS) {
      for (const mcp of DEFAULT_AGENT_MCPS[role] ?? []) {
        expect(READ_ONLY_MCP_ALLOWLIST.has(mcp)).toBe(true);
      }
    }
  });

  test('matches golden factory prompts and descriptions', () => {
    const outputs = SPECIALIST_ROLES.map((role) => {
      const agent = FACTORIES[role]('test/model');
      return {
        name: agent.name,
        description: agent.description,
        promptSha256: createHash('sha256')
          .update(agent.config.prompt)
          .digest('hex'),
      };
    });

    expect(outputs).toMatchSnapshot();
  });

  test('preserve baseline factory definitions', () => {
    expect(Object.keys(ROLE_DEFINITIONS)).toEqual([...SPECIALIST_ROLES]);

    for (const role of SPECIALIST_ROLES) {
      const definition = ROLE_DEFINITIONS[role];
      const agent = FACTORIES[role]('test/model');
      expect(agent.name).toBe(role);
      expect(agent.description).toBe(definition.description);
      expect(agent.config.model).toBe('test/model');
      expect(agent.config.prompt).toBe(definition.prompt);
    }
  });

  test('preserves custom prompt precedence and append behavior', () => {
    const base = ROLE_DEFINITIONS.explorer.prompt;
    expect(createExplorerAgent('m', 'custom', 'append').config.prompt).toBe(
      'custom',
    );
    expect(createExplorerAgent('m', undefined, 'append').config.prompt).toBe(
      `${base}\n\nappend`,
    );
  });

  test('keeps routing blocks available for specialists and council', () => {
    const prompt = buildOrchestratorPrompt();
    for (const role of SPECIALIST_ROLES) {
      expect(prompt).toContain(ROLE_ROUTING_BLOCKS[role]);
    }
    expect(prompt).toContain(ROLE_ROUTING_BLOCKS.council);
    expect(buildOrchestratorPrompt(new Set(['explorer']))).not.toContain(
      ROLE_ROUTING_BLOCKS.explorer,
    );
  });
  test('keeps behavioral steering while fixing local prompt inconsistencies', () => {
    const designerPrompt = ROLE_DEFINITIONS.designer.prompt;

    expect(designerPrompt).toContain(
      'Prioritize visual excellence-code perfection comes second',
    );
    expect(designerPrompt).toContain('requested product language');
    expect(designerPrompt).not.toContain('regular english');

    expect(ROLE_ROUTING_BLOCKS.council).toContain(
      'Permissions: Synthesis only; no tools',
    );
    expect(ROLE_ROUTING_BLOCKS.council).toContain(
      'Stats: 3x slower than orchestrator',
    );
    expect(ROLE_ROUTING_BLOCKS.oracle).toContain(
      'materially reduces risk or uncertainty',
    );
  });
});
