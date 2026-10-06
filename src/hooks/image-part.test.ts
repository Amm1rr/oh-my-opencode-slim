import { describe, expect, it } from 'bun:test';
import { asImagePart, MIME_EXT_BY_TYPE } from './image-part';

const IMG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const IMG_BASE64 = IMG_BYTES.toString('base64');
const IMG_DATA_URL = `data:image/png;base64,${IMG_BASE64}`;

/** v2.0.14+ Media.Asset, live-instance form (base64 or bytes source). */
function assetPart(
  source: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'media',
    media: { mediaType: 'image/png', kind: 'image', source, ...overrides },
    filename: 'clipboard.png',
  };
}

describe('asImagePart host shape matrix', () => {
  describe('v1 file/image parts', () => {
    it('materializes a v1 image part with a base64 data field (no url)', () => {
      const view = asImagePart({
        type: 'image',
        data: IMG_BASE64,
        filename: 'paste.png',
      });
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'paste.png',
      });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });
    it('materializes a v1 image part with a data URL', () => {
      const view = asImagePart({ type: 'image', url: IMG_DATA_URL });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('materializes a v1 file part carrying image bytes', () => {
      const view = asImagePart({
        type: 'file',
        url: IMG_DATA_URL,
        filename: 'photo.png',
      });
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'photo.png',
      });
    });

    it('treats a v1 image behind a remote URL as remote', () => {
      expect(
        asImagePart({ type: 'image', url: 'https://example.com/a.png' }),
      ).toEqual({
        view: 'remote',
      });
    });

    it('treats a zero-byte v1 data URL as remote', () => {
      // 'A' is one base64 character: it decodes to zero bytes.
      expect(
        asImagePart({ type: 'image', url: 'data:image/png;base64,A' }),
      ).toEqual({
        view: 'remote',
      });
    });

    it('treats an extension-only v1 file part as remote', () => {
      expect(
        asImagePart({
          type: 'file',
          filename: 'logo.svg',
          url: 'file:///tmp/logo.svg',
        }),
      ).toEqual({ view: 'remote' });
    });

    it('rejects non-image v1 file parts', () => {
      expect(
        asImagePart({ type: 'file', url: 'data:text/plain;base64,aGk=' }),
      ).toBeNull();
    });
  });

  describe('flat v2 media parts', () => {
    it('materializes a flat media part with base64 data', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: IMG_BASE64,
        filename: 'shot.png',
      });
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'shot.png',
      });
    });

    it('materializes flat media with Uint8Array data (dev shape)', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: new Uint8Array(IMG_BYTES),
      });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('treats flat media with no payload as remote', () => {
      expect(asImagePart({ type: 'media', mediaType: 'image/png' })).toEqual({
        view: 'remote',
      });
    });

    it('treats flat media with an empty payload as remote', () => {
      expect(
        asImagePart({ type: 'media', mediaType: 'image/png', data: '' }),
      ).toEqual({ view: 'remote' });
    });
  });

  describe('v2.0.14+ Media.Asset parts', () => {
    it('materializes an Asset with a base64 source (#1247 clipboard case)', () => {
      const view = asImagePart(
        assetPart({ type: 'base64', data: IMG_BASE64, mediaType: 'image/png' }),
      );
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'clipboard.png',
      });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('materializes an Asset with a bytes source', () => {
      const view = asImagePart(
        assetPart({
          type: 'bytes',
          data: new Uint8Array(IMG_BYTES),
          mediaType: 'image/png',
        }),
      );
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('materializes the JSON-replayed Asset form: no top-level mediaType, bytes-as-base64-string', () => {
      // Asset.toJSON emits { source, info } only; a bytes source serializes
      // its data as base64 while keeping type === 'bytes'.
      const view = asImagePart({
        type: 'media',
        media: {
          source: { type: 'bytes', data: IMG_BASE64, mediaType: 'image/png' },
        },
        filename: 'replayed.png',
      });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('treats Asset url and ref sources as remote', () => {
      expect(
        asImagePart(
          assetPart({ type: 'url', url: 'https://example.com/a.png' }),
        ),
      ).toEqual({ view: 'remote' });
      expect(
        asImagePart(
          assetPart({ type: 'ref', provider: 'openai', id: 'file-1' }),
        ),
      ).toEqual({ view: 'remote' });
    });

    it('treats an unrecognized Asset source as remote, not null', () => {
      expect(
        asImagePart(assetPart({ type: 'stream', data: IMG_BASE64 })),
      ).toEqual({ view: 'remote' });
    });

    it('treats malformed Asset carriers as remote', () => {
      expect(asImagePart(assetPart({ type: 'base64', data: 42 }))).toEqual({
        view: 'remote',
      });
    });

    it('treats a zero-byte Asset payload as remote', () => {
      expect(
        asImagePart(
          assetPart({
            type: 'bytes',
            data: new Uint8Array(0),
            mediaType: 'image/png',
          }),
        ),
      ).toEqual({ view: 'remote' });
    });

    it('detects an Asset image via filename extension when mediaType is generic', () => {
      const view = asImagePart(
        assetPart(
          { type: 'url', url: 'https://example.com/x' },
          { mediaType: 'application/octet-stream' },
        ),
      );
      expect(view).toEqual({ view: 'remote' });
    });

    it('rejects non-image Asset media', () => {
      expect(
        asImagePart({
          type: 'media',
          media: {
            mediaType: 'audio/mpeg',
            source: { type: 'base64', data: 'AAAA', mediaType: 'audio/mpeg' },
          },
        }),
      ).toBeNull();
    });
  });

  describe('non-image and degenerate parts', () => {
    it('rejects plain text parts, non-records, and unknown types', () => {
      expect(asImagePart({ type: 'text', text: 'hi' })).toBeNull();
      expect(asImagePart('media')).toBeNull();
      expect(asImagePart(null)).toBeNull();
      expect(asImagePart({ type: 'video', url: IMG_DATA_URL })).toBeNull();
    });

    it('rejects a media part whose media field is not a record', () => {
      expect(asImagePart({ type: 'media', media: 'not-an-asset' })).toBeNull();
    });

    it('rescues an unclassified octet-stream Asset by sniffing image signatures', () => {
      // IMG_BYTES is the PNG signature: a clipboard image the host could not
      // classify still reaches the observer pipeline.
      const view = asImagePart({
        type: 'media',
        media: {
          mediaType: 'application/octet-stream',
          source: { type: 'base64', data: IMG_BASE64 },
        },
        filename: 'clipboard',
      });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('rejects an unclassified Asset whose bytes are not an image', () => {
      expect(
        asImagePart({
          type: 'media',
          media: {
            mediaType: 'application/octet-stream',
            source: {
              type: 'bytes',
              data: new Uint8Array(Buffer.from('plain text, not an image')),
              mediaType: 'application/octet-stream',
            },
          },
          filename: 'clipboard',
        }),
      ).toBeNull();
    });

    it('never second-guesses a specific non-image declaration', () => {
      expect(
        asImagePart({
          type: 'media',
          media: {
            mediaType: 'audio/mpeg',
            source: {
              type: 'base64',
              data: IMG_BASE64,
              mediaType: 'audio/mpeg',
            },
          },
        }),
      ).toBeNull();
    });
  });

  describe('extension resolution', () => {
    it('maps every sniffable signature to its mime', () => {
      const cases: Array<[Buffer, string]> = [
        [Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png'],
        [Buffer.from('ffd8ffe000104a464946', 'hex'), 'image/jpeg'],
        [Buffer.from('GIF89a', 'latin1'), 'image/gif'],
        [
          Buffer.concat([
            Buffer.from('RIFF', 'latin1'),
            Buffer.alloc(4),
            Buffer.from('WEBP', 'latin1'),
          ]),
          'image/webp',
        ],
        [
          Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(2)]),
          'image/bmp',
        ],
        [Buffer.from('49492a00', 'hex'), 'image/tiff'],
        [Buffer.from('4d4d002a', 'hex'), 'image/tiff'],
        [
          Buffer.concat([
            Buffer.alloc(4),
            Buffer.from('ftypavif', 'latin1'),
            Buffer.alloc(4),
          ]),
          'image/avif',
        ],
        [
          Buffer.concat([
            Buffer.alloc(4),
            Buffer.from('ftypheic', 'latin1'),
            Buffer.alloc(4),
          ]),
          'image/heic',
        ],
      ];
      for (const [bytes, mime] of cases) {
        expect(
          asImagePart({
            type: 'media',
            mediaType: 'application/octet-stream',
            data: bytes.toString('base64'),
          }),
        ).toMatchObject({ view: 'bytes', ext: MIME_EXT_BY_TYPE[mime] });
      }
    });

    it('prefers the mime mapping over a conflicting filename extension', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: IMG_BASE64,
        filename: 'photo.jpg',
      });
      expect(view).toMatchObject({ ext: '.png' });
    });

    it('falls back to the filename extension for unmapped mimes', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/x-nikon-raw',
        data: IMG_BASE64,
        filename: 'shot.nef',
      });
      expect(view).toMatchObject({ ext: '.nef' });
    });

    it('maps heic, heif, tiff, and avif mimes', () => {
      for (const [mime, ext] of [
        ['image/heic', '.heic'],
        ['image/heif', '.heic'],
        ['image/tiff', '.tiff'],
        ['image/avif', '.avif'],
      ] as const) {
        const view = asImagePart({
          type: 'media',
          mediaType: mime,
          data: IMG_BASE64,
        });
        expect(view).toMatchObject({ ext });
      }
    });

    it('defaults to .png when neither mime nor filename yields an extension', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: IMG_BASE64,
        filename: 'clipboard',
      });
      expect(view).toMatchObject({ ext: '.png', filename: 'clipboard' });
    });
  });
});
