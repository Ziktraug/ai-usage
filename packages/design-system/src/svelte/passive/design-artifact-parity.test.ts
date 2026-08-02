import { describe, expect, test } from 'bun:test';
import {
  type ApprovedDesignDifference,
  compareDesignArtifacts,
  type DesignArtifactSnapshot,
  findDesignArtifactDifferences,
} from './design-artifact-parity';

const fixtureCss = async (name: string): Promise<string> =>
  Bun.file(new URL(`../../../test-fixtures/passive-parity/${name}`, import.meta.url)).text();

const snapshot = (css: string, overrides: Partial<DesignArtifactSnapshot> = {}): DesignArtifactSnapshot => ({
  css,
  exports: ['aiUsagePreset', 'panel', 'statusPill'],
  tokens: {
    'colors.accent': { _dark: '#e0833c', _light: '#ac4b12' },
    'colors.canvas': { _dark: '#111113', _light: '#f6f4ef' },
  },
  ...overrides,
});

const approvalFor = (
  differences: ReturnType<typeof findDesignArtifactDifferences>,
  keyPart: string,
  classification: ApprovedDesignDifference['classification'],
): ApprovedDesignDifference => {
  const difference = differences.find((candidate) => candidate.key.includes(keyPart));
  if (!difference) {
    throw new Error(`Synthetic fixture did not produce a difference containing ${keyPart}.`);
  }
  return {
    classification,
    key: difference.key,
    kind: difference.kind,
    reason: `Synthetic ${classification} fixture.`,
    scope: difference.scope,
  };
};

describe('normalized design artifact parity', () => {
  test('normalizes formatting and comments while retaining declared layer order', async () => {
    const referenceCss = await fixtureCss('reference.css');
    const equivalentCss = referenceCss
      .replace('/* Solid reference artifact */', '')
      .replace('  .shared {\n    color: var(--colors-accent);\n  }', '.shared{color:var(--colors-accent)}');

    const evidence = compareDesignArtifacts(snapshot(referenceCss), snapshot(equivalentCss));

    expect(evidence.layerOrder).toEqual(['reset', 'base', 'tokens', 'recipes', 'utilities']);
    expect(evidence.cssRuleCount).toBe(4);
    expect(evidence.exportCount).toBe(3);
    expect(evidence.tokenCount).toBe(2);
    expect(evidence.approvedDifferences).toEqual([]);
  });

  test('requires an exact closed classification for syntax and unused-code differences', async () => {
    const reference = snapshot(await fixtureCss('reference.css'));
    const target = snapshot(await fixtureCss('target.css'));
    const differences = findDesignArtifactDifferences(reference, target);

    expect(() => compareDesignArtifacts(reference, target)).toThrow('unclassified css:missing');

    const approvals = [
      approvalFor(differences, '.solid-marker', 'framework-syntax'),
      approvalFor(differences, '.svelte-marker', 'framework-syntax'),
      approvalFor(differences, '.unused-reference', 'intentional-unused-code'),
    ];
    const evidence = compareDesignArtifacts(reference, target, approvals);

    expect(evidence.approvedDifferences).toEqual(approvals);
    expect(evidence.cssRuleCount).toBe(3);
  });

  test('rejects cascade-significant duplicate-selector rule inversion', () => {
    const reference = snapshot(
      '@layer reset, base, tokens, recipes, utilities; @layer utilities { .same { color: red; } .same { color: blue; } }',
    );
    const target = snapshot(
      '@layer reset, base, tokens, recipes, utilities; @layer utilities { .same { color: blue; } .same { color: red; } }',
    );
    const differences = findDesignArtifactDifferences(reference, target);

    expect(differences.map(({ key, kind, scope }) => `${scope}:${kind}:${key}`)).toEqual([
      'css:changed:cascade-rule-order',
    ]);
    expect(() => compareDesignArtifacts(reference, target)).toThrow('unclassified css:changed:cascade-rule-order');
    expect(() =>
      compareDesignArtifacts(reference, target, [
        {
          classification: 'framework-syntax',
          key: 'cascade-rule-order',
          kind: 'changed',
          reason: 'Cascade changes may not be classified away.',
          scope: 'css',
        },
      ]),
    ).toThrow('CSS cascade order is an exact contract');
  });

  test('preserves comment-shaped content inside quoted CSS strings', () => {
    const reference = snapshot(
      '@layer reset, base, tokens, recipes, utilities; @layer utilities { .label { content: "/* visible */"; } }',
    );
    const equivalent = snapshot(
      '/* removed comment */ @layer reset,base,tokens,recipes,utilities; @layer utilities{.label{content:"/* visible */"}}',
    );
    const missingContent = snapshot(
      '@layer reset, base, tokens, recipes, utilities; @layer utilities { .label { content: ""; } }',
    );

    expect(compareDesignArtifacts(reference, equivalent).approvedDifferences).toEqual([]);
    expect(
      findDesignArtifactDifferences(reference, missingContent).map(({ kind, scope }) => `${scope}:${kind}`),
    ).toEqual(['css:missing', 'css:unexpected']);
    expect(() => compareDesignArtifacts(reference, missingContent)).toThrow('unclassified css:missing');
  });
  test('rejects missing exports, token changes, and layer reordering without an escape hatch', async () => {
    const css = await fixtureCss('reference.css');
    const reference = snapshot(css);
    const target = snapshot(css.replace('reset, base, tokens', 'base, reset, tokens'), {
      exports: ['aiUsagePreset', 'panel'],
      tokens: {
        'colors.accent': { _dark: '#e0833c', _light: '#000000' },
        'colors.canvas': { _dark: '#111113', _light: '#f6f4ef' },
      },
    });
    const differences = findDesignArtifactDifferences(reference, target);

    expect(differences.map(({ kind, scope }) => `${scope}:${kind}`)).toEqual([
      'export:missing',
      'layer:changed',
      'token:changed',
    ]);
    expect(() =>
      compareDesignArtifacts(reference, target, [
        {
          classification: 'intentional-unused-code',
          key: 'statusPill',
          kind: 'missing',
          reason: 'Exports may not be classified away.',
          scope: 'export',
        },
      ]),
    ).toThrow('tokens, exports, and layer order are exact contracts');
  });

  test('rejects stale and duplicate approvals', async () => {
    const css = await fixtureCss('reference.css');
    const reference = snapshot(css);
    const target = snapshot(css.replace('  .unused-reference {\n    opacity: 0;\n  }\n', ''));
    const differences = findDesignArtifactDifferences(reference, target);
    const approval = approvalFor(differences, '.unused-reference', 'intentional-unused-code');

    expect(() => compareDesignArtifacts(reference, target, [approval, approval])).toThrow(
      'Duplicate approved design difference',
    );
    expect(() => compareDesignArtifacts(reference, target, [{ ...approval, key: `${approval.key}-stale` }])).toThrow(
      'stale approval',
    );
  });
});
