import type { ParsedPatch, PatchChunk, PatchHunk } from './types';

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function stripHeredoc(input: string): string {
  const normalized = normalizeLineEndings(input);
  const match = normalized.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
  );
  return match ? match[2] : normalized;
}

export function normalizePatchText(patchText: string): string {
  return stripHeredoc(normalizeLineEndings(patchText).trim());
}

const HEADERS = [
  { prefix: '*** Add File:', type: 'add' },
  { prefix: '*** Delete File:', type: 'delete' },
  { prefix: '*** Update File:', type: 'update' },
] as const;

function parseHeader(lines: string[], index: number) {
  const header = HEADERS.find(({ prefix }) => lines[index].startsWith(prefix));
  if (!header) return null;
  const file = lines[index].slice(header.prefix.length).trim();
  if (!file) return null;

  let move: string | undefined;
  let next = index + 1;
  if (header.type === 'update' && lines[next]?.startsWith('*** Move to:')) {
    move = lines[next].slice('*** Move to:'.length).trim();
    if (!move) return null;
    next += 1;
  }

  return { type: header.type, file, move, next };
}

function unexpectedPatchLine(context: string, line: string): never {
  const rendered = line.length === 0 ? '<empty>' : line;
  throw new Error(
    `Invalid patch format: unexpected line ${context}: ${rendered}`,
  );
}

function parseChangeContext(line: string): string | undefined {
  const context = line.slice(2);
  if (context.length === 0) {
    return undefined;
  }

  return context.startsWith(' ') ? context.slice(1) || undefined : context;
}

function isPatchBoundary(line: string, marker: string): boolean {
  return line.trimEnd() === marker;
}

function parseChunks(lines: string[], index: number) {
  const chunks: PatchChunk[] = [];
  let at = index;

  while (at < lines.length && !lines[at].startsWith('***')) {
    if (!lines[at].startsWith('@@')) {
      unexpectedPatchLine('in update body', lines[at]);
    }

    const context = parseChangeContext(lines[at]);
    at += 1;

    const old_lines: string[] = [];
    const new_lines: string[] = [];
    let eof = false;

    while (
      at < lines.length &&
      !lines[at].startsWith('@@') &&
      (!lines[at].startsWith('***') || lines[at] === '*** End of File')
    ) {
      const line = lines[at];

      if (line === '*** End of File') {
        eof = true;
        at += 1;
        break;
      }

      if (line.startsWith(' ')) {
        old_lines.push(line.slice(1));
        new_lines.push(line.slice(1));
        at += 1;
        continue;
      }

      if (line.startsWith('-')) {
        old_lines.push(line.slice(1));
        at += 1;
        continue;
      }

      if (line.startsWith('+')) {
        new_lines.push(line.slice(1));
        at += 1;
        continue;
      }

      unexpectedPatchLine('in patch chunk', line);
    }

    chunks.push({
      old_lines,
      new_lines,
      change_context: context,
      is_end_of_file: eof || undefined,
    });
  }

  return { chunks, next: at };
}

function parseAdd(lines: string[], index: number) {
  const contents: string[] = [];
  let at = index;

  while (at < lines.length && !lines[at].startsWith('***')) {
    if (lines[at].startsWith('+')) {
      contents.push(lines[at].slice(1));
      at += 1;
      continue;
    }

    unexpectedPatchLine('in Add File body', lines[at]);
  }

  // Canonical Add representation: either empty (no lines) or newline-
  // terminated. `+a` followed by `+` must describe two lines ("a\n\n"),
  // not collapse into one; a lone `+` is a single empty line ("\n").
  return {
    content: contents.length === 0 ? '' : `${contents.join('\n')}\n`,
    next: at,
  };
}

export function parsePatch(patchText: string): ParsedPatch {
  const clean = normalizePatchText(patchText);
  const lines = clean.split('\n');
  const begin = lines.findIndex((line) =>
    isPatchBoundary(line, '*** Begin Patch'),
  );
  const end = lines.findIndex(
    (line, index) => index > begin && isPatchBoundary(line, '*** End Patch'),
  );

  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error('Invalid patch format: missing Begin/End markers');
  }

  for (const line of lines.slice(0, begin)) {
    unexpectedPatchLine('before Begin Patch', line);
  }

  for (const line of lines.slice(end + 1)) {
    unexpectedPatchLine('after End Patch', line);
  }

  const hunks: PatchHunk[] = [];
  let index = begin + 1;

  while (index < end) {
    const header = parseHeader(lines, index);

    if (!header) {
      unexpectedPatchLine('between hunks', lines[index]);
    }

    if (header.type === 'add') {
      const next = parseAdd(lines, header.next);
      hunks.push({
        type: 'add',
        path: header.file,
        contents: next.content,
      });
      index = next.next;
      continue;
    }

    if (header.type === 'delete') {
      hunks.push({ type: 'delete', path: header.file });
      index = header.next;
      continue;
    }

    const next = parseChunks(lines, header.next);
    if (next.chunks.length === 0) {
      throw new Error(
        `Invalid patch format: Update File is missing @@ chunk body: ${header.file}`,
      );
    }

    hunks.push({
      type: 'update',
      path: header.file,
      move_path: header.move,
      chunks: next.chunks,
    });
    index = next.next;
  }

  return { hunks };
}

function renderChunk(chunk: PatchChunk): string[] {
  const lines = [chunk.change_context ? `@@ ${chunk.change_context}` : '@@'];
  let prefix = 0;
  while (
    prefix < chunk.old_lines.length &&
    prefix < chunk.new_lines.length &&
    chunk.old_lines[prefix] === chunk.new_lines[prefix]
  )
    prefix++;

  let suffix = 0;
  while (
    chunk.old_lines.length - suffix > prefix &&
    chunk.new_lines.length - suffix > prefix &&
    chunk.old_lines[chunk.old_lines.length - suffix - 1] ===
      chunk.new_lines[chunk.new_lines.length - suffix - 1]
  )
    suffix++;

  for (const line of chunk.old_lines.slice(0, prefix)) lines.push(` ${line}`);
  for (const line of chunk.old_lines.slice(
    prefix,
    chunk.old_lines.length - suffix,
  ))
    lines.push(`-${line}`);
  for (const line of chunk.new_lines.slice(
    prefix,
    chunk.new_lines.length - suffix,
  ))
    lines.push(`+${line}`);
  for (const line of chunk.old_lines.slice(chunk.old_lines.length - suffix))
    lines.push(` ${line}`);

  if (chunk.is_end_of_file) {
    lines.push('*** End of File');
  }

  return lines;
}

function renderAddContents(contents: string): string[] {
  if (contents.length === 0) {
    return [];
  }

  // Drop only the terminator's empty element, retaining unterminated lines.
  const lines = contents.split('\n');
  if (contents.endsWith('\n')) {
    lines.pop();
  }
  return lines.map((line) => `+${line}`);
}

export function formatPatch(patch: ParsedPatch): string {
  const lines = ['*** Begin Patch'];

  for (const hunk of patch.hunks) {
    if (hunk.type === 'add') {
      lines.push(`*** Add File: ${hunk.path}`);
      lines.push(...renderAddContents(hunk.contents));
      continue;
    }

    if (hunk.type === 'delete') {
      lines.push(`*** Delete File: ${hunk.path}`);
      continue;
    }

    lines.push(`*** Update File: ${hunk.path}`);
    if (hunk.move_path) {
      lines.push(`*** Move to: ${hunk.move_path}`);
    }
    for (const chunk of hunk.chunks) {
      lines.push(...renderChunk(chunk));
    }
  }

  lines.push('*** End Patch');
  return lines.join('\n');
}
