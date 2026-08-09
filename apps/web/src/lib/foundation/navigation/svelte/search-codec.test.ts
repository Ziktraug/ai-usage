import { describe, expect, test } from 'bun:test';
import { parseTanStackSearch, stringifyTanStackSearch } from './search-codec';

describe('TanStack-compatible raw search codec', () => {
  test('parses primitives, JSON values, repeated keys, malformed JSON and unicode', () => {
    expect(
      parseTanStackSearch(
        '?empty=&truth=true&falsehood=false&count=12&decimal=1.5&text=hello+world&json=%7B%22x%22%3A1%7D&bad=%7B&tag=a&tag=2&unicode=caf%C3%A9',
      ),
    ).toEqual({
      bad: '{',
      count: 12,
      decimal: 1.5,
      empty: '',
      falsehood: false,
      json: { x: 1 },
      tag: ['a', 2],
      text: 'hello world',
      truth: true,
      unicode: 'café',
    });
  });

  test('stringifies one value per key, quotes parseable strings and omits undefined', () => {
    const value = stringifyTanStackSearch({
      array: ['a', 2],
      missing: undefined,
      object: { x: true },
      plain: 'hello world',
      quoted: '12',
    });
    const parameters = new URLSearchParams(value);
    expect(parameters.getAll('array')).toEqual(['["a",2]']);
    expect(parameters.get('object')).toBe('{"x":true}');
    expect(parameters.get('plain')).toBe('hello world');
    expect(parameters.get('quoted')).toBe('"12"');
    expect(parameters.has('missing')).toBe(false);
    expect(parseTanStackSearch(value)).toEqual({
      array: ['a', 2],
      object: { x: true },
      plain: 'hello world',
      quoted: '12',
    });
  });
});
