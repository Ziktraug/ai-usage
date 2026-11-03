import { expect, test } from 'bun:test';
import { promptRequestForUrl } from './prompts-model';
import { syntheticPromptCorpus } from './prompts-synthetic';

test('Claude uses the canonical harness value in the displayed synthetic search', async () => {
  const request = promptRequestForUrl(new URL('http://localhost/prompts?harness=Claude'), 'r1');
  const result = await syntheticPromptCorpus(request);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.harness).toBe('Claude');
});

test('project labels use exact case-sensitive equality in the synthetic corpus', async () => {
  for (const [label, count] of [
    ['Sample app', 2],
    ['sample app', 0],
    ['Sample', 0],
  ] as const) {
    const url = new URL('http://localhost/prompts');
    url.searchParams.set('project', label);
    const request = promptRequestForUrl(url, 'r1');
    expect(request.query.filters.fields.project).toBeUndefined();
    expect((await syntheticPromptCorpus(request)).entries).toHaveLength(count);
  }
});
