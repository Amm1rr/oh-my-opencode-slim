import { describe, expect, test } from 'bun:test';
import {
  applyHits,
  locateChunk,
  resolveChunkStart,
  resolveUpdate,
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

  test.each([
    [
      'unicode',
      ['const title = “Hola”;'],
      'const title = "Hola";',
      'const title = "Hola mundo";',
      'const title = “Hola”;',
    ],
    ['trim-end', ['alpha  '], 'alpha', 'omega', 'alpha  '],
    ['trim-end', ['  alpha', 'alpha  '], 'alpha', 'omega', 'alpha  '],
    ['trim', [' alpha  '], 'alpha', 'omega', ' alpha  '],
    [
      'trim',
      ['root:', '  child:', '    enabled: false', 'done: true'],
      'enabled: false',
      'enabled: true',
      '    enabled: false',
    ],
  ])(
    'locateChunk canonicalizes %s matches',
    (_, lines, oldLine, newLine, canonical) => {
      const chunk: PatchChunk = { old_lines: [oldLine], new_lines: [newLine] };
      const resolved = locateChunk(lines, 'sample.txt', chunk, 0);
      expect(resolved.rewritten).toBe(true);
      expect(resolved.canonical_old_lines).toEqual([canonical]);
      expect(resolved.canonical_new_lines).toEqual([newLine]);
    },
  );

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

  test('resolveUpdate resolves EOF updates', () => {
    expect(
      resolveUpdate('sample.txt', 'beta\nalpha\nbeta', [
        {
          old_lines: ['beta'],
          new_lines: ['omega'],
          is_end_of_file: true,
        },
      ]).nextText,
    ).toBe('beta\nalpha\nomega');
  });

  test('resolveUpdate preserves CRLF while rebuilding content', () => {
    expect(
      resolveUpdate('sample.txt', 'alpha\r\nbeta\r\ngamma\r\n', [
        {
          old_lines: ['alpha', 'beta', 'gamma'],
          new_lines: ['alpha', 'BETA', 'gamma'],
        },
      ]).nextText,
    ).toBe('alpha\r\nBETA\r\ngamma\r\n');
  });

  test('resolveUpdate inserts an anchored block without moving it to EOF', () => {
    expect(
      resolveUpdate('sample.txt', 'top\nanchor\nbottom\n', [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: 'anchor',
        },
      ]).nextText,
    ).toBe('top\nanchor\nmiddle\nbottom\n');
  });

  test('resolveUpdate supports pure insertion at EOF with a single anchor', () => {
    expect(
      resolveUpdate('sample.txt', 'top\nanchor\n', [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: 'anchor',
        },
      ]).nextText,
    ).toBe('top\nanchor\nmiddle\n');
  });

  test('resolveUpdate canonicalizes EOF insertion with a tolerant anchor', () => {
    const { resolved } = resolveUpdate('sample.txt', 'top\n“anchor”\n', [
      {
        old_lines: [],
        new_lines: ['middle'],
        change_context: '"anchor"',
      },
    ]);

    expect(resolved[0]).toMatchObject({
      canonical_change_context: '“anchor”',
      rewritten: true,
      resolved_is_end_of_file: true,
    });
  });

  test('resolveUpdate canonicalizes non-EOF insertion with a trim-end anchor', () => {
    const { resolved } = resolveUpdate(
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
      canonical_old_lines: ['bottom'],
      canonical_new_lines: ['middle', 'bottom'],
    });
  });

  test.each([
    {
      name: 'missing anchor',
      text: 'top\nbottom\n',
      chunks: [
        { old_lines: [], new_lines: ['middle'], change_context: 'anchor' },
      ],
      message: 'Failed to find insertion anchor',
    },
    {
      name: 'ambiguous anchor',
      text: 'top\nanchor\none\nsplit\nanchor\ntwo\n',
      chunks: [
        { old_lines: [], new_lines: ['middle'], change_context: 'anchor' },
      ],
      message: 'Insertion anchor was ambiguous',
    },
    {
      name: 'ambiguous tolerant anchor',
      text: 'top\n“anchor”\n"anchor"\n',
      chunks: [
        { old_lines: [], new_lines: ['middle'], change_context: '"anchor"' },
      ],
      message: 'Insertion anchor was ambiguous',
    },
    {
      name: 'ambiguous later chunk',
      text: 'alpha\none\nomega\nsplit\nleft\nstale-one\nright\ngap\nleft\nstale-two\nright\n',
      chunks: [
        { old_lines: ['one'], new_lines: ['ONE'] },
        {
          old_lines: ['left', 'old', 'right'],
          new_lines: ['left', 'new', 'right'],
        },
      ],
      message: 'ambiguous',
    },
  ])('resolveUpdate rejects $name', ({ text, chunks, message }) => {
    expect(() => resolveUpdate('sample.txt', text, chunks)).toThrow(message);
  });

  test('resolveUpdate rescues a stale EOF and preserves the final update', () => {
    expect(
      resolveUpdate('sample.txt', 'alpha\nstale\nomega', [
        {
          old_lines: ['alpha', 'old', 'omega'],
          new_lines: ['alpha', 'new', 'omega'],
          is_end_of_file: true,
        },
      ]).nextText,
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
