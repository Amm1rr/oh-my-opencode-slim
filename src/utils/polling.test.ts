import { describe, expect, test } from 'bun:test';
import { delay } from './polling';

describe('delay', () => {
  test('delays for specified milliseconds', async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;

    // Allow some tolerance for timing
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(100);
  });

  test('resolves without value', async () => {
    const result = await delay(10);
    expect(result).toBeUndefined();
  });

  test('can be used in promise chains', async () => {
    const result = await Promise.resolve('test')
      .then((val) => delay(10).then(() => val))
      .then((val) => val.toUpperCase());

    expect(result).toBe('TEST');
  });
});
