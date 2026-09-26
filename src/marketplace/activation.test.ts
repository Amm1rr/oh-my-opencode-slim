import { describe, expect, test } from 'bun:test';
import {
  type MarketplaceActivationStore,
  type MarketplaceSelectedPackageLoad,
  resolveMarketplaceActivation,
} from './activation.js';
import {
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
} from './errors.js';
import type { MarketplacePackageManifest } from './schemas.js';
import type { StoredMarketplacePackage } from './store.js';

const PLUGIN_VERSION = '3.2.0';

function manifest(
  id: string,
  agentName: string,
  patch: Record<string, unknown> = {},
): MarketplacePackageManifest {
  return {
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: agentName,
    description: 'Test package description',
    agentName,
    prompt: 'A complete test prompt.',
    skills: [],
    mcps: [],
    tools: [],
    author: { name: 'Test author' },
    tags: [],
    license: 'MIT',
    compatibility: { plugin: '*' },
    model: { source: 'session' },
    routing: { description: 'Testing', when: 'Testing', keywords: [] },
    ...patch,
  } as MarketplacePackageManifest;
}

function stored(
  id: string,
  agentName: string,
  patch: Record<string, unknown> = {},
): StoredMarketplacePackage {
  return {
    manifest: manifest(id, agentName, patch),
    source: { type: 'registry', registry: 'https://marketplace.test' },
    digest: 'a'.repeat(64),
    path: `/store/${id}`,
  } as StoredMarketplacePackage;
}

function fixture(
  selectedPackageIds: readonly string[],
  packages: readonly StoredMarketplacePackage[] = [],
  errors: ReadonlyMap<string, Error> = new Map(),
  options: {
    skills?: readonly string[];
    mcps?: readonly string[];
    reserved?: ReadonlySet<string>;
    disabledSkills?: readonly string[];
    disabledMcps?: readonly string[];
  } = {},
) {
  const calls: string[][] = [];
  const packageMap = new Map(
    packages.map((pkg) => [pkg.path.replace('/store/', ''), pkg]),
  );
  const store: MarketplaceActivationStore = {
    loadSelected(ids): MarketplaceSelectedPackageLoad {
      calls.push([...ids]);
      return { packages: packageMap, errors };
    },
  };
  const result = resolveMarketplaceActivation({
    selectedPackageIds,
    store,
    pluginVersion: PLUGIN_VERSION,
    availableSkillNames: options.skills ?? [],
    availableMcpNames: options.mcps ?? [],
    reservedAgentNames: options.reserved ?? new Set(),
    disabledSkillNames: options.disabledSkills,
    disabledMcpNames: options.disabledMcps,
  });
  return { result, calls };
}

describe('marketplace activation planning', () => {
  test('admits only selected packages, not merely installed packages', () => {
    const { result } = fixture(
      ['team/selected'],
      [
        stored('team/selected', 'selected'),
        stored('team/installed', 'installed'),
      ],
    );
    expect(result.agents.map((agent) => agent.packageId)).toEqual([
      'team/selected',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('normalizes selected IDs and asks the store in canonical deterministic order', () => {
    const { result, calls } = fixture(
      [' Team/Zulu ', 'TEAM/alpha'],
      [stored('team/zulu', 'zulu'), stored('team/alpha', 'alpha')],
    );
    expect(calls).toEqual([['team/alpha', 'team/zulu']]);
    expect(result.agents.map((agent) => agent.packageId)).toEqual([
      'team/alpha',
      'team/zulu',
    ]);
  });

  test('reports malformed and duplicate selected IDs deterministically and atomically', () => {
    const { result } = fixture(
      ['not-valid', 'TEAM/one', 'team/one'],
      [stored('team/one', 'one')],
    );
    expect(result.agents).toEqual([]);
    expect(
      result.diagnostics.map(({ code, packageId }) => [code, packageId]),
    ).toEqual([
      ['invalid-selection', 'not-valid'],
      ['duplicate-selection', 'team/one'],
    ]);
  });

  test('sorts invalid and duplicate-selection diagnostics regardless of input order', () => {
    const selections = [
      'bad-z',
      'team/a',
      'TEAM/a',
      'bad-a',
      'team/b',
      'TEAM/b',
    ];
    const packages = [stored('team/a', 'agent-a'), stored('team/b', 'agent-b')];
    const forward = fixture(selections, packages).result;
    const reverse = fixture([...selections].reverse(), packages).result;
    expect(forward).toEqual(reverse);
    expect(
      forward.diagnostics.map((item) => [item.packageId, item.code]),
    ).toEqual([
      ['bad-a', 'invalid-selection'],
      ['bad-z', 'invalid-selection'],
      ['team/a', 'duplicate-selection'],
      ['team/b', 'duplicate-selection'],
    ]);
  });

  test('preserves per-package store errors and distinguishes missing from corrupt', () => {
    const missing = new MarketplaceIntegrityError(
      'team/missing is not installed',
    );
    const corrupt = new MarketplaceIntegrityError('Digest mismatch');
    const { result } = fixture(
      ['team/corrupt', 'team/missing', 'team/offline'],
      [],
      new Map([
        ['team/missing', missing],
        ['team/corrupt', corrupt],
        ['team/offline', new Error('Store I/O failed')],
      ]),
    );
    expect(result.agents).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'corrupt',
      'missing',
      'operational',
    ]);
    expect(result.diagnostics[0]?.cause).toBe(corrupt);
    expect(result.diagnostics[1]?.cause).toBe(missing);
  });

  test('classifies store-wide load exceptions with package-load error rules', () => {
    const error = new MarketplaceLockfileError(
      'Marketplace lockfile is corrupt',
    );
    const result = resolveMarketplaceActivation({
      selectedPackageIds: ['team/one'],
      store: {
        loadSelected() {
          throw error;
        },
      },
      pluginVersion: PLUGIN_VERSION,
      availableSkillNames: [],
      availableMcpNames: [],
      reservedAgentNames: new Set(),
    });
    expect(result.agents).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        packageId: '(store)',
        code: 'corrupt',
        message: error.message,
        cause: error,
      },
    ]);
  });

  test('rejects manifests with invalid v2/v3 schema, ID mismatch, or duplicate agent identity', () => {
    const invalid = stored('team/invalid', 'bad-name', { schemaVersion: 4 });
    const mismatch = stored('team/mismatch', 'mismatch', {
      id: 'team/different',
    });
    const { result } = fixture(
      ['team/invalid', 'team/mismatch'],
      [invalid, mismatch],
    );
    expect(result.agents).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'invalid-manifest',
      'manifest-id-mismatch',
    ]);
  });

  test('accepts valid v2 replace extensions and v3 append extensions', () => {
    const v2 = stored('team/v2', 'v2', {
      extends: { builtin: 'explorer', promptMode: 'replace' },
      model: { source: 'builtin' },
    });
    const v3 = stored('team/v3', 'v3', {
      schemaVersion: 3,
      routing: {
        lane: 'Testing lane',
        stats: ['Measure outcomes'],
        delegateWhen: ['A test is needed'],
        avoid: ['Unrelated work'],
      },
      extends: { builtin: 'explorer', promptMode: 'append' },
      model: { source: 'builtin' },
    });
    const { result } = fixture(['team/v3', 'team/v2'], [v3, v2]);
    expect(result.diagnostics).toEqual([]);
    expect(result.agents.map((agent) => agent.manifest.schemaVersion)).toEqual([
      2, 3,
    ]);
  });

  test('rejects unavailable or disabled required skills and MCPs', () => {
    const pkg = stored('team/needs', 'needs', {
      skills: ['skill-one', 'skill-disabled'],
      mcps: ['mcp-one', 'mcp-disabled'],
    });
    const { result } = fixture(['team/needs'], [pkg], new Map(), {
      skills: ['skill-one', 'skill-disabled'],
      mcps: ['mcp-one', 'mcp-disabled'],
      disabledSkills: ['skill-disabled'],
      disabledMcps: ['mcp-disabled'],
    });
    expect(result.agents).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('missing-required-dependency');
    expect(result.diagnostics[0]?.message).toContain('skill skill-disabled');
    expect(result.diagnostics[0]?.message).toContain('MCP mcp-disabled');
  });

  test('rejects collisions independent of selection input order', () => {
    const first = stored('team/a', 'shared-name');
    const second = stored('team/b', 'shared-name');
    const forward = fixture(['team/b', 'team/a'], [first, second]).result;
    const reverse = fixture(['team/a', 'team/b'], [first, second]).result;
    expect(forward).toEqual(reverse);
    expect(forward.agents).toEqual([]);
    expect(forward.diagnostics.map((item) => item.code)).toEqual(['collision']);
    expect(forward.diagnostics[0]?.packageId).toBe('team/b');
  });

  test('rejects caller-reserved normalized display and host aliases', () => {
    const { result } = fixture(
      ['team/reserved'],
      [stored('team/reserved', 'host-alias')],
      new Map(),
      {
        reserved: new Set(['host-alias']),
      },
    );
    expect(result.agents).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('collision');
  });

  test('rejects impossible extension capability requests', () => {
    const pkg = stored('team/capability', 'capability', {
      extends: { builtin: 'explorer', promptMode: 'append' },
      tools: ['bash'],
    });
    const { result } = fixture(['team/capability'], [pkg]);
    expect(result.agents).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('invalid-capability');
  });

  test('rejects ambiguous MCP action namespaces before producing any admission', () => {
    const { result } = fixture(
      ['team/ambiguous'],
      [stored('team/ambiguous', 'ambiguous', { mcps: ['foo.bar'] })],
      new Map(),
      { mcps: ['foo.bar', 'foo_bar'] },
    );
    expect(result.agents).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('ambiguous-mcp-namespace');
  });

  test('ignores implicit extension MCP namespaces absent from enabled inventory', () => {
    const { result } = fixture(
      ['team/librarian'],
      [
        stored('team/librarian', 'library-agent', {
          extends: { builtin: 'librarian', promptMode: 'append' },
        }),
      ],
      new Map(),
      { mcps: ['context7_extra'] },
    );

    expect(result.agents.map((agent) => agent.packageId)).toEqual([
      'team/librarian',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('rejects overlapping available implicit extension MCP namespaces', () => {
    const { result } = fixture(
      ['team/librarian'],
      [
        stored('team/librarian', 'library-agent', {
          extends: { builtin: 'librarian', promptMode: 'append' },
        }),
      ],
      new Map(),
      { mcps: ['context7', 'context7_extra'] },
    );

    expect(result.agents).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('ambiguous-mcp-namespace');
    expect(result.diagnostics[0]?.message).toContain(
      'context7 and context7_extra',
    );
  });

  test('returns an empty plan for no selected IDs without reading store data', () => {
    const { result, calls } = fixture([]);
    expect(result).toEqual({ agents: [], diagnostics: [] });
    expect(calls).toEqual([]);
  });
});
