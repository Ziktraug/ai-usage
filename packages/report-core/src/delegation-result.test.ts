import { describe, expect, test } from 'bun:test';
import type {
  DelegationExecutedScope,
  DelegationFinding,
  DelegationRequest,
  DelegationReviewResult,
  FrozenDelegationScope,
} from './delegation-contracts';
import {
  buildDelegationPrompt,
  DELEGATION_OUTPUT_JSON_SCHEMA,
  DELEGATION_PROMPT_DATA_SENTENCE,
  DELEGATION_RESULT_BOUNDS,
  parseDelegationReviewResult,
  parseDelegationWorkerOutput,
} from './delegation-result';

const MORE_FILES = /- and \d+ more files not listed/u;
const FINDING: DelegationFinding = {
  detail: 'The null branch returns before the lock is released.',
  evidence: [
    { line: 42, path: 'src/lock.ts' },
    { line: null, path: 'src/lock.test.ts' },
  ],
  severity: 'major',
  title: 'Lock leaks on the null branch',
};

const review: DelegationReviewResult = {
  checks: ['read the patch', 'checked call sites with Grep'],
  coverage: { notReviewed: ['vendor/large.bin'], reviewed: 'Both source files and the test.' },
  findings: [FINDING],
  limits: ['did not run the tests'],
  summary: 'One major finding; the rest of the change reads correct.',
};

const plain = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

describe('parseDelegationReviewResult', () => {
  test('accepts the contract shape and returns a copy', () => {
    const parsed = parseDelegationReviewResult(plain(review));
    expect(parsed).toEqual(review);
    expect(parsed).not.toBe(review);
  });

  test('accepts empty findings, checks and limits and an empty notReviewed list', () => {
    expect(
      parseDelegationReviewResult({
        checks: [],
        coverage: { notReviewed: [], reviewed: '' },
        findings: [],
        limits: [],
        summary: 'Nothing to report.',
      }),
    ).toEqual({
      checks: [],
      coverage: { notReviewed: [], reviewed: '' },
      findings: [],
      limits: [],
      summary: 'Nothing to report.',
    });
  });

  test('refuses unknown keys at every level', () => {
    expect(parseDelegationReviewResult({ ...plain(review), extra: 1 })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, findings: [{ ...FINDING, confidence: 0.9 }] })).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [{ ...FINDING, evidence: [{ line: 1, path: 'a', snippet: 'x' }] }],
      }),
    ).toBeNull();
    expect(parseDelegationReviewResult({ ...review, coverage: { ...review.coverage, partial: true } })).toBeNull();
  });

  test('refuses missing keys, wrong types, unknown severities and non-positive lines', () => {
    const { summary: _summary, ...withoutSummary } = review;
    expect(parseDelegationReviewResult(withoutSummary)).toBeNull();
    expect(parseDelegationReviewResult({ ...review, summary: '' })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, summary: 42 })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, findings: [{ ...FINDING, severity: 'critical' }] })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, findings: [{ ...FINDING, title: '' }] })).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [{ ...FINDING, evidence: [{ line: 0, path: 'a' }] }],
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [{ ...FINDING, evidence: [{ line: 1.5, path: 'a' }] }],
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({ ...review, findings: [{ ...FINDING, evidence: [{ path: 'a' }] }] }),
    ).toBeNull();
    expect(parseDelegationReviewResult({ ...review, checks: ['ok', 7] })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, coverage: { notReviewed: 'none', reviewed: 'all' } })).toBeNull();
    expect(parseDelegationReviewResult(null)).toBeNull();
    expect(parseDelegationReviewResult([])).toBeNull();
    expect(parseDelegationReviewResult('{}')).toBeNull();
  });

  test('refuses control characters in single-line fields and keeps line breaks in multi-line ones', () => {
    expect(parseDelegationReviewResult({ ...review, summary: 'line one\nline two\ttabbed' })).not.toBeNull();
    expect(parseDelegationReviewResult({ ...review, summary: 'bell\u0007' })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, findings: [{ ...FINDING, title: 'two\nlines' }] })).toBeNull();
    expect(parseDelegationReviewResult({ ...review, checks: ['esc\u001b[0m'] })).toBeNull();
    expect(
      parseDelegationReviewResult({ ...review, coverage: { notReviewed: ['a\u0000'], reviewed: 'x' } }),
    ).toBeNull();
  });

  test('enforces every bound, counting arrays before walking them', () => {
    const bounds = DELEGATION_RESULT_BOUNDS;
    const finding = review.findings[0];
    if (finding === undefined) {
      throw new Error('fixture');
    }
    expect(parseDelegationReviewResult({ ...review, summary: 's'.repeat(bounds.maxSummaryCharacters) })).not.toBeNull();
    expect(parseDelegationReviewResult({ ...review, summary: 's'.repeat(bounds.maxSummaryCharacters + 1) })).toBeNull();
    expect(
      parseDelegationReviewResult({ ...review, findings: Array.from({ length: bounds.maxFindings }, () => finding) }),
    ).not.toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: Array.from({ length: bounds.maxFindings + 1 }, () => finding),
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [{ ...finding, title: 't'.repeat(bounds.maxTitleCharacters + 1) }],
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [{ ...finding, detail: 'd'.repeat(bounds.maxDetailCharacters + 1) }],
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [
          {
            ...finding,
            evidence: Array.from({ length: bounds.maxEvidencePerFinding + 1 }, () => ({ line: 1, path: 'a' })),
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        findings: [{ ...finding, evidence: [{ line: 1, path: 'p'.repeat(bounds.maxPathCharacters + 1) }] }],
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({ ...review, checks: Array.from({ length: bounds.maxChecks + 1 }, () => 'c') }),
    ).toBeNull();
    expect(parseDelegationReviewResult({ ...review, checks: ['c'.repeat(bounds.maxCheckCharacters + 1)] })).toBeNull();
    expect(
      parseDelegationReviewResult({ ...review, limits: Array.from({ length: bounds.maxLimits + 1 }, () => 'l') }),
    ).toBeNull();
    expect(parseDelegationReviewResult({ ...review, limits: ['l'.repeat(bounds.maxLimitCharacters + 1)] })).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        coverage: { notReviewed: [], reviewed: 'r'.repeat(bounds.maxCoverageReviewedCharacters + 1) },
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        coverage: { notReviewed: Array.from({ length: bounds.maxCoverageNotReviewed + 1 }, () => 'f'), reviewed: 'r' },
      }),
    ).toBeNull();
    expect(
      parseDelegationReviewResult({
        ...review,
        coverage: { notReviewed: ['f'.repeat(bounds.maxCoverageNotReviewedCharacters + 1)], reviewed: 'r' },
      }),
    ).toBeNull();
  });
});

describe('DELEGATION_OUTPUT_JSON_SCHEMA', () => {
  interface SchemaNode {
    readonly additionalProperties?: boolean;
    readonly enum?: readonly string[];
    readonly items?: SchemaNode;
    readonly maxItems?: number;
    readonly maxLength?: number;
    readonly minimum?: number;
    readonly properties?: Readonly<Record<string, SchemaNode>>;
    readonly required?: readonly string[];
    readonly type: string | readonly string[];
  }

  /** The smallest instance the schema admits: every required key, each at its emptiest valid value. */
  const sampleFrom = (node: SchemaNode): unknown => {
    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    if (type === 'object') {
      return Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, child]) => [key, sampleFrom(child)]));
    }
    if (type === 'array') {
      return node.items === undefined ? [] : [sampleFrom(node.items)];
    }
    if (type === 'string') {
      return node.enum === undefined ? 'x' : node.enum[0];
    }
    if (type === 'integer') {
      return node.minimum ?? 1;
    }
    return null;
  };

  const everyObjectIsClosed = (node: SchemaNode): boolean => {
    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    if (type === 'object') {
      const properties = node.properties ?? {};
      return (
        node.additionalProperties === false &&
        [...(node.required ?? [])].sort().join(',') === Object.keys(properties).sort().join(',') &&
        Object.values(properties).every(everyObjectIsClosed)
      );
    }
    if (type === 'array') {
      return node.items !== undefined && everyObjectIsClosed(node.items);
    }
    return true;
  };

  test('closes every object and requires every property', () => {
    expect(everyObjectIsClosed(DELEGATION_OUTPUT_JSON_SCHEMA as unknown as SchemaNode)).toBe(true);
  });

  test('an instance built from the schema satisfies the parser, and the parser accepts what the schema allows', () => {
    const sample = sampleFrom(DELEGATION_OUTPUT_JSON_SCHEMA as unknown as SchemaNode);
    expect(parseDelegationReviewResult(sample)).not.toBeNull();
    const findingSchema = DELEGATION_OUTPUT_JSON_SCHEMA.properties.findings.items;
    expect(findingSchema.properties.severity.enum).toEqual(['blocker', 'major', 'minor', 'note']);
    expect(findingSchema.properties.evidence.items.properties.line.type).toEqual(['integer', 'null']);
    expect(DELEGATION_OUTPUT_JSON_SCHEMA.properties.summary.maxLength).toBe(
      DELEGATION_RESULT_BOUNDS.maxSummaryCharacters,
    );
    expect(DELEGATION_OUTPUT_JSON_SCHEMA.properties.findings.maxItems).toBe(DELEGATION_RESULT_BOUNDS.maxFindings);
    expect(findingSchema.properties.evidence.maxItems).toBe(DELEGATION_RESULT_BOUNDS.maxEvidencePerFinding);
    expect(DELEGATION_OUTPUT_JSON_SCHEMA.properties.coverage.properties.notReviewed.maxItems).toBe(
      DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewed,
    );
  });
});

describe('parseDelegationWorkerOutput', () => {
  test('reads the whole message as the JSON object', () => {
    const output = parseDelegationWorkerOutput(`\n  ${JSON.stringify(review)}\n`);
    expect(output).toEqual({ kind: 'structured', review });
  });

  test('reads the last fenced json block and ignores prose around it', () => {
    const decoy = { ...review, summary: 'First block, superseded.' };
    const text = [
      'Here is a draft:',
      '```json',
      JSON.stringify(decoy),
      '```',
      'And the final answer:',
      '```JSON',
      JSON.stringify(review, null, 2),
      '```',
      'Done.',
    ].join('\n');
    expect(parseDelegationWorkerOutput(text)).toEqual({ kind: 'structured', review });
  });

  test('never extracts an object from prose or an unlabelled fence', () => {
    const inProse = `Result: ${JSON.stringify(review)} end`;
    expect(parseDelegationWorkerOutput(inProse)).toMatchObject({ kind: 'unstructured' });
    const unlabelled = ['```', JSON.stringify(review), '```'].join('\n');
    expect(parseDelegationWorkerOutput(unlabelled)).toMatchObject({ kind: 'unstructured' });
  });

  test('qualifies the failure and keeps a bounded, control-free excerpt', () => {
    expect(parseDelegationWorkerOutput(null)).toEqual({
      excerpt: null,
      kind: 'unstructured',
      reason: 'the worker produced no final message',
    });
    expect(parseDelegationWorkerOutput('   ')).toEqual({
      excerpt: null,
      kind: 'unstructured',
      reason: 'the worker produced no final message',
    });
    expect(parseDelegationWorkerOutput('{not json')).toMatchObject({
      excerpt: '{not json',
      kind: 'unstructured',
      reason: 'the final message is not a JSON object',
    });
    expect(parseDelegationWorkerOutput('["array"]')).toMatchObject({ kind: 'unstructured' });
    const contractBreach = parseDelegationWorkerOutput(JSON.stringify({ ...review, severity: 'x' }));
    expect(contractBreach).toMatchObject({
      kind: 'unstructured',
      reason: 'the JSON object does not satisfy the review output contract',
    });
    const fencedBreach = parseDelegationWorkerOutput(['```json', '{"summary": 1}', '```'].join('\n'));
    expect(fencedBreach).toMatchObject({
      kind: 'unstructured',
      reason: 'the JSON object does not satisfy the review output contract',
    });
    const long = `\u0007${'é'.repeat(5000)}`;
    const bounded = parseDelegationWorkerOutput(long);
    expect(bounded.kind).toBe('unstructured');
    if (bounded.kind === 'unstructured') {
      expect(bounded.excerpt?.length).toBe(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters);
      expect(bounded.excerpt).not.toContain('\u0007');
    }
    // A surrogate pair at the cut is dropped whole, never split.
    const emoji = `${'a'.repeat(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters - 1)}😀 tail`;
    const cut = parseDelegationWorkerOutput(emoji);
    if (cut.kind === 'unstructured' && cut.excerpt !== null) {
      expect(cut.excerpt.endsWith('a')).toBe(true);
      expect(cut.excerpt.length).toBe(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters - 1);
    } else {
      throw new Error('expected an unstructured excerpt');
    }
  });
});

describe('buildDelegationPrompt', () => {
  const request: DelegationRequest = {
    action: 'read-only-review',
    checkout: { path: '/home/fixture/work/project' },
    constraints: ['Do not suggest a rewrite.', 'Stay on the diff.'],
    criteria: ['Every public function keeps its contract.', 'No new unchecked error path.'],
    objective: 'Review the lock refactor for correctness.',
    schemaVersion: 1,
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  };
  const scope: FrozenDelegationScope = {
    base: 'first-parent',
    baseRef: null,
    baseSha: 'b'.repeat(40),
    commitCount: 1,
    headRef: 'HEAD',
    headSha: 'a'.repeat(40),
    kind: 'commit',
  };
  const executed: DelegationExecutedScope = {
    fileCount: 3,
    files: [
      { coverage: 'complete', path: 'src/lock.ts' },
      { coverage: 'partial', path: 'src/lock.test.ts' },
      { coverage: 'binary', path: 'docs/diagram.png' },
    ],
    includedBytes: 120,
    patchBytes: 120,
    patchSha256: 'c'.repeat(64),
    truncated: false,
    workingTreeDirty: false,
  };
  const patch = 'diff --git a/src/lock.ts b/src/lock.ts\n+const x = 1;\n';

  test('names the objective, category, criteria, constraints, frozen SHAs, coverage and output contract', () => {
    const prompt = buildDelegationPrompt({ executed, patch, request, scope, subject: 'Refactor the lock' });
    expect(prompt).toContain('Review the lock refactor for correctness.');
    expect(prompt).toContain('Task category: correctness');
    expect(prompt).toContain('- Every public function keeps its contract.');
    expect(prompt).toContain('- Do not suggest a rewrite.');
    expect(prompt).toContain(`commit ${'a'.repeat(40)} against its first parent ${'b'.repeat(40)}`);
    expect(prompt).toContain('one revision, not a branch or pull request');
    expect(prompt).toContain('"Refactor the lock"');
    expect(prompt).toContain('- src/lock.ts (complete)');
    expect(prompt).toContain('- src/lock.test.ts (partial)');
    expect(prompt).toContain('- docs/diagram.png (binary)');
    expect(prompt).toContain(DELEGATION_PROMPT_DATA_SENTENCE);
    expect(prompt).toContain('do not delegate');
    expect(prompt).toContain('coverage.notReviewed');
    expect(prompt).toContain('"blocker" | "major" | "minor" | "note"');
    expect(prompt).toContain(`<<<patch sha256=${'c'.repeat(64)}`);
    expect(prompt).toContain(patch);
    expect(prompt).toContain('>>>end of patch');
    expect(prompt).not.toContain('truncated');
    expect(prompt).not.toContain('uncommitted changes');
    // Deterministic.
    expect(buildDelegationPrompt({ executed, patch, request, scope, subject: 'Refactor the lock' })).toBe(prompt);
  });

  test('renders a long multi-line objective as its own block, line breaks and tabs kept, other control characters removed', () => {
    // 1,500 characters over ten lines (149 each plus nine newlines), with a tab inside each.
    const lines = Array.from({ length: 10 }, (_, index) => {
      const head = `Line ${index}:\t`;
      return `${head}${'o'.repeat(149 - head.length)}`;
    });
    const objective = lines.join('\n');
    expect(objective.length).toBe(1499);
    const prompt = buildDelegationPrompt({
      executed,
      patch,
      request: { ...request, objective },
      scope,
      subject: 'Refactor the lock',
    });
    // Its own block, intact: no whitespace collapse, no cut at a one-line bound.
    expect(prompt).toContain(`\nObjective:\n${objective}\nTask category: correctness\n`);
    // Control characters other than LF and TAB go; a CRLF therefore reads as LF.
    const garbled = buildDelegationPrompt({
      executed,
      patch,
      request: { ...request, objective: 'First\u0007 line\r\nSecond\tline\u001b[31m' },
      scope,
      subject: null,
    });
    expect(garbled).toContain('\nObjective:\nFirst line\nSecond\tline[31m\nTask category: correctness\n');
    expect(garbled).toContain('Head subject: "unavailable"');
  });

  test('describes a range, a root commit, a dirty working tree and a truncated patch that demands a partial review', () => {
    const range = buildDelegationPrompt({
      executed: { ...executed, truncated: true, includedBytes: 60, workingTreeDirty: true },
      patch,
      request: { ...request, scope: { base: 'main', head: 'feat', kind: 'range' } },
      scope: { ...scope, base: 'range-base', baseRef: 'main', commitCount: 4, headRef: 'feat', kind: 'range' },
      subject: null,
    });
    expect(range).toContain(`range ${'b'.repeat(40)}..${'a'.repeat(40)} (4 commits)`);
    expect(range).toContain('The patch is truncated: 60 of 120 bytes');
    expect(range).toContain('explicitly partial');
    expect(range).toContain('uncommitted changes');
    const root = buildDelegationPrompt({
      executed,
      patch,
      request,
      scope: { ...scope, base: 'empty-tree', baseSha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' },
      subject: null,
    });
    expect(root).toContain('against the empty tree (a root commit)');
  });

  test('bounds the file listing and counts the rest', () => {
    const many = buildDelegationPrompt({
      executed: {
        ...executed,
        fileCount: 2000,
        files: Array.from({ length: 2000 }, (_, index) => ({
          coverage: 'complete' as const,
          path: `src/${'segment/'.repeat(8)}file-${index}.ts`,
        })),
      },
      patch,
      request,
      scope,
      subject: null,
    });
    expect(many).toMatch(MORE_FILES);
    expect(new TextEncoder().encode(many).byteLength).toBeLessThan(40 * 1024);
  });
});
