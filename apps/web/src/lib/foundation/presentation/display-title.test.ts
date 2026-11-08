import { expect, test } from 'bun:test';
import { displayTitle, sessionDisplayTitle, withSessionDisplayTitle } from './display-title';

test('preserves ordinary coding titles', () => {
  for (const title of [
    '*.ts and *.svelte',
    'Fix glob *.ts and *.svelte',
    'Fix *test*.ts and *.ts,*.svelte',
    'a * b * c',
    '__init__.py',
    '__init__',
    'snake_case_name',
    'a == b',
    'x === y',
    'a -- b',
    'Use ## to concatenate',
    'C++',
    '?a=1&notify=1',
    '&copy=',
    String.raw`C:\Users\me\file.ts`,
    String.raw`C:\Users\me\_private\*.ts`,
  ]) {
    expect(displayTitle(title)).toBe(title);
  }
});

test('cleans explicit Markdown and well-formed common entities once', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['▸ nathan @ nixos \\~ \\>&#x20; update **Update** \\====== Log:', '▸ nathan @ nixos ~ > update Update Log:'],
    ['**bold**', 'bold'],
    ['*em*', 'em'],
    ['_em_', 'em'],
    ['# Heading', 'Heading'],
    ['## Heading\nSubtitle\n===\n`code`', 'Heading Subtitle code'],
    ['Heading\n---\nNext', 'Heading Next'],
    ['&amp; &lt; &gt; &quot; &apos; &#39; &nbsp; &#65; &#x41;', "& < > \" ' ' A A"],
    ['&#0; &#xD800; &#x110000; &#xZZ; &unknown;', '&#0; &#xD800; &#x110000; &#xZZ; &unknown;'],
    ['***', '***'],
    ['  ===  ', '==='],
  ];
  for (const [raw, plain] of cases) {
    expect(displayTitle(raw)).toBe(plain);
    expect(displayTitle(plain)).toBe(plain);
  }
});

test('decode-once takes precedence over idempotence for nested entities and escapes', () => {
  expect(displayTitle('Replace &amp;lt; with <')).toBe('Replace &lt; with <');
  expect(displayTitle(String.raw`\\*`)).toBe(String.raw`\*`);
});

test('caps processed text and falls back to non-empty source text', () => {
  expect(displayTitle('x'.repeat(10_000))).toHaveLength(500);
  expect(displayTitle(`${' '.repeat(501)}Still titled`)).toBe('Still titled');
  expect(displayTitle('### ')).toBe('###');
  expect(displayTitle('')).toBe('');
});

test('web presentation metadata preserves operator titles and avoids decoding presented labels twice', () => {
  const row = { sessionLabel: '**Native**' };
  expect(sessionDisplayTitle(row)).toBe('Native');
  for (const literal of ['__init__ cleanup', '**literal** &amp;', '&lt;']) {
    expect(sessionDisplayTitle(withSessionDisplayTitle(row, literal))).toBe(literal);
  }
  expect(row.sessionLabel).toBe('**Native**');
});
