import { describe, expect, test } from 'bun:test';
import {
  applyHits,
  deriveNewContentFromText,
  locateChunk,
  resolveChunkStart,
  resolveUpdateChunksFromText,
} from './resolution';
import type { PatchChunk } from './types';

describe('apply-patch/resolution', () => {
  test('resolveChunkStart uses change_context as an anchor when present', () => {
    const chunk: PatchChunk = {
      old_lines: [],
      new_lines: ['middle'],
      change_context: 'anchor',
    };

    expect(resolveChunkStart(['top', 'anchor', 'bottom'], chunk, 0)).toBe(2);
  });

  test('locateChunk rescues prefix/suffix and preserves new_lines', () => {
    const chunk: PatchChunk = {
      old_lines: [
        'const title = "Hola";',
        'old-value',
        'const footer = "Fin";',
      ],
      new_lines: [
        'const title = “Hola”;',
        'new-value',
        'const footer = “Fin”;',
      ],
    };

    const resolved = locateChunk(
      ['top', 'const title = “Hola”;', 'stale-value', 'const footer = “Fin”;'],
      'sample.txt',
      chunk,
      0,
    );

    expect(resolved.rewritten).toBe(true);
    expect(resolved.canonical_old_lines).toEqual([
      'const title = “Hola”;',
      'stale-value',
      'const footer = “Fin”;',
    ]);
    expect(resolved.canonical_new_lines).toEqual(chunk.new_lines);
  });

  test('locateChunk canonicalizes a tolerant unicode match', () => {
    const chunk: PatchChunk = {
      old_lines: ['const title = "Hola";'],
      new_lines: ['const title = "Hola mundo";'],
    };

    const resolved = locateChunk(
      ['const title = “Hola”;'],
      'sample.txt',
      chunk,
      0,
    );

    expect(resolved.rewritten).toBe(true);
    expect(resolved.matchComparator).toBe('unicode');
    expect(resolved.canonical_old_lines).toEqual(['const title = “Hola”;']);
    expect(resolved.canonical_new_lines).toEqual([
      'const title = "Hola mundo";',
    ]);
  });

  test('locateChunk canonicalizes a tolerant trim-end match', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha'],
      new_lines: ['omega'],
    };

    const resolved = locateChunk(['alpha  '], 'sample.txt', chunk, 0);

    expect(resolved.rewritten).toBe(true);
    expect(resolved.matchComparator).toBe('trim-end');
    expect(resolved.canonical_old_lines).toEqual(['alpha  ']);
    expect(resolved.canonical_new_lines).toEqual(['omega']);
  });

  test('locateChunk canonicalizes a tolerant trim match (native-compatible)', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha'],
      new_lines: ['omega'],
    };

    const resolved = locateChunk([' alpha  '], 'sample.txt', chunk, 0);

    expect(resolved.rewritten).toBe(true);
    expect(resolved.matchComparator).toBe('trim');
    expect(resolved.canonical_old_lines).toEqual([' alpha  ']);
    expect(resolved.canonical_new_lines).toEqual(['omega']);
  });

  test('locateChunk canonicalizes an indented match (native-compatible)', () => {
    const chunk: PatchChunk = {
      old_lines: ['enabled: false'],
      new_lines: ['enabled: true'],
    };

    const resolved = locateChunk(
      ['root:', '  child:', '    enabled: false', 'done: true'],
      'sample.yml',
      chunk,
      0,
    );

    expect(resolved.rewritten).toBe(true);
    expect(resolved.matchComparator).toBe('trim');
    expect(resolved.canonical_old_lines).toEqual(['    enabled: false']);
    expect(resolved.canonical_new_lines).toEqual(['enabled: true']);
  });

  test('locateChunk preserves a real final blank line when it exists in the file', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha', ''],
      new_lines: ['omega', ''],
    };

    const resolved = locateChunk(['alpha', ''], 'sample.txt', chunk, 0);

    expect(resolved.canonical_old_lines).toEqual(['alpha', '']);
    expect(resolved.canonical_new_lines).toEqual(['omega', '']);
  });

  test('locateChunk fails if the patch adds a non-existent final blank line', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha', ''],
      new_lines: ['omega', ''],
    };

    expect(() => locateChunk(['alpha'], 'sample.txt', chunk, 0)).toThrow(
      'Failed to find expected lines',
    );
  });

  test('deriveNewContentFromText resolves EOF updates', () => {
    expect(
      deriveNewContentFromText('sample.txt', 'alpha\nbeta', [
        {
          old_lines: ['beta'],
          new_lines: ['omega'],
          is_end_of_file: true,
        },
      ]),
    ).toBe('alpha\nomega');
  });

  test('deriveNewContentFromText preserves CRLF while rebuilding content', () => {
    expect(
      deriveNewContentFromText('sample.txt', 'alpha\r\nbeta\r\ngamma\r\n', [
        {
          old_lines: ['alpha', 'beta', 'gamma'],
          new_lines: ['alpha', 'BETA', 'gamma'],
        },
      ]),
    ).toBe('alpha\r\nBETA\r\ngamma\r\n');
  });

  test('deriveNewContentFromText inserts an anchored block without moving it to EOF', () => {
    expect(
      deriveNewContentFromText('sample.txt', 'top\nanchor\nbottom\n', [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: 'anchor',
        },
      ]),
    ).toBe('top\nanchor\nmiddle\nbottom\n');
  });

  test('deriveNewContentFromText supports pure insertion at EOF with a single anchor', () => {
    expect(
      deriveNewContentFromText('sample.txt', 'top\nanchor\n', [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: 'anchor',
        },
      ]),
    ).toBe('top\nanchor\nmiddle\n');
  });

  test('resolveUpdateChunksFromText canonicalizes EOF insertion with a tolerant anchor', () => {
    const { resolved } = resolveUpdateChunksFromText(
      'sample.txt',
      'top\n“anchor”\n',
      [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: '"anchor"',
        },
      ],
    );

    expect(resolved[0]).toMatchObject({
      canonical_change_context: '“anchor”',
      rewritten: true,
      strategy: 'anchor',
      matchComparator: 'unicode',
    });
  });

  test('resolveUpdateChunksFromText canonicalizes non-EOF insertion with a trim-end anchor', () => {
    const { resolved } = resolveUpdateChunksFromText(
      'sample.txt',
      'top\nanchor  \nbottom\n',
      [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: 'anchor',
        },
      ],
    );

    expect(resolved[0]).toMatchObject({
      canonical_change_context: 'anchor  ',
      rewritten: true,
      strategy: 'anchor',
      matchComparator: 'trim-end',
    });
  });

  test('deriveNewContentFromText fails if a pure insertion cannot find its anchor', () => {
    expect(() =>
      deriveNewContentFromText('sample.txt', 'top\nbottom\n', [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: 'anchor',
        },
      ]),
    ).toThrow('Failed to find insertion anchor');
  });

  test('deriveNewContentFromText fails if a pure insertion has an ambiguous anchor', () => {
    expect(() =>
      deriveNewContentFromText(
        'sample.txt',
        'top\nanchor\none\nsplit\nanchor\ntwo\n',
        [
          {
            old_lines: [],
            new_lines: ['middle'],
            change_context: 'anchor',
          },
        ],
      ),
    ).toThrow('Insertion anchor was ambiguous');
  });

  test('deriveNewContentFromText fails if a tolerant insertion anchor is ambiguous', () => {
    expect(() =>
      deriveNewContentFromText('sample.txt', 'top\n“anchor”\n"anchor"\n', [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: '"anchor"',
        },
      ]),
    ).toThrow('Insertion anchor was ambiguous');
  });

  test('deriveNewContentFromText fails if a later chunk remains ambiguous', () => {
    expect(() =>
      deriveNewContentFromText(
        'sample.txt',
        'alpha\none\nomega\nsplit\nleft\nstale-one\nright\ngap\nleft\nstale-two\nright\n',
        [
          {
            old_lines: ['one'],
            new_lines: ['ONE'],
          },
          {
            old_lines: ['left', 'old', 'right'],
            new_lines: ['left', 'new', 'right'],
          },
        ],
      ),
    ).toThrow('ambiguous');
  });

  test('deriveNewContentFromText rescues a stale EOF and preserves the final update', () => {
    expect(
      deriveNewContentFromText('sample.txt', 'alpha\nstale\nomega', [
        {
          old_lines: ['alpha', 'old', 'omega'],
          new_lines: ['alpha', 'new', 'omega'],
          is_end_of_file: true,
        },
      ]),
    ).toBe('alpha\nnew\nomega');
  });

  test('applyHits preserves the final newline', () => {
    expect(
      applyHits(['start', 'end'], [{ start: 0, del: 1, add: ['next'] }]),
    ).toBe('next\nend\n');
  });

  test('applyHits can preserve a file without a final newline', () => {
    expect(
      applyHits(
        ['start', 'end'],
        [{ start: 0, del: 1, add: ['next'] }],
        '\n',
        false,
      ),
    ).toBe('next\nend');
  });
});
