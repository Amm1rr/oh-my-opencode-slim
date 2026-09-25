import { describe, expect, test } from 'bun:test';
import { loadJSDOM } from '../../utils/jsdom';
import {
  cleanFetchedMarkdown,
  extractFromHtml,
  extractHeadingsFromMarkdown,
  joinRenderedContent,
  withCssTreeWarningsSuppressed,
  withJsdomCssParsingErrorsSuppressed,
} from './utils';

// 200 段逗号分隔的 box-shadow 链 —— csstree/csstree#294 的复现案例，
// 稳定触发 css-tree lexer 15000 迭代上限警告（jsdom 29 + css-tree 3.2.1 已验证）。
// 若上游修复后不再触发，本测试退化为弱断言（无泄漏仍成立），可移除 helper。
const CSS_TREE_WARNING_HTML = (() => {
  const shadows: string[] = [];
  for (let i = 1; i <= 200; i++) {
    shadows.push(`${i}px 0 0 -${Math.min(i + 3, 200)}px #cfcfcf`);
  }
  return `<!DOCTYPE html><html><head><style>
.range-block__range::-webkit-slider-thumb { box-shadow: ${shadows.join(', ')}; }
</style></head><body><article><h1>Hello</h1><p>World</p></article></body></html>`;
})();

// Garbage CSS tokens that jsdom's CSS parser cannot make sense of; verified
// to emit a "css-parsing" jsdomError ("Could not parse CSS stylesheet"),
// which leaks to console.error when no custom virtualConsole is supplied.
const CSS_PARSING_ERROR_HTML = `<!DOCTYPE html><html><head>
<style>}}} ;;;; @@@</style>
</head><body><article><h1>Hello</h1><p>World</p></article></body></html>`;

describe('smartfetch/utils', () => {
  test('cleans pathological markdown in linear time', () => {
    for (const input of [' \n'.repeat(524_288), '#'.repeat(200_000)]) {
      const start = performance.now();
      cleanFetchedMarkdown(input);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });

  test('extracts cleaned headings from markdown', () => {
    const headings = extractHeadingsFromMarkdown(
      ['# Intro', '## Details ###', '### C#', 'plain text'].join('\n'),
    );

    expect(headings).toEqual(['Intro', 'Details', 'C#']);
  });

  test('injects metadata comments after an XML declaration in html output', () => {
    const result = joinRenderedContent(
      '---\nsource: "smartfetch"\n---\n\n',
      '<?xml version="1.0"?><root>ok</root>',
      'html',
    );

    expect(result).toStartWith('<?xml version="1.0"?>');
    expect(result).toContain('<!--\n---\nsource: "smartfetch"\n---\n-->');
    expect(result).toContain('<root>ok</root>');
  });

  test('suppresses css-tree warnings during html extraction', async () => {
    const originalWarn = console.warn;
    const originalError = console.error;
    const warnCalls: unknown[][] = [];
    const errorCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    console.error = (...args: unknown[]) => errorCalls.push(args);
    try {
      const result = await extractFromHtml(
        CSS_TREE_WARNING_HTML,
        'https://example.com/',
        false,
      );

      const cssTreeWarnings = warnCalls.filter((args) =>
        String(args[0]).startsWith('[csstree-match]'),
      );
      expect(cssTreeWarnings).toEqual([]);
      expect(errorCalls).toEqual([]);
      expect(result.text).toContain('Hello');
      expect(result.text).toContain('World');
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test('filters only css-tree warnings inside the guard', () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    try {
      withCssTreeWarningsSuppressed(() => {
        console.warn('[csstree-match] BREAK after 15000 iterations');
        console.warn('[smartfetch] unrelated warning');
      });

      expect(warnCalls).toEqual([['[smartfetch] unrelated warning']]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('restores the original console.warn after extraction', async () => {
    const originalWarn = console.warn;
    try {
      await extractFromHtml(
        CSS_TREE_WARNING_HTML,
        'https://example.com/',
        true,
      );

      expect(console.warn).toBe(originalWarn);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('suppresses jsdom css-parsing errors on both extraction paths', async () => {
    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => errorCalls.push(args);
    try {
      for (const extractMain of [false, true]) {
        const result = await extractFromHtml(
          CSS_PARSING_ERROR_HTML,
          'https://example.com/',
          extractMain,
        );
        expect(result.text).toContain('Hello');
      }
      expect(errorCalls).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  test('filters css-parsing errors but forwards other jsdomErrors', async () => {
    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => errorCalls.push(args);
    try {
      const { VirtualConsole } = await loadJSDOM();
      withJsdomCssParsingErrorsSuppressed((vc) => {
        vc.emit('jsdomError', {
          type: 'css-parsing',
          message: 'Could not parse CSS stylesheet',
        });
        vc.emit('jsdomError', {
          type: 'resource-loading',
          message: 'Failed to load resource',
        });
      }, VirtualConsole);

      expect(errorCalls).toHaveLength(1);
      expect((errorCalls[0][0] as Error).message).toBe(
        'Failed to load resource',
      );
    } finally {
      console.error = originalError;
    }
  });

  test('skips Readability for documents with over 15k elements', async () => {
    const html = `<html><body><article><h1>Large page</h1><p>Content</p>${'<span>x</span>'.repeat(15_001)}</article></body></html>`;
    const result = await extractFromHtml(html, 'https://example.com/', true);
    expect(result.extractedMain).toBe(false);
    expect(result.html).toBe(html);
    expect(result.text).toContain('Content');
  });
});
