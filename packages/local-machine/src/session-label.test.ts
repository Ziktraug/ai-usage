import { describe, expect, test } from 'bun:test';
import {
  DERIVED_SESSION_LABEL_MAX_CHARACTERS,
  deriveSessionLabelFromPrompt,
} from '@ai-usage/local-machine/session-label';

describe('derived session labels', () => {
  test('strips context before taking the first sentence', () => {
    const prompt = `<context>
Repository: /private/work/ai-usage
Active branch: feat/private-context
</context>
Implement the portable campaign label. Preserve the existing report semantics.`;

    expect(deriveSessionLabelFromPrompt(prompt)).toBe('Implement the portable campaign label.');
  });

  test('strips pasted console logs before deriving the label', () => {
    const prompt = `\`\`\`console
$ bun test packages/local-collectors/src
2026-07-26T18:42:11.012Z ERROR codex history cache failed
at readCodexSessionCache (codex-history.ts:612:9)
\`\`\`
Repair the Codex history cache. Keep corrupt entries isolated.`;

    expect(deriveSessionLabelFromPrompt(prompt)).toBe('Repair the Codex history cache.');
  });

  test('reduces local Markdown file links to their readable mention', () => {
    const prompt =
      'Review [@plans/045-valorize-the-report-dimensions.md](file:///home/nathan/Projects/Github/ai-usage/plans/045-valorize-the-report-dimensions.md). Then implement Wave 4.';

    expect(deriveSessionLabelFromPrompt(prompt)).toBe('Review @plans/045-valorize-the-report-dimensions.md.');
  });

  test('prefers the first line below the first Markdown heading over a French preamble', () => {
    const prompt = `Tu travailles dans le repository suivant : /home/nathan/Projects/Github/ai-usage.
Lis les instructions du dépôt avant toute modification.

# Mission
Terminer en autonomie le libellé dérivé des sessions Codex.
Conserver les informations de provenance existantes.

## Vérification
Exécuter les tests ciblés.`;

    expect(deriveSessionLabelFromPrompt(prompt)).toBe('Terminer en autonomie le libellé dérivé des sessions Codex.');
  });

  test('uses the first sentence when the prompt has no Markdown heading', () => {
    expect(
      deriveSessionLabelFromPrompt('Diagnose the missing provider status. Do not change report aggregation.'),
    ).toBe('Diagnose the missing provider status.');
  });

  test('caps labels without splitting the trailing indicator', () => {
    const label = deriveSessionLabelFromPrompt(`Implement ${'portable grouping '.repeat(30)}`);

    expect(label).not.toBeNull();
    expect(label?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(DERIVED_SESSION_LABEL_MAX_CHARACTERS);
    expect(label?.endsWith('…')).toBe(true);
  });
});
