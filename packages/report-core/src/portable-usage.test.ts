import { expect, test } from 'bun:test';
import { assertPortableUsageByteLength, assertPortableUsageRowCount } from './portable-usage';

test('counts exact UTF-8 bytes and accepts exact row and byte limits', () => {
  const text = 'café 🚀';
  const bytes = new TextEncoder().encode(text).byteLength;
  expect(assertPortableUsageByteLength(text, 'Fixture', bytes)).toBe(bytes);
  expect(() => assertPortableUsageByteLength(text, 'Fixture', bytes - 1)).toThrow(
    `${bytes} bytes; maximum is ${bytes - 1}`,
  );
  expect(() => assertPortableUsageRowCount([1, 2], 'Fixture', 2)).not.toThrow();
  expect(() => assertPortableUsageRowCount([1, 2, 3], 'Fixture', 2)).toThrow('3 rows; maximum is 2');
});
