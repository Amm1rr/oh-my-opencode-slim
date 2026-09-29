import { describe, expect, test } from 'bun:test';
import { installV1FallbackAgentAliases } from './v1-fallback-agent-aliases';

describe('installV1FallbackAgentAliases', () => {
  test('preserves a configured agent that occupies the generated alias', () => {
    const occupiedAlias = 'slim-internal-fallback-operator-1';
    const configured = { model: 'user/configured', prompt: 'keep me' };
    const agents: Record<string, unknown> = {
      operator: { model: 'provider/primary', prompt: 'operate' },
      [occupiedAlias]: configured,
    };

    const aliases = installV1FallbackAgentAliases(agents, {
      operator: [{ id: 'provider/primary' }, { id: 'provider/fallback' }],
    });

    expect(agents[occupiedAlias]).toBe(configured);
    const generated = aliases.get('operator\0provider/fallback');
    expect(generated).toBe(`${occupiedAlias}-2`);
    expect(agents[generated as string]).toMatchObject({
      name: 'operator',
      model: 'provider/fallback',
      hidden: true,
    });
  });

  test('allocates distinct aliases when source names sanitize identically', () => {
    const agents: Record<string, unknown> = {
      'reviewer/fast': { model: 'provider/primary-a' },
      'reviewer?fast': { model: 'provider/primary-b' },
    };

    const aliases = installV1FallbackAgentAliases(agents, {
      'reviewer/fast': [
        { id: 'provider/primary-a' },
        { id: 'provider/fallback-a' },
      ],
      'reviewer?fast': [
        { id: 'provider/primary-b' },
        { id: 'provider/fallback-b' },
      ],
    });

    const first = aliases.get('reviewer/fast\0provider/fallback-a');
    const second = aliases.get('reviewer?fast\0provider/fallback-b');
    expect(first).toBe('slim-internal-fallback-reviewer_fast-1');
    expect(second).toBe('slim-internal-fallback-reviewer_fast-1-2');
    expect(second).not.toBe(first);
    expect(agents[first as string]).toMatchObject({
      name: 'reviewer/fast',
      model: 'provider/fallback-a',
    });
    expect(agents[second as string]).toMatchObject({
      name: 'reviewer?fast',
      model: 'provider/fallback-b',
    });
  });

  test('reuses its generated aliases across repeated config projections', () => {
    const agents: Record<string, unknown> = {
      operator: { model: 'provider/primary' },
    };
    const chains = {
      operator: [{ id: 'provider/primary' }, { id: 'provider/fallback' }],
    };

    const first = installV1FallbackAgentAliases(agents, chains);
    const second = installV1FallbackAgentAliases(agents, chains);

    expect(second).toEqual(first);
    expect(
      Object.keys(agents).filter((name) =>
        name.startsWith('slim-internal-fallback-'),
      ),
    ).toEqual(['slim-internal-fallback-operator-1']);
  });
});
