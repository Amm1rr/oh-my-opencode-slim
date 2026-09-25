import os from 'node:os';
import path from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { buildBinaryResultMessage, saveBinary } from './binary';
import { buildCacheKey, CACHE } from './cache';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_LLMS_PROBE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_SECONDS,
  WEBFETCH_DESCRIPTION,
} from './constants';
import {
  buildPermissionPatterns,
  decodeBody,
  extractHeaderMetadata,
  fetchWithUpgradeFallback,
  getBinaryKind,
  isBinaryContentType,
  isDocsLikeUrl,
  isGenericBinaryMime,
  isHtmlLikeContentType,
  looksLikeHtmlText,
  looksLikeTextBody,
  normalizeUrl,
  probeLlmsText,
  readBodyLimited,
  runWithScopedTimeout,
} from './network';
import {
  decideSecondaryModelUse,
  resolveSecondaryModels,
  runSecondaryModelWithFallback,
} from './secondary-model';
import type { RedirectStep, SmartfetchOptions } from './types';
import {
  buildLlmsRequiredMessage,
  buildRedirectResultMessage,
  cleanFetchedText,
  detectQualitySignals,
  extractFromHtml,
  extractHeadingsFromMarkdown,
  frontmatter,
  inferCanonicalUrlFromText,
  joinRenderedContent,
  pickContent,
  renderMessageForFormat,
  trimBlankRuns,
  wordCount,
} from './utils';

const z = tool.schema;

export function createWebfetchTool(
  pluginCtx: PluginInput,
  options: SmartfetchOptions = {},
): ToolDefinition {
  const binaryDir =
    options.binaryDir || path.join(os.tmpdir(), 'opencode-smartfetch');

  return tool({
    description: WEBFETCH_DESCRIPTION,
    args: {
      url: z.httpUrl(),
      format: z.enum(['text', 'markdown', 'html']).default('markdown'),
      timeout: z
        .number()
        .positive()
        .max(MAX_TIMEOUT_SECONDS)
        .optional()
        .describe('Timeout in seconds, max 120.'),
      prompt: z
        .string()
        .optional()
        .describe(
          'Optional extraction task to run on the fetched content using a cheap secondary model.',
        ),
      extract_main: z.boolean().default(true),
      prefer_llms_txt: z.enum(['auto', 'always', 'never']).default('auto'),
      include_metadata: z.boolean().default(true),
      save_binary: z
        .boolean()
        .default(false)
        .describe(
          'Save binary payload to disk when it fits within the active download limit.',
        ),
    },
    async execute(args, ctx) {
      const secondaryModels = resolveSecondaryModels({
        webfetchModels: options.webfetchModels,
        smallModel: options.smallModelRef?.() ?? undefined,
        explorerModel: options.explorerModel,
        librarianModel: options.librarianModel,
      });
      const normalized = normalizeUrl(args.url);
      const url = new URL(normalized.url);
      const cacheOptions = {
        extract_main: args.extract_main,
        prefer_llms_txt: args.prefer_llms_txt,
        save_binary: args.save_binary,
      };
      const cacheKey = buildCacheKey(args.url, cacheOptions);
      const shouldProbeLlmsTxt =
        args.prefer_llms_txt === 'always' ||
        (args.prefer_llms_txt === 'auto' && isDocsLikeUrl(url));
      const permissionPatterns = buildPermissionPatterns(
        normalized,
        shouldProbeLlmsTxt,
      );

      await ctx.ask({
        permission: 'webfetch',
        patterns: permissionPatterns,
        always: permissionPatterns,
        metadata: {
          url: normalized.url,
          requested_url: args.url,
          fallback_url: normalized.fallbackUrl,
          llms_probe_enabled: shouldProbeLlmsTxt,
          format: args.format,
          prompt: args.prompt,
        },
      });

      const timeoutMs = Math.min(
        (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        MAX_TIMEOUT_SECONDS * 1000,
      );
      return runWithScopedTimeout(ctx.abort, timeoutMs, async (signal) => {
        signal.throwIfAborted();
        let fetchResult = CACHE.get(cacheKey);
        const cacheHit = !!fetchResult;
        if (!fetchResult) {
          let llmsProbeError: string | undefined;

          if (shouldProbeLlmsTxt) {
            const fallbackOrigin = normalized.fallbackUrl
              ? new URL(normalized.fallbackUrl).origin
              : undefined;
            const probeTimeoutMs = Math.max(
              1,
              Math.min(MAX_LLMS_PROBE_TIMEOUT_MS, timeoutMs),
            );
            const llms = await runWithScopedTimeout(
              signal,
              probeTimeoutMs,
              (probeSignal) => probeLlmsText(url, probeSignal, fallbackOrigin),
            );
            if (llms && 'text' in llms) {
              const llmsHeaders = llms.headers || {};
              const text = trimBlankRuns(llms.text);
              fetchResult = {
                finalUrl: llms.url,
                statusCode: llms.statusCode,
                contentType: llmsHeaders.contentType || 'text/plain',
                charset: llmsHeaders.charset,
                etag: llmsHeaders.etag,
                lastModified: llmsHeaders.lastModified,
                contentLength: llmsHeaders.contentLength,
                filename: llmsHeaders.filename,
                canonicalUrl: inferCanonicalUrlFromText(text, llms.url),
                headings: extractHeadingsFromMarkdown(text),
                title: undefined,
                rawContent: text,
                markdown: text,
                text,
                html: text,
                extractedMain: false,
                usedLlmsTxt: true,
                sourceKind: 'llms_txt',
                upgradedToHttps: !!llms.upgradedToHttps,
                redirectChain: llms.redirectChain || [],
                truncated: !!llms.truncated,
                wordCount: wordCount(text),
                qualitySignals: detectQualitySignals({
                  text,
                  markdown: text,
                  rawContent: text,
                  wordCount: wordCount(text),
                  sourceKind: 'llms_txt',
                  extractedMain: false,
                }),
                decodedCharset: llms.decodedCharset,
                decodeFallback: llms.decodeFallback,
                decodeWarning: llms.decodeWarning,
              };
            } else if (llms?.error) {
              llmsProbeError = llms.error;
            }

            if (!fetchResult && args.prefer_llms_txt === 'always') {
              const metadata = args.include_metadata
                ? frontmatter({
                    requested_url: args.url,
                    used_llms_txt: false,
                    llms_probe_error: llmsProbeError,
                    prefer_llms_txt: args.prefer_llms_txt,
                  })
                : '';
              return joinRenderedContent(
                metadata,
                renderMessageForFormat(
                  buildLlmsRequiredMessage(args.url, llmsProbeError),
                  args.format,
                ),
                args.format,
              );
            }
          }

          if (!fetchResult) {
            const { result, upgradedToHttps } = await fetchWithUpgradeFallback(
              normalized,
              signal,
            );
            if ('blockedRedirect' in result) {
              const metadata = args.include_metadata
                ? frontmatter({
                    requested_url: args.url,
                    redirect_url: result.redirectUrl,
                    status_code: result.statusCode,
                    redirect_chain: result.redirectChain.map(
                      (step: RedirectStep) =>
                        `${step.status} ${step.from} -> ${step.to}`,
                    ),
                    upgraded_to_https: upgradedToHttps,
                  })
                : '';
              return joinRenderedContent(
                metadata,
                renderMessageForFormat(
                  buildRedirectResultMessage(
                    args.url,
                    result.redirectUrl,
                    result.statusCode,
                  ),
                  args.format,
                ),
                args.format,
              );
            }

            const { response, finalUrl, redirectChain } = result;
            if (!response.ok) {
              try {
                await response.body?.cancel();
              } catch {
                // A failed body cancellation does not change the HTTP error.
              }
              throw new Error(
                `Request failed with status code: ${response.status}`,
              );
            }
            const headerMetadata = extractHeaderMetadata(
              response.headers,
              finalUrl,
            );
            const declaredType = headerMetadata.contentType || '';
            const explicitBinary = isBinaryContentType(declaredType);
            const genericBinaryMime = isGenericBinaryMime(declaredType);
            const binaryDownloadLimit = args.save_binary
              ? MAX_RESPONSE_BYTES
              : MAX_BINARY_DOWNLOAD_BYTES;
            const oversizedBinary =
              explicitBinary &&
              !genericBinaryMime &&
              typeof headerMetadata.contentLength === 'number' &&
              headerMetadata.contentLength > binaryDownloadLimit;
            let body = { data: new Uint8Array(), truncated: false };
            if (oversizedBinary) {
              try {
                await response.body?.cancel();
              } catch {
                // ignore cancel failures
              }
            } else {
              const readLimit =
                explicitBinary && !genericBinaryMime
                  ? binaryDownloadLimit
                  : MAX_RESPONSE_BYTES;
              body = await readBodyLimited(response, readLimit);
            }
            const baseFetch = {
              finalUrl,
              statusCode: response.status,
              ...headerMetadata,
              redirectChain,
              upgradedToHttps,
              truncated: body.truncated,
              llmsProbeError,
            };
            const provisionalDecoded =
              !oversizedBinary &&
              (!declaredType ||
                genericBinaryMime ||
                /^text\//i.test(declaredType))
                ? decodeBody(body.data, headerMetadata.charset, declaredType)
                : undefined;
            const looksHtmlPayload = provisionalDecoded
              ? looksLikeHtmlText(provisionalDecoded.text)
              : false;
            let contentType = declaredType;
            if (!contentType) {
              contentType = looksLikeTextBody(body.data)
                ? looksHtmlPayload
                  ? 'text/html'
                  : 'text/plain'
                : 'application/octet-stream';
            } else if (
              (genericBinaryMime && looksLikeTextBody(body.data)) ||
              (/^text\/plain(?:;|$)/i.test(contentType) && looksHtmlPayload)
            ) {
              contentType = looksHtmlPayload ? 'text/html' : 'text/plain';
            }
            if (isBinaryContentType(contentType)) {
              const binaryTooLarge =
                oversizedBinary ||
                body.truncated ||
                (typeof headerMetadata.contentLength === 'number' &&
                  headerMetadata.contentLength > binaryDownloadLimit);
              fetchResult = {
                ...baseFetch,
                contentType,
                canonicalUrl: finalUrl,
                binary: true,
                binaryKind: getBinaryKind(contentType),
                downloadLimitBytes: binaryDownloadLimit,
                data: binaryTooLarge ? undefined : body.data,
              };
            } else {
              const decoded =
                provisionalDecoded ||
                decodeBody(body.data, headerMetadata.charset, contentType);
              const rawText = decoded.text;
              const isHtml = isHtmlLikeContentType(contentType);
              const extracted = isHtml
                ? await extractFromHtml(rawText, finalUrl, args.extract_main)
                : (() => {
                    const cleaned = cleanFetchedText(rawText);
                    return {
                      title: undefined,
                      rawContent: cleaned,
                      html: cleaned,
                      text: cleaned,
                      markdown: cleaned,
                      extractedMain: false,
                      canonicalUrl: undefined,
                      headings: [],
                    };
                  })();
              const count = wordCount(extracted.text);
              const sourceKind = isHtml ? 'html' : 'text';
              fetchResult = {
                ...baseFetch,
                contentType,
                canonicalUrl:
                  extracted.canonicalUrl ||
                  inferCanonicalUrlFromText(extracted.markdown, finalUrl) ||
                  finalUrl,
                headings: extracted.headings?.length
                  ? extracted.headings
                  : extractHeadingsFromMarkdown(extracted.markdown),
                title: extracted.title,
                rawContent: extracted.rawContent,
                markdown: extracted.markdown,
                text: extracted.text,
                html: extracted.html,
                extractedMain: extracted.extractedMain,
                usedLlmsTxt: false,
                sourceKind,
                wordCount: count,
                qualitySignals: detectQualitySignals({
                  text: extracted.text,
                  markdown: extracted.markdown,
                  rawContent: extracted.rawContent,
                  wordCount: count,
                  sourceKind,
                  extractedMain: extracted.extractedMain,
                }),
                decodedCharset: decoded.decodedCharset,
                decodeFallback: decoded.decodeFallback,
                decodeWarning: decoded.decodeWarning,
              };
            }
          }
        }
        if (!cacheHit) CACHE.set(cacheKey, fetchResult);

        ctx.metadata({
          title:
            ('binary' in fetchResult
              ? fetchResult.filename
              : fetchResult.title) || fetchResult.finalUrl,
          metadata: {
            url: fetchResult.finalUrl,
            contentType: fetchResult.contentType,
            truncated: fetchResult.truncated,
          },
        });

        if ('binary' in fetchResult) {
          if (!fetchResult.data) {
            const metadata = args.include_metadata
              ? frontmatter({
                  requested_url: args.url,
                  final_url: fetchResult.finalUrl,
                  canonical_url: fetchResult.canonicalUrl,
                  status_code: fetchResult.statusCode,
                  source_content_type: fetchResult.contentType,
                  charset: fetchResult.charset,
                  etag: fetchResult.etag,
                  last_modified: fetchResult.lastModified,
                  content_length: fetchResult.contentLength,
                  filename: fetchResult.filename,
                  binary_kind: fetchResult.binaryKind,
                  redirect_chain: fetchResult.redirectChain.map(
                    (step: RedirectStep) =>
                      `${step.status} ${step.from} -> ${step.to}`,
                  ),
                  upgraded_to_https: fetchResult.upgradedToHttps,
                  llms_probe_error: fetchResult.llmsProbeError,
                  cache_hit: cacheHit,
                  truncated: fetchResult.truncated,
                  download_limit_bytes:
                    fetchResult.downloadLimitBytes ?? MAX_BINARY_DOWNLOAD_BYTES,
                  binary_metadata_only: true,
                })
              : '';
            return joinRenderedContent(
              metadata,
              renderMessageForFormat(
                buildBinaryResultMessage(fetchResult),
                args.format,
              ),
              args.format,
            );
          }
          if (!args.save_binary) {
            const metadata = args.include_metadata
              ? frontmatter({
                  requested_url: args.url,
                  final_url: fetchResult.finalUrl,
                  canonical_url: fetchResult.canonicalUrl,
                  status_code: fetchResult.statusCode,
                  source_content_type: fetchResult.contentType,
                  charset: fetchResult.charset,
                  etag: fetchResult.etag,
                  last_modified: fetchResult.lastModified,
                  content_length: fetchResult.contentLength,
                  filename: fetchResult.filename,
                  binary_kind: fetchResult.binaryKind,
                  redirect_chain: fetchResult.redirectChain.map(
                    (step: RedirectStep) =>
                      `${step.status} ${step.from} -> ${step.to}`,
                  ),
                  upgraded_to_https: fetchResult.upgradedToHttps,
                  truncated: fetchResult.truncated,
                  save_binary: false,
                  cache_hit: cacheHit,
                })
              : '';
            return joinRenderedContent(
              metadata,
              renderMessageForFormat(
                `${fetchResult.binaryKind.toUpperCase()} content fetched but not saved. Re-run with save_binary=true to persist it.`,
                args.format,
              ),
              args.format,
            );
          }
          const savedPath = await saveBinary(
            binaryDir,
            fetchResult.data,
            fetchResult.contentType,
            fetchResult.filename,
          );
          const metadata = args.include_metadata
            ? frontmatter({
                requested_url: args.url,
                final_url: fetchResult.finalUrl,
                canonical_url: fetchResult.canonicalUrl,
                status_code: fetchResult.statusCode,
                source_content_type: fetchResult.contentType,
                charset: fetchResult.charset,
                etag: fetchResult.etag,
                last_modified: fetchResult.lastModified,
                content_length: fetchResult.contentLength,
                filename: fetchResult.filename,
                binary_kind: fetchResult.binaryKind,
                redirect_chain: fetchResult.redirectChain.map(
                  (step: RedirectStep) =>
                    `${step.status} ${step.from} -> ${step.to}`,
                ),
                upgraded_to_https: fetchResult.upgradedToHttps,
                llms_probe_error: fetchResult.llmsProbeError,
                cache_hit: cacheHit,
                truncated: fetchResult.truncated,
                download_limit_bytes:
                  fetchResult.downloadLimitBytes ?? MAX_BINARY_DOWNLOAD_BYTES,
                saved_path: savedPath,
              })
            : '';
          return joinRenderedContent(
            metadata,
            renderMessageForFormat(
              buildBinaryResultMessage(fetchResult, savedPath),
              args.format,
            ),
            args.format,
          );
        }

        const baseContent = pickContent(fetchResult, args.format);
        const secondaryModelDecision = decideSecondaryModelUse(
          fetchResult,
          args.prompt,
          secondaryModels,
        );
        const metadata = args.include_metadata
          ? frontmatter({
              requested_url: args.url,
              final_url: fetchResult.finalUrl,
              canonical_url: fetchResult.canonicalUrl,
              status_code: fetchResult.statusCode,
              source_content_type: fetchResult.contentType,
              charset: fetchResult.charset,
              etag: fetchResult.etag,
              last_modified: fetchResult.lastModified,
              content_length: fetchResult.contentLength,
              filename: fetchResult.filename,
              headings: fetchResult.headings,
              title: fetchResult.title,
              source_kind: fetchResult.sourceKind,
              used_llms_txt: fetchResult.usedLlmsTxt,
              extracted_main: fetchResult.extractedMain,
              redirect_chain: fetchResult.redirectChain.map(
                (step: RedirectStep) =>
                  `${step.status} ${step.from} -> ${step.to}`,
              ),
              upgraded_to_https: fetchResult.upgradedToHttps,
              llms_probe_error: fetchResult.llmsProbeError,
              llms_probe_truncated:
                fetchResult.usedLlmsTxt && fetchResult.truncated,
              cache_hit: cacheHit,
              truncated: fetchResult.truncated,
              word_count: fetchResult.wordCount,
              quality_signals: fetchResult.qualitySignals,
              decoded_charset: fetchResult.decodedCharset,
              decode_fallback: fetchResult.decodeFallback,
              decode_warning: fetchResult.decodeWarning,
              secondary_model: undefined,
              secondary_model_skipped_reason:
                !secondaryModelDecision.use && args.prompt
                  ? secondaryModelDecision.reason
                  : undefined,
            })
          : '';

        if (!secondaryModelDecision.use) {
          return joinRenderedContent(metadata, baseContent, args.format);
        }

        if (!secondaryModels.length) {
          return joinRenderedContent(metadata, baseContent, args.format);
        }
        let secondaryRun:
          | Awaited<ReturnType<typeof runSecondaryModelWithFallback>>
          | undefined;
        let secondaryModelError: string | undefined;
        try {
          secondaryRun = await runSecondaryModelWithFallback(
            pluginCtx,
            secondaryModels,
            args.prompt || '',
            fetchResult.markdown,
            ctx.sessionID,
          );
        } catch (error: unknown) {
          secondaryModelError =
            error instanceof Error ? error.message : String(error);
        }

        if (!secondaryRun) {
          const degradedMetadata = args.include_metadata
            ? frontmatter({
                requested_url: args.url,
                final_url: fetchResult.finalUrl,
                canonical_url: fetchResult.canonicalUrl,
                status_code: fetchResult.statusCode,
                source_content_type: fetchResult.contentType,
                charset: fetchResult.charset,
                etag: fetchResult.etag,
                last_modified: fetchResult.lastModified,
                content_length: fetchResult.contentLength,
                filename: fetchResult.filename,
                headings: fetchResult.headings,
                title: fetchResult.title,
                source_kind: fetchResult.sourceKind,
                used_llms_txt: fetchResult.usedLlmsTxt,
                extracted_main: fetchResult.extractedMain,
                redirect_chain: fetchResult.redirectChain.map(
                  (step: RedirectStep) =>
                    `${step.status} ${step.from} -> ${step.to}`,
                ),
                upgraded_to_https: fetchResult.upgradedToHttps,
                llms_probe_error: fetchResult.llmsProbeError,
                llms_probe_truncated:
                  fetchResult.usedLlmsTxt && fetchResult.truncated,
                cache_hit: cacheHit,
                truncated: fetchResult.truncated,
                word_count: fetchResult.wordCount,
                quality_signals: fetchResult.qualitySignals,
                decoded_charset: fetchResult.decodedCharset,
                decode_fallback: fetchResult.decodeFallback,
                decode_warning: fetchResult.decodeWarning,
                secondary_model: undefined,
                secondary_model_skipped_reason: 'secondary_model_failed',
                secondary_model_error: secondaryModelError,
              })
            : '';
          return joinRenderedContent(
            degradedMetadata,
            baseContent,
            args.format,
          );
        }

        const metadataWithSecondary = args.include_metadata
          ? frontmatter({
              requested_url: args.url,
              final_url: fetchResult.finalUrl,
              canonical_url: fetchResult.canonicalUrl,
              status_code: fetchResult.statusCode,
              source_content_type: fetchResult.contentType,
              charset: fetchResult.charset,
              etag: fetchResult.etag,
              last_modified: fetchResult.lastModified,
              content_length: fetchResult.contentLength,
              filename: fetchResult.filename,
              headings: fetchResult.headings,
              title: fetchResult.title,
              source_kind: fetchResult.sourceKind,
              used_llms_txt: fetchResult.usedLlmsTxt,
              extracted_main: fetchResult.extractedMain,
              redirect_chain: fetchResult.redirectChain.map(
                (step: RedirectStep) =>
                  `${step.status} ${step.from} -> ${step.to}`,
              ),
              upgraded_to_https: fetchResult.upgradedToHttps,
              llms_probe_error: fetchResult.llmsProbeError,
              llms_probe_truncated:
                fetchResult.usedLlmsTxt && fetchResult.truncated,
              cache_hit: cacheHit,
              truncated: fetchResult.truncated,
              word_count: fetchResult.wordCount,
              quality_signals: fetchResult.qualitySignals,
              decoded_charset: fetchResult.decodedCharset,
              decode_fallback: fetchResult.decodeFallback,
              decode_warning: fetchResult.decodeWarning,
              secondary_model_input_truncated: secondaryRun.inputTruncated,
              secondary_model_input_chars: secondaryRun.inputChars,
              secondary_model_source_chars: secondaryRun.sourceChars,
              secondary_model: `${secondaryRun.model.providerID}/${secondaryRun.model.modelID}${secondaryRun.model.variant ? `#${secondaryRun.model.variant}` : ''}`,
            })
          : '';
        return joinRenderedContent(
          metadataWithSecondary,
          renderMessageForFormat(secondaryRun.text, args.format),
          args.format,
        );
      });
    },
  });
}
