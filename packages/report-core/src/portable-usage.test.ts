import { expect, test } from 'bun:test';
import {
  assertPortableUsageByteLength,
  assertPortableUsageRowCount,
  assertPortableUsageTopLevelRowsPreflight,
} from './portable-usage';

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

test('preflights the top-level rows array before JSON parsing', () => {
  expect(() => assertPortableUsageTopLevelRowsPreflight('{"rows":[{},{}]}', 'Fixture', 2)).not.toThrow();
  expect(() => assertPortableUsageTopLevelRowsPreflight('{"rows":[{},{},{}]}', 'Fixture', 2)).toThrow(
    'more than 2 rows; maximum is 2',
  );
  expect(() =>
    assertPortableUsageTopLevelRowsPreflight('{"r\\u006fws":[{"nested":[1,2]},{"text":"},[,]"}]}', 'Fixture', 2),
  ).not.toThrow();
  expect(() =>
    assertPortableUsageTopLevelRowsPreflight(
      '{"metadata":{"rows":[{},{},{}]},"r\\u006fws":[{"nested":[1,2]},{"text":"},[,]"},null]}',
      'Fixture',
      2,
    ),
  ).toThrow('more than 2 rows; maximum is 2');
  expect(() => assertPortableUsageTopLevelRowsPreflight('{"rows":[],"rows":[{},{}]}', 'Duplicate fixture', 1)).toThrow(
    'Duplicate fixture contains more than 1 rows; maximum is 1',
  );
  expect(() =>
    assertPortableUsageTopLevelRowsPreflight('{"rows":[],"r\\u006fws":[{},{}]}', 'Escaped duplicate fixture', 1),
  ).toThrow('Escaped duplicate fixture contains more than 1 rows; maximum is 1');
});
