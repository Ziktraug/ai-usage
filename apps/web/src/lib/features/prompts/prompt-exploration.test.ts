import { describe, expect, test } from 'bun:test';
import { analyzePrompts, type ExplorationPrompt, followingPrompts, motifBreakdown } from './prompt-exploration';

const prompt = (id: string, sessionId: string, text: string, ordinal = 0, project = 'demo'): ExplorationPrompt => ({
  at: '2026-10-01T10:00:00Z',
  harness: 'Codex',
  id,
  ordinal,
  partial: false,
  project,
  rowId: sessionId,
  sessionId,
  text,
});

describe('bounded prompt exploration', () => {
  test('counts distinct sessions and never treats repeated prompts in one session as prevalence', () => {
    const entries = [
      prompt('a', 'one', 'Review this branch'),
      prompt('b', 'one', 'Review this branch', 1),
      prompt('c', 'two', 'Review this branch'),
    ];
    const result = analyzePrompts(entries);
    const motif = result.motifs.find((candidate) => candidate.text === 'review this branch');
    expect(motif?.sessions).toBe(2);
    expect(motif?.entries).toHaveLength(3);
    expect(result.sessions).toBe(2);
  });
  test('does not learn code, slash commands or injected context as a practice', () => {
    const text = '<environment_context>review this branch</environment_context>\n```ts\nreview this branch\n```';
    expect(analyzePrompts([prompt('a', 'one', text), prompt('b', 'two', text)]).motifs).toEqual([]);
    expect(analyzePrompts([prompt('a', 'one', '/review'), prompt('b', 'two', '/review')]).excluded).toBe(2);
  });
  test('deduplicates loaded pages and reports its own analysis budget', () => {
    const entry = prompt('a', 'one', 'Review this branch');
    const result = analyzePrompts([
      entry,
      entry,
      ...Array.from({ length: 510 }, (_, i) => prompt(String(i), `s${i}`, 'Review this branch')),
    ]);
    expect(result.analyzed).toBe(500);
    expect(result.omitted).toBe(11);
    expect(result.motifs[0]?.sessions).toBe(500);
  });
  test('only calls adjacent native ordinals following prompts, and never crosses sessions', () => {
    const start = prompt('a', 'one', 'Review', 2);
    const entries = [
      start,
      prompt('b', 'one', 'Fix', 3),
      prompt('c', 'one', 'Ship', 5),
      prompt('d', 'two', 'Other', 3),
    ];
    expect(followingPrompts(start, entries).map((entry) => entry.id)).toEqual(['b']);
  });
  test('project denominators include all loaded sessions and periods use UTC calendar weeks', () => {
    const entries = [
      prompt('a', 'one', 'Review this branch'),
      prompt('b', 'two', 'Review this branch'),
      prompt('c', 'three', 'Unrelated request'),
    ];
    const result = analyzePrompts(entries);
    const motif = result.motifs[0];
    expect(motif).toBeDefined();
    if (!motif) {
      throw new Error('Fixture motif missing');
    }
    expect(motifBreakdown(motif, result.entries).projects).toEqual([{ matched: 2, name: 'demo', total: 3 }]);
    expect(result.weeks).toEqual([{ name: '2026-09-28', prompts: 3, sessions: 3 }]);
  });
});
