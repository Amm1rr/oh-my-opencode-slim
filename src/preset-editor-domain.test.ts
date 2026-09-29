import { describe, expect, test } from 'bun:test';
import type { PresetInput } from './config';
import {
  applyInheritModelChoice,
  applyModelChoice,
  applyVariantChoice,
  availableAgentNames,
  buildPersistablePreset,
  describeBasePresetCandidate,
  describeBasePresetRow,
  describeOverride,
  describePreset,
  INHERITED_AGENT_PREFIX,
  inheritedAgentNames,
  isPrototypeSensitiveName,
  ownPresetValue,
  PRESET_ACTION,
  parseOptionsInput,
  parseTemperatureInput,
  resolveInheritedAgents,
  unwrapUserChoice,
  validateNewPresetName,
  withAgentOverride,
  withoutAgentOverride,
  wrapUserChoice,
} from './preset-editor-domain';
import { wouldCreatePresetCycle } from './tools/preset-switch';

describe('safe new preset names', () => {
  test('accepts letters, digits, hyphens, and underscores', () => {
    for (const name of ['a', 'Builder-2', 'x_y-z', 'A1']) {
      expect(validateNewPresetName(name)).toBeUndefined();
    }
  });

  test('rejects empty, whitespace, and out-of-pattern names', () => {
    expect(validateNewPresetName('')).toContain('empty');
    expect(validateNewPresetName('with space')).toContain('may only contain');
    expect(validateNewPresetName('dots.here')).toContain('may only contain');
    expect(validateNewPresetName('emoji✨')).toContain('may only contain');
    expect(validateNewPresetName('slash/name')).toContain('may only contain');
  });

  test('rejects reserved manager and prototype-sensitive names', () => {
    expect(validateNewPresetName('__omo_save__')).toContain('reserved');
    expect(validateNewPresetName('__proto__')).toContain('reserved JavaScript');
    expect(validateNewPresetName('constructor')).toContain(
      'reserved JavaScript',
    );
    expect(validateNewPresetName('prototype')).toContain('reserved JavaScript');
    expect(isPrototypeSensitiveName('__proto__')).toBe(true);
    expect(isPrototypeSensitiveName('safe-name')).toBe(false);
  });
});

describe('sentinel-safe user choices', () => {
  test('wraps only manager sentinels and the inherited prefix', () => {
    const wrapped = wrapUserChoice(PRESET_ACTION.SAVE);
    expect(wrapped).toEqual({ user: PRESET_ACTION.SAVE });
    expect(unwrapUserChoice(wrapped)).toBe(PRESET_ACTION.SAVE);
    expect(wrapUserChoice(`${INHERITED_AGENT_PREFIX}x`)).toEqual({
      user: `${INHERITED_AGENT_PREFIX}x`,
    });
    expect(wrapUserChoice('')).toEqual({ user: '' });
    expect(wrapUserChoice('legacy name')).toBe('legacy name');
    expect(unwrapUserChoice('plain')).toBe('plain');
  });
});

describe('own-property preset reads', () => {
  test('never resolves prototype members', () => {
    const record: Record<string, string> = {};
    expect(ownPresetValue(record, '__proto__')).toBeUndefined();
    expect(ownPresetValue(record, 'constructor')).toBeUndefined();

    const withOwn: Record<string, string> = {};
    Object.defineProperty(withOwn, '__proto__', {
      value: 'legacy',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(ownPresetValue(withOwn, '__proto__')).toBe('legacy');
  });
});

describe('descriptions and inheritance', () => {
  const presets: Record<string, PresetInput> = {
    base: { explorer: { model: 'openai/gpt-5-mini', temperature: 0.2 } },
    child: { extends: 'base', agents: { oracle: { variant: 'thinking' } } },
    grand: { extends: 'child', agents: {} },
    cycleA: { extends: 'cycleB', agents: {} },
    cycleB: { extends: 'cycleA', agents: {} },
  };

  test('describeOverride formats fields like the editors always did', () => {
    expect(
      describeOverride({
        model: 'openai/gpt-5',
        variant: 'thinking',
        temperature: 0.5,
        options: { a: 1 },
        skills: ['x'],
        mcps: ['m'],
        prompt: 'p',
        permission: {},
        displayName: 'Visible',
      }),
    ).toBe(
      'openai/gpt-5, variant=thinking, temp=0.5, options, skills=[x], mcps=[m], prompt, permission, name=Visible',
    );
    expect(describeOverride({})).toBe('(unset)');
  });

  test('describePreset reports inheritance and unresolved chains', () => {
    expect(describePreset('base', presets)).toContain(
      'explorer: openai/gpt-5-mini',
    );
    expect(describePreset('child', presets)).toContain('extends: base');
    expect(describePreset('child', presets)).toContain(
      'oracle: variant=thinking',
    );
    expect(describePreset('missing', presets)).toBe('(empty)');
  });

  test('resolveInheritedAgents is cycle-safe and non-throwing', () => {
    const resolved = resolveInheritedAgents(
      'child',
      { extends: 'base', agents: {} },
      presets,
      wouldCreatePresetCycle,
    );
    expect(resolved.error).toBeNull();
    expect(Object.keys(resolved.inheritedAgents)).toEqual(['explorer']);

    const cycled = resolveInheritedAgents(
      'cycleA',
      { extends: 'cycleB', agents: {} },
      presets,
      wouldCreatePresetCycle,
    );
    expect(cycled.error).toContain('Cycle detected');
    expect(cycled.inheritedAgents).toEqual({});

    const missing = resolveInheritedAgents(
      'child',
      { extends: 'nope', agents: {} },
      presets,
      wouldCreatePresetCycle,
    );
    expect(missing.error).toContain('not found');
  });

  test('inheritedAgentNames excludes locally overridden agents', () => {
    const names = inheritedAgentNames(
      { extends: 'base', agents: { explorer: {} } },
      { explorer: { model: 'x' }, oracle: { model: 'y' } },
    );
    expect(names).toEqual(['oracle']);
  });

  test('describeBasePresetRow and describeBasePresetCandidate', () => {
    expect(describeBasePresetRow({ agents: {} }, null)).toContain(
      'Select to inherit',
    );
    expect(describeBasePresetRow({ extends: 'base', agents: {} }, null)).toBe(
      'Inherits from "base". Select to change or remove.',
    );
    expect(describeBasePresetRow({ extends: 'base', agents: {} }, 'boom')).toBe(
      'Error: boom. Select to change or remove.',
    );
    expect(describeBasePresetCandidate('base', presets)).toContain(
      '1 effective agent',
    );
    expect(describeBasePresetCandidate('missing', presets)).toBe(
      'Configured preset',
    );
  });
});

describe('immutable agent collections', () => {
  test('withAgentOverride replaces without mutating and handles sentinel names', () => {
    const base = { explorer: { model: 'a' } };
    const next = withAgentOverride(base, '__proto__', { model: 'b' });
    expect(base).toEqual({ explorer: { model: 'a' } });
    expect(ownPresetValue(next, '__proto__')).toEqual({ model: 'b' });
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  });

  test('withoutAgentOverride is a no-op for absent agents', () => {
    const base = { explorer: { model: 'a' } };
    expect(withoutAgentOverride(base, 'oracle')).toBe(base);
    const next = withoutAgentOverride(base, 'explorer');
    expect(next).toEqual({});
    expect(base).toEqual({ explorer: { model: 'a' } });
  });

  test('availableAgentNames omits present agents', () => {
    const available = availableAgentNames(['explorer', 'oracle']);
    expect(available).not.toContain('explorer');
    expect(available).not.toContain('oracle');
    expect(available).toContain('orchestrator');
  });
});

describe('level-3 primitives', () => {
  test('model change clears a variant the new model does not expose', () => {
    const next = applyModelChoice(
      { model: 'a/b', variant: 'thinking', temperature: 0.4 },
      'c/d',
      ['low'],
    );
    expect(next).toEqual({ model: 'c/d', temperature: 0.4 });
    const kept = applyModelChoice({ model: 'a/b', variant: 'low' }, 'c/d', [
      'low',
    ]);
    expect(kept.variant).toBe('low');
  });

  test('inherit-model transition clears model and variant', () => {
    expect(
      applyInheritModelChoice({ model: 'a/b', variant: 'x', temperature: 1 }),
    ).toEqual({ temperature: 1 });
  });

  test('variant choice sets/clears the variant', () => {
    expect(applyVariantChoice({ model: 'a' }, 'high')).toEqual({
      model: 'a',
      variant: 'high',
    });
    expect(applyVariantChoice({ model: 'a', variant: 'x' }, undefined)).toEqual(
      { model: 'a' },
    );
  });

  test('temperature parsing accepts 0-2 and rejects out-of-range', () => {
    expect(parseTemperatureInput('')).toEqual({ ok: true });
    expect(parseTemperatureInput('0')).toEqual({ ok: true, temperature: 0 });
    expect(parseTemperatureInput('2')).toEqual({ ok: true, temperature: 2 });
    expect(parseTemperatureInput(' 0.5 ')).toEqual({
      ok: true,
      temperature: 0.5,
    });
    for (const bad of ['3', '-1', 'abc', 'NaN']) {
      const parsed = parseTemperatureInput(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain('between 0 and 2');
    }
  });

  test('options parsing rejects arrays, null, and scalars', () => {
    expect(parseOptionsInput('')).toEqual({ ok: true });
    expect(parseOptionsInput('{}')).toEqual({ ok: true });
    expect(parseOptionsInput('{"a":1}')).toEqual({
      ok: true,
      options: { a: 1 },
    });
    for (const bad of ['[1,2]', 'null', '"x"', '3', 'not json']) {
      const parsed = parseOptionsInput(bad);
      expect(parsed.ok).toBe(false);
    }
    const arrayParsed = parseOptionsInput('[1]');
    if (!arrayParsed.ok) {
      expect(arrayParsed.message).toContain('JSON object');
    }
  });
});

describe('persistable definitions', () => {
  test('preserves marketplace activation without materializing inheritance', () => {
    expect(
      buildPersistablePreset({
        agents: { explorer: { model: 'a' }, oracle: {} },
        marketplace: { agents: ['community/example'] },
      }),
    ).toEqual({
      agents: { explorer: { model: 'a' } },
      marketplace: { agents: ['community/example'] },
    });
  });

  test('keeps prototype-sensitive agent keys as own properties', () => {
    const agents = JSON.parse('{"__proto__":{"model":"a"}}') as Record<
      string,
      unknown
    >;
    const built = buildPersistablePreset({
      agents: agents as never,
    }) as Record<string, unknown>;
    expect(
      ownPresetValue(built as Record<string, unknown>, '__proto__'),
    ).toEqual({ model: 'a' });
    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);
  });
});
