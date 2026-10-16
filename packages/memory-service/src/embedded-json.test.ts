import { expect, test } from 'bun:test';
import { DISTILLATION_JSON_MAX_DEPTH } from './distillation-redaction';
import { type JsonCandidate, scanJsonText } from './embedded-json';

// The rule the scanner must decide: JSON.parse accepts the text, and its containers nest at most
// `maxDepth` deep. In text JSON.parse accepts, every bracket outside a string opens or closes a container,
// so counting them counts the members a duplicate key hides too.
const expected = (text: string, maxDepth: number): JsonCandidate['kind'] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'none';
  }
  // The scanner finds bracketed documents only.
  if (parsed === null || typeof parsed !== 'object') {
    return 'none';
  }
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (char === ']' || char === '}') {
      depth -= 1;
    }
  }
  return deepest > maxDepth ? 'too-deep' : 'json';
};
const deep = (levels: number, inner = '1'): string => `${'['.repeat(levels)}${inner}${']'.repeat(levels)}`;
const grammar = [
  '[]',
  '{}',
  '[[]]',
  '[1,2,3]',
  '[ 1 , 2 ]',
  '[\t1\r\n]',
  '[1] ',
  '[1]\n\t',
  ' [1]',
  '\f[1]',
  ' [1]',
  '[1]\f',
  ' ',
  '{"p":"x","q":1,}',
  '{"a" 1}',
  '{"a"}',
  '{"a":}',
  '{"a"::1}',
  '{1:1}',
  '[,1]',
  '[1,]',
  '[1,,2]',
  '{,}',
  '[1 2]',
  '[1]0',
  '[01]',
  '[1.]',
  '[-]',
  '[.5]',
  '[+1]',
  '[1e]',
  '[1e+]',
  '[-0]',
  '[-01]',
  '[1E+2]',
  '[1e-400]',
  '[1e400]',
  '[-1e400]',
  `[1${'0'.repeat(400)}]`,
  '[123456789012345678901234567890]',
  '[0x1]',
  '[Infinity]',
  '[-Infinity]',
  '[NaN]',
  '[true]',
  '[tru]',
  '[truefalse]',
  '[true false]',
  '[nul]',
  '[null]',
  '[True]',
  '["é"]',
  '["\\ud800"]',
  '["\ud800"]',
  '["\\uD83D\\uDE00"]',
  '["\\u12"]',
  '["\\u12g4"]',
  '["\\x"]',
  '["\\\'"]',
  '["\\/"]',
  '["a\\nb"]',
  '["a\nb"]',
  '["\u007f"]',
  '[\f1]',
  '[ 1]',
  '{"":1}',
  '{"":1,"":2}',
  '{"a":{"":1},"a":1}',
  `{"${'k'.repeat(256)}":1}`,
  `{"${'k'.repeat(257)}":1}`,
  `{"${'k'.repeat(256)}\\u006b":1}`,
  `{"${'k'.repeat(10_000)}":1}`,
  '{"__proto__":1}',
  '{"__proto__":1,"__proto__":{"a":1}}',
  '{"a":1,"a":2}',
  '{"\\u0061":1,"a":2}',
  '{"a":[1e400],"a":1}',
  `[${'0,'.repeat(9998)}0]`,
  `[${'0,'.repeat(9999)}0]`,
  `[${'0,'.repeat(10_000)}0]`,
  `[${'{},'.repeat(20_000)}{}]`,
  '[1}',
  '{"a":1]',
  '[[1]',
  '[1]]',
  '"x"',
  '1',
  'null',
  '',
  '[',
  '{',
  '["[["]',
  '["{\\"a\\":[[[[]]]]}"]',
];
// Texts whose answer turns on the bound: nesting at, below and past it, through arrays, objects, members
// a duplicate key hides, and documents JSON.parse rejects at any depth.
const bounded = (maxDepth: number): readonly string[] => [
  deep(maxDepth - 1),
  deep(maxDepth),
  deep(maxDepth + 1),
  deep(maxDepth + 40),
  deep(maxDepth, ''),
  deep(maxDepth + 1, ''),
  `${'{"a":'.repeat(maxDepth)}1${'}'.repeat(maxDepth)}`,
  `${'{"a":'.repeat(maxDepth + 1)}1${'}'.repeat(maxDepth + 1)}`,
  `${'{"a":['.repeat(Math.ceil(maxDepth / 2))}1${']}'.repeat(Math.ceil(maxDepth / 2))}`,
  `[${deep(maxDepth - 1)},${deep(maxDepth - 2)}]`,
  `[${deep(maxDepth - 2)},${deep(maxDepth)}]`,
  `{"a":${deep(maxDepth - 1)},"b":1}`,
  `{"a":1,"b":${deep(maxDepth)}}`,
  // The deep member is dropped by JSON.parse, yet counts.
  `{"a":${deep(maxDepth)},"a":1}`,
  `{"a":1,"a":${deep(maxDepth)}}`,
  `{"a":${deep(maxDepth - 1)},"a":1}`,
  `{"\\u0061":${deep(maxDepth)},"a":1}`,
  `{"__proto__":${deep(maxDepth)},"__proto__":1}`,
  `[${deep(maxDepth)},{"a":${deep(maxDepth)},"a":[]}]`,
  // A string holding brackets is a scalar.
  `${'['.repeat(maxDepth)}"${'['.repeat(maxDepth + 1)}"${']'.repeat(maxDepth)}`,
  // Grammar errors past the bound are still not JSON.
  `${'['.repeat(maxDepth + 1)}1${']'.repeat(maxDepth)}`,
  `${'['.repeat(maxDepth + 1)}1${']'.repeat(maxDepth + 2)}`,
  `${'['.repeat(maxDepth + 1)}1,${']'.repeat(maxDepth + 1)}`,
  `${'['.repeat(maxDepth + 1)}x${']'.repeat(maxDepth + 1)}`,
];

test('decides exactly whether JSON.parse accepts a text and whether it nests within the bound', () => {
  for (const maxDepth of [2, 3, 32, DISTILLATION_JSON_MAX_DEPTH]) {
    for (const text of [...grammar, ...bounded(maxDepth)]) {
      expect([maxDepth, text.slice(0, 40), scanJsonText(text, maxDepth)]).toEqual([
        maxDepth,
        text.slice(0, 40),
        expected(text, maxDepth),
      ]);
    }
  }
});

test('tells documents within the bound from the ones past it and from text that is not JSON', () => {
  expect(scanJsonText(deep(256), 256)).toBe('json');
  expect(scanJsonText(deep(257), 256)).toBe('too-deep');
  expect(scanJsonText(deep(60_000), 256)).toBe('too-deep');
  expect(scanJsonText(`${deep(257)}]`, 256)).toBe('none');
  expect(scanJsonText('{"a":[[[]]],"a":1}', 3)).toBe('too-deep');
  expect(scanJsonText('{"a":[[]],"a":1}', 3)).toBe('json');
  expect(scanJsonText('[]', 0)).toBe('too-deep');
});
