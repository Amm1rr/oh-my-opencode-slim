import { describe, expect, test } from 'bun:test';
import { pickAgentModelRef, resolveSecondaryModels } from './secondary-model';

describe('smartfetch model resolution', () => {
  const A = 'openai/m',
    B = 'anthropic/n',
    C = 'google/o';
  const a = { providerID: 'openai', modelID: 'm' };
  const b = { providerID: 'anthropic', modelID: 'n' };
  const c = { providerID: 'google', modelID: 'o' };
  type Case = [
    string,
    Parameters<typeof resolveSecondaryModels>[0],
    ReturnType<typeof resolveSecondaryModels>,
  ];
  const cases: Case[] = [
    [
      'dedicated priority',
      { webfetchModels: [{ id: A }, { id: B, variant: 'v' }], smallModel: A },
      [a, { ...b, variant: 'v' }],
    ],
    [
      'small/explorer/librarian order',
      { smallModel: A, explorerModel: B, librarianModel: C },
      [a, b, c],
    ],
    [
      'dedupe across sources',
      {
        webfetchModels: [{ id: A }],
        smallModel: A,
        explorerModel: A,
        librarianModel: A,
      },
      [a],
    ],
    [
      'invalid refs skipped',
      {
        webfetchModels: [{ id: A }, { id: 'x' }, { id: '/' }, { id: '' }],
        smallModel: 'x',
        explorerModel: '/',
      },
      [a],
    ],
    ['empty configuration', {}, []],
    [
      'variant distinguishes dedupe key',
      { webfetchModels: [{ id: A, variant: 'fast' }], smallModel: A },
      [{ ...a, variant: 'fast' }, a],
    ],
  ];
  for (const [name, input, expected] of cases)
    test(name, () => expect(resolveSecondaryModels(input)).toEqual(expected));
  test('no arguments means empty chain', () =>
    expect(resolveSecondaryModels()).toEqual([]));

  test('uses the first usable agent model reference', () => {
    for (const [input, expected] of [
      [A, A],
      [[{ id: A, variant: 'fast' }, B], A],
      [[B], B],
      [undefined, undefined],
      [null, undefined],
      [42, undefined],
    ] as const)
      expect(pickAgentModelRef(input)).toBe(expected);
  });
});
