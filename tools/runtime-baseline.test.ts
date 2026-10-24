import { expect, test } from 'bun:test';

/**
 * The root TypeScript library is ES2025 plus `ESNext.Collection`, and server-side packages call
 * `Map.prototype.getOrInsertComputed` and `RegExp.escape` directly (code that ships to the browser
 * does not). Bun 1.4 provides both; a runtime without them must fail here, not inside a scan.
 */
test('the Bun runtime provides the ES2025 and ESNext.Collection APIs the packages call', () => {
  const counts = new Map<string, number[]>();
  counts.getOrInsertComputed('a', () => []).push(1);
  counts.getOrInsertComputed('a', () => []).push(2);
  expect(counts.get('a')).toEqual([1, 2]);

  expect(new RegExp(`^${RegExp.escape('proj?.(v2)')}$`).test('proj?.(v2)')).toBe(true);
  expect(new RegExp(`^${RegExp.escape('proj?')}$`).test('pro')).toBe(false);
});
