import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const URL_REFERENCES_PATTERN = /\burl\b/g;
const SEARCH_READ_PATTERN = /\burl\.(?:search|searchParams)\b/;

test.each([
  ['campaigns/+page.ts', 'untrack(() => new URL(url.href))', 2],
  ['work/+page.ts', 'untrack(() => new URL(url.href))', 2],
  ['work/sessions/+page.ts', 'untrack(() => new URL(url.href))', 2],
  ['skills/+layout.ts', 'untrack(() => url.pathname)', 2],
  ['sync/+page.ts', 'await untrack(() => parent())', 0],
  ['delegation/+page.ts', 'await untrack(() => parent())', 0],
] as const)('%s keeps intent prefetch independent from search-param changes', async (file, untracked, references) => {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  expect(source).toContain(untracked);
  expect(source.match(URL_REFERENCES_PATTERN) ?? []).toHaveLength(references);
  expect(source).not.toMatch(SEARCH_READ_PATTERN);
  expect(source).not.toContain('searchParams');
  expect(source).not.toContain('createWebQueryRuntime');
  expect(source).toContain('prefetchNavigationIntent(data.queryState,');
});
