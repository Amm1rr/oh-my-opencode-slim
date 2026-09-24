import {
  commonEdges,
  matchesAt,
  prepareAutoRescueTarget,
  rescueByLcs,
  rescueByPrefixSuffix,
  sameRescueLine,
  seek,
  seekMatch,
} from './matching';
import type { MatchHit, PatchChunk, ResolvedChunk } from './types';

type FileLines = {
  lines: string[];
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
};

function splitFileLines(text: string): FileLines {
  const eol = text.match(/\r\n|\n|\r/)?.[0] === '\r\n' ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hasFinalNewline = normalized.endsWith('\n');
  // Empty text is zero lines, not one empty line; '\n' is one empty line.
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  if (lines.length > 0 && hasFinalNewline) {
    lines.pop();
  }

  return { lines, eol, hasFinalNewline };
}

export function resolveChunkStart(
  lines: string[],
  chunk: PatchChunk,
  start: number,
): number {
  if (!chunk.change_context) {
    return start;
  }

  const at = seek(lines, [chunk.change_context], start);
  return at === -1 ? start : at + 1;
}

function resolveUniqueAnchor(
  lines: string[],
  changeContext: string,
  start: number,
):
  | { kind: 'missing' }
  | { kind: 'ambiguous' }
  | {
      kind: 'match';
      index: number;
      exact: boolean;
      canonicalLine: string;
    } {
  let matchedIndex: number | undefined;
  const anchorTarget = prepareAutoRescueTarget(changeContext);

  for (let index = start; index < lines.length; index += 1) {
    if (!matchesAt(lines[index], anchorTarget)) {
      continue;
    }

    if (matchedIndex !== undefined) {
      return { kind: 'ambiguous' };
    }

    matchedIndex = index;
  }

  if (matchedIndex === undefined) {
    return { kind: 'missing' };
  }

  const canonicalLine = lines[matchedIndex];

  return {
    kind: 'match',
    index: matchedIndex,
    exact: canonicalLine === changeContext,
    canonicalLine,
  };
}

function buildResolvedChunk(
  lines: string[],
  chunk: PatchChunk,
  hit: MatchHit,
  rewritten: boolean,
  canonicalStart = hit.start,
  canonicalEnd = hit.start + hit.del,
  canonicalNewLines = chunk.new_lines,
  canonicalChangeContext?: string,
): ResolvedChunk {
  return {
    hit,
    canonical_old_lines: lines.slice(canonicalStart, canonicalEnd),
    canonical_new_lines: [...canonicalNewLines],
    canonical_change_context: canonicalChangeContext,
    resolved_is_end_of_file: canonicalEnd === lines.length,
    rewritten,
    canonical_start: canonicalStart,
    canonical_end: canonicalEnd,
  };
}

export function locateChunk(
  lines: string[],
  file: string,
  chunk: PatchChunk,
  start: number,
): ResolvedChunk {
  const old_lines = chunk.old_lines;
  const new_lines = chunk.new_lines;
  const match = seekMatch(
    lines,
    old_lines,
    start,
    chunk.is_end_of_file ?? false,
  );

  if (match) {
    return buildResolvedChunk(
      lines,
      chunk,
      { start: match.index, del: old_lines.length, add: [...new_lines] },
      !match.exact,
    );
  }

  const prefixSuffix = rescueByPrefixSuffix(lines, old_lines, new_lines, start);

  if (prefixSuffix.kind === 'ambiguous') {
    throw new Error(
      `Prefix/suffix rescue was ambiguous in ${file}:\n${chunk.old_lines.join(
        '\n',
      )}`,
    );
  }

  if (prefixSuffix.kind === 'match') {
    const { prefixLength, suffixLength } = commonEdges(
      old_lines,
      new_lines,
      sameRescueLine,
    );
    const canonicalStart = prefixSuffix.hit.start - prefixLength;
    const canonicalEnd =
      prefixSuffix.hit.start + prefixSuffix.hit.del + suffixLength;

    return buildResolvedChunk(
      lines,
      chunk,
      prefixSuffix.hit,
      true,
      canonicalStart,
      canonicalEnd,
    );
  }

  const lcs = rescueByLcs(lines, old_lines, new_lines, start);

  if (lcs.kind === 'ambiguous') {
    throw new Error(
      `LCS rescue was ambiguous in ${file}:\n${chunk.old_lines.join('\n')}`,
    );
  }

  if (lcs.kind === 'match') {
    return buildResolvedChunk(lines, chunk, lcs.hit, true);
  }

  throw new Error(
    `Failed to find expected lines in ${file}:\n${chunk.old_lines.join('\n')}`,
  );
}

export function applyHits(
  lines: string[],
  hits: MatchHit[],
  eol: '\n' | '\r\n' = '\n',
  hasFinalNewline = true,
): string {
  const out = [...lines];

  for (let index = hits.length - 1; index >= 0; index -= 1) {
    out.splice(hits[index].start, hits[index].del, ...hits[index].add);
  }

  if (out.length === 0) {
    return '';
  }

  const rendered = out.join(eol);
  return hasFinalNewline ? `${rendered}${eol}` : rendered;
}

export function resolveUpdate(
  file: string,
  text: string,
  chunks: PatchChunk[],
): {
  resolved: ResolvedChunk[];
  nextText: string;
} {
  const { lines, eol, hasFinalNewline } = splitFileLines(text);
  const resolved: ResolvedChunk[] = [];
  let start = 0;

  for (const chunk of chunks) {
    const chunkStart = resolveChunkStart(lines, chunk, start);

    if (chunk.old_lines.length === 0) {
      if (chunk.is_end_of_file) {
        resolved.push(
          buildResolvedChunk(
            lines,
            chunk,
            { start: lines.length, del: 0, add: [...chunk.new_lines] },
            false,
          ),
        );
        start = lines.length;
        continue;
      }

      if (!chunk.change_context) {
        throw new Error(`Missing insertion anchor in ${file}`);
      }

      const anchorMatch = resolveUniqueAnchor(
        lines,
        chunk.change_context,
        start,
      );
      if (anchorMatch.kind === 'missing') {
        throw new Error(
          `Failed to find insertion anchor in ${file}:\n${chunk.change_context}`,
        );
      }

      if (anchorMatch.kind === 'ambiguous') {
        throw new Error(
          `Insertion anchor was ambiguous in ${file}:\n${chunk.change_context}`,
        );
      }

      const insertAt = anchorMatch.index + 1;
      const hit = { start: insertAt, del: 0, add: [...chunk.new_lines] };
      const canonicalContext = anchorMatch.exact
        ? undefined
        : anchorMatch.canonicalLine;
      if (insertAt === lines.length) {
        resolved.push(
          buildResolvedChunk(
            lines,
            chunk,
            hit,
            !anchorMatch.exact,
            insertAt,
            insertAt,
            chunk.new_lines,
            canonicalContext,
          ),
        );
        start = insertAt;
        continue;
      }

      const anchor = lines[insertAt];

      resolved.push(
        buildResolvedChunk(
          lines,
          chunk,
          hit,
          true,
          insertAt,
          insertAt + 1,
          [...chunk.new_lines, anchor],
          canonicalContext,
        ),
      );
      start = insertAt;
      continue;
    }

    const found = locateChunk(lines, file, chunk, chunkStart);
    resolved.push(found);
    start = found.hit.start + found.hit.del;
  }

  resolved.sort((a, b) => a.hit.start - b.hit.start);

  for (let index = 1; index < resolved.length; index += 1) {
    const previous = resolved[index - 1].hit;
    const current = resolved[index].hit;
    if (previous.start + previous.del > current.start) {
      throw new Error(`Overlapping patch chunks in ${file}`);
    }
  }

  return {
    resolved,
    nextText: applyHits(
      lines,
      resolved.map((chunk) => chunk.hit),
      eol,
      hasFinalNewline,
    ),
  };
}
