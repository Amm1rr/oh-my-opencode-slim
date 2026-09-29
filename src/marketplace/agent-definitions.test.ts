import { describe, expect, test } from 'bun:test';
import { ROLE_DEFINITIONS } from '../agents/role-definitions.js';
import type { MarketplaceActivationAdmission } from './activation.js';
import {
  createMarketplaceAgentDefinitions,
  MarketplaceAgentConstructionError,
} from './agent-definitions.js';
import {
  type MarketplacePackageManifest,
  MarketplacePackageManifestSchema,
} from './schemas.js';

function admission(
  id: string,
  overrides: Record<string, unknown> = {},
): MarketplaceActivationAdmission {
  const manifest = MarketplacePackageManifestSchema.parse({
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: 'Package Agent',
    description: 'Package description',
    agentName: 'package-agent',
    prompt: 'Package prompt',
    skills: ['skill-a'],
    mcps: ['mcp-a'],
    tools: ['read'],
    author: { name: 'Author' },
    tags: [],
    license: 'MIT',
    compatibility: { plugin: '>=1.0.0' },
    model: { source: 'explicit', candidates: ['provider/one'] },
    routing: {
      description: 'Use when needed',
      when: 'Inspect code',
      keywords: ['inspect'],
    },
    ...overrides,
  }) as MarketplacePackageManifest;
  return {
    packageId: id,
    agentName: manifest.agentName,
    version: manifest.version,
    digest: 'a'.repeat(64),
    manifest,
    requiredSkills: manifest.skills,
    requiredMcps: manifest.mcps,
  };
}

function build(...admissions: MarketplaceActivationAdmission[]) {
  return createMarketplaceAgentDefinitions({
    agents: admissions,
    diagnostics: [],
  });
}

describe('createMarketplaceAgentDefinitions', () => {
  test('builds direct package definitions with their own prompt and explicit ceilings', () => {
    const result = build(admission('team/direct'));
    expect(result.agents[0]).toMatchObject({
      name: 'package-agent',
      description: 'Package description',
      config: {
        prompt: 'Package prompt',
        tools: { read: true },
      },
      _modelArray: [{ id: 'provider/one' }],
    });
    expect(result.metadata[0]?.capabilities).toEqual({
      tools: ['read'],
      skills: ['skill-a'],
      mcps: ['mcp-a'],
    });
  });

  test('sets the first explicit candidate model and variant without dropping fallback variants', () => {
    const result = build(
      admission('team/model-chain', {
        model: {
          source: 'explicit',
          candidates: [
            { id: 'provider/one', variant: 'startup' },
            { id: 'provider/two', variant: 'fallback' },
          ],
        },
      }),
    );
    expect(result.agents[0]?.config).toMatchObject({
      model: 'provider/one',
      variant: 'startup',
    });
    expect(result.agents[0]?._modelArray).toEqual([
      { id: 'provider/one', variant: 'startup' },
      { id: 'provider/two', variant: 'fallback' },
    ]);
  });

  test('read-only role extensions inherit builtin tools and MCP defaults', () => {
    const explorer = admission('team/explorer', {
      extends: { builtin: 'explorer', promptMode: 'append' },
      model: { source: 'builtin' },
      tools: [],
      skills: [],
      mcps: [],
    });
    const librarian = admission('team/librarian', {
      agentName: 'library-agent',
      extends: { builtin: 'librarian', promptMode: 'append' },
      model: { source: 'builtin' },
      tools: [],
      skills: [],
      mcps: [],
    });
    const result = build(explorer, librarian);
    expect(result.metadata[0]?.capabilities).toEqual({
      tools: ['read', 'glob', 'grep', 'ast_grep_search'],
      skills: [],
      mcps: [],
    });
    expect(result.metadata[1]?.capabilities).toEqual({
      tools: ['read', 'glob', 'grep', 'ast_grep_search'],
      skills: [],
      mcps: ['context7', 'gh_grep'],
    });
    expect(result.agents[0]?.config.tools).toEqual({
      read: true,
      glob: true,
      grep: true,
      ast_grep_search: true,
    });
  });

  test('unions allowed extension capabilities while leaving direct capabilities unchanged', () => {
    const extension = admission('team/extended', {
      extends: { builtin: 'explorer', promptMode: 'append' },
      model: { source: 'builtin' },
      tools: ['websearch'],
      skills: ['extra-skill'],
      mcps: ['extra-mcp'],
    });
    const direct = admission('team/direct-only', {
      agentName: 'direct-only',
      tools: ['websearch'],
      skills: ['direct-skill'],
      mcps: ['direct-mcp'],
    });
    const result = build(extension, direct);
    expect(result.metadata[0]?.capabilities).toEqual({
      tools: ['read', 'glob', 'grep', 'ast_grep_search', 'websearch'],
      skills: ['extra-skill'],
      mcps: ['extra-mcp'],
    });
    expect(result.metadata[1]?.capabilities).toEqual({
      tools: ['websearch'],
      skills: ['direct-skill'],
      mcps: ['direct-mcp'],
    });
  });

  test('V2 replace uses package prompt and never mutates builtin role definitions', () => {
    const originalPrompt = ROLE_DEFINITIONS.explorer.prompt;
    const result = build(
      admission('team/replace', {
        extends: { builtin: 'explorer', promptMode: 'replace' },
        model: { source: 'builtin' },
      }),
    );
    expect(result.agents[0]?.config.prompt).toBe('Package prompt');
    expect(result.agents[0]?.name).toBe('package-agent');
    expect(ROLE_DEFINITIONS.explorer.prompt).toBe(originalPrompt);
  });

  test('V2 append and V3 extension retain factory prompt before package prompt', () => {
    const v2 = admission('team/append-v2', {
      extends: { builtin: 'explorer', promptMode: 'append' },
      model: { source: 'builtin' },
    });
    const v3 = admission('team/append-v3', {
      schemaVersion: 3,
      routing: {
        lane: 'A lane',
        stats: ['Reliable'],
        delegateWhen: ['Inspect'],
        avoid: ['Editing'],
      },
      extends: { builtin: 'observer', promptMode: 'append' },
      model: { source: 'orchestrator' },
    });
    const [v2Agent, v3Agent] = build(v2, v3).agents;
    expect(v2Agent?.config.prompt).toBe(
      `${ROLE_DEFINITIONS.explorer.prompt}\n\nPackage prompt`,
    );
    expect(v3Agent?.config.prompt).toBe(
      `${ROLE_DEFINITIONS.observer.prompt}\n\nPackage prompt`,
    );
    expect(v2Agent?.config.model).toBeUndefined();
    expect(v3Agent?.config.model).toBeUndefined();
  });

  test('preserves every model policy source and candidate variants', () => {
    const policies = [
      { source: 'session' },
      { source: 'orchestrator' },
      {
        source: 'explicit',
        candidates: [{ id: 'provider/one', variant: 'fast' }, 'provider/two'],
      },
      { source: 'builtin' },
    ] as const;
    const admissions = policies.map((model, index) =>
      admission(`team/model-${index}`, {
        ...(model.source === 'builtin'
          ? { extends: { builtin: 'explorer', promptMode: 'append' } }
          : {}),
        model,
        agentName: `agent-${index}`,
      }),
    );
    const result = build(...admissions);
    expect(result.metadata.map(({ modelPolicy }) => modelPolicy)).toEqual(
      policies,
    );
    expect(result.agents[2]?._modelArray).toEqual([
      { id: 'provider/one', variant: 'fast' },
      { id: 'provider/two' },
    ]);
  });

  test('produces stable routing metadata for package ordering and runtime names', () => {
    const first = admission('team/one', { agentName: 'alpha-agent' });
    const second = admission('team/two', {
      agentName: 'beta-agent',
      extends: { builtin: 'explorer', promptMode: 'append' },
      model: { source: 'builtin' },
    });
    const forward = build(first, second).metadata;
    const reverse = build(second, first).metadata;
    expect(forward[0]?.routingInput.block).toBe(
      '@alpha-agent\n- Lane: Package description\n\n- Lane: Use when needed\n- **Delegate when:** Inspect code',
    );
    expect(forward[1]?.routingInput.block).toContain('@beta-agent');
    expect(forward[0]?.routingInput).toEqual(reverse[1]?.routingInput);
    expect(forward[1]?.routingInput).toEqual(reverse[0]?.routingInput);
  });

  test('rejects diagnostic plans and unrepresentable read-only permissions', () => {
    expect(() =>
      createMarketplaceAgentDefinitions({
        agents: [admission('team/bad')],
        diagnostics: [
          { packageId: 'team/bad', code: 'invalid-capability', message: 'bad' },
        ],
      }),
    ).toThrow(MarketplaceAgentConstructionError);
    expect(() =>
      build(
        admission('team/write-explorer', {
          extends: { builtin: 'explorer', promptMode: 'append' },
          tools: ['write'],
        }),
      ),
    ).toThrow('read-only builtin explorer');
  });
});
