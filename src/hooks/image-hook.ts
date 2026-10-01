import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { isUserMessageWithParts, type MessageWithParts } from './types';

/** Keep this aligned with the host read tool's MAX_MEDIA_INGEST_BYTES. */
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024;
const IMAGES_GITIGNORE_RULE = 'images/';
const IMAGES_GITIGNORE_BYTES = Buffer.from(`${IMAGES_GITIGNORE_RULE}\n`);

function opencodeDirPath(workDir: string): string {
  return join(workDir, '.opencode');
}

function opencodeGitignorePath(workDir: string): string {
  return join(opencodeDirPath(workDir), '.gitignore');
}

function imagesDirPath(workDir: string): string {
  return join(opencodeDirPath(workDir), 'images');
}

function pathIsSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(target: string): boolean {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
}

function isUnsafeOpencodeGitignorePath(workDir: string): boolean {
  return (
    pathIsSymlink(opencodeDirPath(workDir)) ||
    pathIsSymlink(opencodeGitignorePath(workDir))
  );
}

function isUnsafeImageSavePath(workDir: string): boolean {
  return (
    pathIsSymlink(opencodeDirPath(workDir)) ||
    pathIsSymlink(imagesDirPath(workDir))
  );
}

function gitignoreHasExactRule(content: string, rule: string): boolean {
  return content.split(/\r?\n/).includes(rule);
}

/**
 * Protect only the generated images directory. Called once per image-bearing
 * transform before any write, so persisted images are never left un-ignored;
 * direct routing and text-only messages never reach this.
 */
function ensureImagesGitignore(
  workDir: string,
  logFn: (msg: string) => void,
): boolean {
  const gitignorePath = opencodeGitignorePath(workDir);
  try {
    if (isUnsafeOpencodeGitignorePath(workDir)) {
      logFn('[image-hook] refusing to update symlinked .opencode/.gitignore');
      return false;
    }

    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, IMAGES_GITIGNORE_BYTES);
      return true;
    }

    const raw = readFileSync(gitignorePath);
    if (gitignoreHasExactRule(raw.toString('utf8'), IMAGES_GITIGNORE_RULE)) {
      return true;
    }

    const needsNewline = raw.length > 0 && raw[raw.length - 1] !== 0x0a;
    const suffix = needsNewline
      ? Buffer.from(`\n${IMAGES_GITIGNORE_RULE}\n`)
      : IMAGES_GITIGNORE_BYTES;
    appendFileSync(gitignorePath, suffix);
    return true;
  } catch (error) {
    logFn(`[image-hook] failed to update .gitignore: ${error}`);
    return false;
  }
}

interface ImagePart {
  type: string;
  url?: string;
  mime?: string;
  mediaType?: string;
  filename?: string;
  name?: string;
  data?: string;
  [key: string]: unknown;
}

const IMAGE_FILE_EXTENSION_RE =
  /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic)$/i;

function hasImageFileExtension(p: ImagePart): boolean {
  const filename = p.filename as string | undefined;
  const name = p.name as string | undefined;
  const fileName = filename ?? name;
  return Boolean(fileName && IMAGE_FILE_EXTENSION_RE.test(fileName));
}

function isImagePart(p: ImagePart): boolean {
  if (p.type === 'image') return true;
  if (p.type === 'file') {
    const mime = p.mime as string | undefined;
    if (mime?.startsWith('image/')) return true;
    if (hasImageFileExtension(p)) return true;
  }
  if (p.type === 'media') {
    const mediaType = p.mediaType as string | undefined;
    if (mediaType?.startsWith('image/')) return true;
    if (hasImageFileExtension(p)) return true;
  }
  return false;
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
}

const MIME_EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
};

function extFromMime(mime: string): string {
  return MIME_EXT_BY_TYPE[mime] ?? '.png';
}

function extFromMimeFromUrl(url: string): string {
  const match = url.match(/^data:([^;,]+)/);
  return match ? extFromMime(match[1]) : '.png';
}

function extFromMediaPart(p: {
  mediaType?: string;
  filename?: string;
}): string {
  if (p.mediaType) {
    const mimeExt = MIME_EXT_BY_TYPE[p.mediaType];
    if (mimeExt) return mimeExt;
  }
  if (p.filename) {
    const fileExt = extname(p.filename);
    if (fileExt) return fileExt;
  }
  return '.png';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Save a content-addressed image with an exclusive create. The filename is
 * the content digest, so an existing path is the durable dedup memo: reuse it
 * without rewriting.
 */
function writeUniqueFile(
  dir: string,
  name: string,
  data: Buffer,
  log: (msg: string) => void,
): string | null {
  const ext = extname(name);
  const base = basename(name, ext) || name;
  let candidate = join(dir, name);
  let counter = 0;

  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Never treat a symlink as an already-saved image and never write through
    // it. Advance to the next collision name instead.
    if (pathIsSymlink(candidate)) {
      counter += 1;
      candidate = join(dir, `${base}-${counter}${ext}`);
      continue;
    }

    // Existing regular file at this content-addressed name: reuse the path.
    // A non-file entry (directory, fifo, ...) squatting on the name is not a
    // saved image; advance to the next collision name instead of reusing it.
    if (existsSync(candidate)) {
      if (isRegularFile(candidate)) {
        return candidate;
      }
      counter += 1;
      candidate = join(dir, `${base}-${counter}${ext}`);
      continue;
    }

    try {
      writeFileSync(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        counter += 1;
        candidate = join(dir, `${base}-${counter}${ext}`);
        continue;
      }

      // A failed write can leave a truncated file at the content-addressed
      // path; remove it so a later transform never reuses corrupt bytes.
      try {
        unlinkSync(candidate);
      } catch {
        // Best effort: nothing was created, or it is already gone.
      }
      log(`[image-hook] failed to save image: ${e}`);
      return null;
    }
  }

  log(
    `[image-hook] failed to save image: max attempts (${MAX_ATTEMPTS}) reached`,
  );
  return null;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function processImageAttachments(args: {
  messages: MessageWithParts[];
  workDir: string;
  imageRouting: 'auto' | 'direct';
  disabledAgents: ReadonlySet<string>;
  log: (msg: string) => void;
}): boolean {
  const { messages, workDir, imageRouting, disabledAgents, log } = args;

  // direct mode: never intercept attachments; the orchestrator handles them
  // inline. @observer remains available for manual delegation.
  if (imageRouting === 'direct') return false;

  // Keep original parts when observer is unavailable. The caller displays a
  // debounced warning toast; this hook must never destroy user data.
  if (disabledAgents.has('observer')) {
    const userMessages = messages.filter(isUserMessageWithParts);
    const latestUserMessage = userMessages[userMessages.length - 1];
    if (latestUserMessage?.parts.some(isImagePart)) {
      log(
        '[image-hook] images retained inline; observer disabled — enable observer or set image_routing "direct"',
      );
      return true;
    }
    return false;
  }

  const messagesWithImages: Array<{
    msg: MessageWithParts;
    imageParts: ImagePart[];
  }> = [];

  for (const msg of messages) {
    if (!isUserMessageWithParts(msg)) continue;
    const imageParts = msg.parts.filter(isImagePart);
    if (imageParts.length > 0) {
      messagesWithImages.push({ msg, imageParts });
    }
  }

  if (messagesWithImages.length === 0) return false;

  const saveDir = imagesDirPath(workDir);
  if (isUnsafeImageSavePath(workDir)) {
    log('[image-hook] refusing to write via symlinked .opencode/images path');
    return false;
  }

  try {
    mkdirSync(saveDir, { recursive: true });
  } catch (error) {
    log(`[image-hook] failed to create image directory: ${error}`);
  }

  // Persist images only when the images directory is git-ignored. Ensuring
  // once per image-bearing transform (before any write) keeps reused images
  // protected and guarantees a failed ensure leaves zero files behind.
  if (!ensureImagesGitignore(workDir, log)) {
    log('[image-hook] images kept inline: .gitignore protection failed');
    return false;
  }

  for (const { msg, imageParts } of messagesWithImages) {
    const sessionSubdir = msg.info.sessionID
      ? sanitizeFilename(msg.info.sessionID)
      : undefined;
    const targetDir = sessionSubdir ? join(saveDir, sessionSubdir) : saveDir;

    if (pathIsSymlink(targetDir)) {
      log(
        `[image-hook] refusing to write via symlinked session image directory: ${targetDir}`,
      );
      continue;
    }

    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (error) {
      log(`[image-hook] failed to create target image directory: ${error}`);
    }

    const savedPaths: string[] = [];
    const oversizedPaths = new Map<string, number>();
    const savedImageParts = new Set<ImagePart>();

    const saveDecoded = (
      part: ImagePart,
      data: Buffer,
      ext: string,
      baseName: string,
    ): void => {
      if (data.length === 0) return;

      const hash = createHash('sha1').update(data).digest('hex').slice(0, 8);
      const name = `${baseName}-${hash}${ext}`;
      const filePath = writeUniqueFile(targetDir, name, data, log);
      if (!filePath) return;

      savedPaths.push(filePath);
      savedImageParts.add(part);
      if (data.length > MAX_MEDIA_INGEST_BYTES) {
        oversizedPaths.set(filePath, data.length);
      }
    };

    for (const p of imageParts) {
      const url = p.url as string | undefined;
      const mediaType = p.mediaType as string | undefined;
      const data = p.data as string | undefined;
      const filename =
        (p.filename as string | undefined) ?? (p.name as string | undefined);
      const sanitizedFilename = filename
        ? sanitizeFilename(filename)
        : undefined;
      const baseName = sanitizedFilename
        ? sanitizedFilename.replace(/\.[^.]+$/, '') || 'image'
        : 'image';

      if (!url && data !== undefined) {
        // Buffer.from leniently decodes invalid base64 instead of throwing;
        // host-produced media parts are well-formed, and the fail-open
        // contract (never throw, never block) takes precedence here.
        const decoded = Buffer.from(data, 'base64');
        saveDecoded(
          p,
          decoded,
          extFromMediaPart({
            mediaType,
            filename: sanitizedFilename,
          }),
          baseName,
        );
        continue;
      }

      if (url) {
        const ext = sanitizedFilename
          ? extname(sanitizedFilename) || extFromMimeFromUrl(url)
          : extFromMimeFromUrl(url);
        const decoded = decodeDataUrl(url);
        if (decoded) saveDecoded(p, decoded.data, ext, baseName);
      }
    }

    // If no image could be saved, leave every original part in place. This is
    // the fail-open contract for malformed data, permissions, and NFS errors.
    if (savedPaths.length === 0) {
      log('[image-hook] no images saved; leaving original parts in message');
      continue;
    }

    const readablePaths = savedPaths.filter(
      (filePath) => !oversizedPaths.has(filePath),
    );
    const nudgeSections: string[] = [];
    if (readablePaths.length > 0) {
      nudgeSections.push(
        `Saved to:\n${readablePaths.map((p) => `- ${p}`).join('\n')}\nYour model may not support image input. Delegate to @observer with these file path(s) and your goal so it can read the files with its read tool.`,
      );
    }
    if (oversizedPaths.size > 0) {
      nudgeSections.push(
        `Too large to analyze (host read limit 20 MiB) — do not delegate these; ask the user to compress or crop them first:\n${[
          ...oversizedPaths.entries(),
        ]
          .map(([p, size]) => `- ${p} (${formatMiB(size)})`)
          .join('\n')}`,
      );
    }

    log(
      `[image-routing] auto mode: intercepted ${savedImageParts.size} image(s), delegating ${readablePaths.length}`,
    );

    msg.parts = msg.parts
      .filter((p) => !savedImageParts.has(p as ImagePart))
      .concat([
        {
          type: 'text',
          text: `[Image attachment detected. ${nudgeSections.join('\n')}]`,
        },
      ]);
  }
  return false;
}
