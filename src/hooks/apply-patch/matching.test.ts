import { describe, expect, test } from 'bun:test';

import {
  commonEdges,
  rescueByLcs,
  rescueByPrefixSuffix,
  sameRescueLine,
  seek,
  seekMatch,
} from './matching';

describe('apply-patch/matching', () => {
  test.each([
    ['unicode + trim-end', 'console.log(“hola”);  ', 'console.log("hola");'],
    ['indentation', '  console.log("hola");', 'console.log("hola");'],
    [
      'curly + straight quotes',
      'const title = “it’s ready”;',
      'const title = "it\'s ready";',
    ],
  ])('seek matches %s', (_, fileLine, patchLine) => {
    expect(seek([fileLine], [patchLine], 0)).toBe(0);
  });

  test('prefix and suffix detect common edges', () => {
    const oldLines = [
      'const title = "Hola";',
      'old-value',
      'const footer = "Fin";',
    ];
    const newLines = [
      'const title = “Hola”;',
      'new-value',
      'const footer = “Fin”;',
    ];

    expect(commonEdges(oldLines, newLines, sameRescueLine)).toEqual({
      prefixLength: 1,
      suffixLength: 1,
    });
  });

  test('rescueByPrefixSuffix rescues a stale block with multiline edges', () => {
    const result = rescueByPrefixSuffix(
      ['L1', 'x', 'L1', 'L2 “q”', 'stale', 'R1', 'R2', 'R1', 'y'],
      ['L1', 'L2 "q"', 'old', 'R1', 'R2'],
      ['L1', 'L2 “q”', 'new-value', 'R1', 'R2'],
      0,
    );

    expect(result).toEqual({
      kind: 'match',
      hit: {
        start: 4,
        del: 1,
        add: ['new-value'],
      },
    });
  });

  test('rescueByPrefixSuffix does not anchor on indentation-only edges', () => {
    const result = rescueByPrefixSuffix(
      ['  left', 'stale-value', 'right'],
      ['left', 'old-value', 'right'],
      ['left', 'new-value', 'right'],
      0,
    );

    expect(result).toEqual({ kind: 'miss' });
  });

  test('rescueByPrefixSuffix marks ambiguity when multiple locations exist', () => {
    expect(
      rescueByPrefixSuffix(
        ['left', 'stale-one', 'right', 'gap', 'left', 'stale-two', 'right'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
  });

  test('rescueByPrefixSuffix preserves one-line unicode plus trim-end pairing', () => {
    expect(
      rescueByPrefixSuffix(
        ['left “x”', 'stale', 'right  '],
        ['left "x"', 'old', 'right'],
        ['left "x"', 'new', 'right'],
        0,
      ),
    ).toEqual({
      kind: 'match',
      hit: {
        start: 1,
        del: 1,
        add: ['new'],
      },
    });
  });

  test('rescueByPrefixSuffix keeps tolerant one-line ambiguity detection', () => {
    expect(
      rescueByPrefixSuffix(
        ['left', 'stale-one', 'right', 'left  ', 'stale-two', 'right'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
  });

  test('rescueByPrefixSuffix ignores one-line right hits before the left edge', () => {
    expect(
      rescueByPrefixSuffix(
        ['right', 'left', 'stale'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs respects the start and finds a single candidate', () => {
    const result = rescueByLcs(
      [
        'head',
        'left',
        'stable-old',
        'keep',
        'right',
        'gap',
        'anchor',
        'left',
        'stale-old',
        'keep',
        'right',
        'tail',
      ],
      ['left', 'old', 'keep', 'right'],
      ['left', 'new', 'keep', 'right'],
      5,
    );

    expect(result).toEqual({
      kind: 'match',
      hit: {
        start: 7,
        del: 4,
        add: ['left', 'new', 'keep', 'right'],
      },
    });
  });

  test('rescueByLcs marks ambiguity when two windows tie without common edges', () => {
    expect(
      rescueByLcs(
        ['head', 'alpha', 'beta', 'mid', 'alpha', 'beta', 'tail'],
        ['alpha', 'beta'],
        ['ALPHA', 'BETA'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'lcs' });
  });

  test('rescueByLcs rejects windows with only one matching edge even when the score is high', () => {
    expect(
      rescueByLcs(
        ['a', 'a', 'a', 'a', 'b', 'c'],
        ['a', 'b', 'c', 'd'],
        ['A', 'B', 'C', 'D'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs prunes a disproportionate chunk even when it has compatible edges', () => {
    const oldLines = Array.from({ length: 49 }, (_, index) => `line-${index}`);
    const lines = [...oldLines];
    lines[24] = 'line-24-stale';

    expect(
      rescueByLcs(
        lines,
        oldLines,
        oldLines.map((line, index) => (index === 24 ? 'line-24-new' : line)),
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs discards an implausible window before expensive scoring', () => {
    expect(
      rescueByLcs(
        ['left', 'noise-a', 'keep', 'noise-b', 'right'],
        ['left', 'old-a', 'old-b', 'old-c', 'right'],
        ['left', 'new-a', 'new-b', 'new-c', 'right'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('seekMatch reports when the match was only tolerant and safe', () => {
    expect(
      seekMatch(['console.log(“hola”);  '], ['console.log("hola");'], 0),
    ).toEqual({
      index: 0,
      exact: false,
    });
  });
});
