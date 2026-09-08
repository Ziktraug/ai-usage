import { describe, expect, test } from 'bun:test';
import { compileMemorySearchQuery, explainMemorySearchMatch } from './ranking';

describe('Memory lexical query compilation', () => {
  test('preserves a literal while producing bounded multilingual FTS terms', () => {
    const compiled = compileMemorySearchQuery("direnv exec . bash -lc 'cd react && pnpm check'", 'hybrid');
    expect(compiled.literal).toBe("direnv exec . bash -lc 'cd react && pnpm check'");
    expect(compiled.terms).toContain('pnpm');
    expect(compiled.lexicalFtsQuery).toContain('"pnpm"*');
    expect(compiled.trigrams).toContain('pnp');
  });

  test('normalizes French accents without losing the returned excerpt', () => {
    const compiled = compileMemorySearchQuery('préférence française', 'hybrid');
    const explanations = explainMemorySearchMatch(
      {
        guidance: '',
        structuredContent: '',
        summary: 'Préférence générale de communication.',
        title: 'Mises à jour en français',
      },
      compiled,
    );
    expect(explanations).toEqual([
      { excerpt: 'Mises à jour en français', field: 'title', kind: 'prefix' },
      { excerpt: 'Préférence générale de communication.', field: 'summary', kind: 'lexical' },
    ]);
  });

  test('finds fuzzy evidence from shared trigrams without claiming exactness', () => {
    const compiled = compileMemorySearchQuery('commnad', 'hybrid');
    expect(
      explainMemorySearchMatch(
        { guidance: 'Run the command.', structuredContent: '', summary: '', title: 'Command check' },
        compiled,
      )[0],
    ).toMatchObject({ kind: 'fuzzy' });
  });
});
