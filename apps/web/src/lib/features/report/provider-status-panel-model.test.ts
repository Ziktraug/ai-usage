import { describe, expect, test } from 'bun:test';
import type { ProviderStatusView } from './provider-status-model';
import {
  buildProviderStatusPanelSummary,
  describeProviderStatusSummary,
  detailedProviders,
  providerMachineLines,
} from './provider-status-panel-model';

const SEPARATOR_SPACING_PATTERN = /\S·|·\S/;
const CLAUSE_SEPARATOR_PATTERN = / · /;
const SUMMARY_SENTENCE_PATTERN =
  /^(\d+) providers? · (\d+) reporting a usage limit · (\d+) with no limit reading(?: \(([^)]*)\))?(?: · (\d+) critical)?(?: · \d+ with warnings)?$/;
const BREAKDOWN_COUNT_PATTERN = /(\d+) [a-z ]+/g;

const providerView = (
  input: Pick<ProviderStatusView['provider'], 'key' | 'label' | 'state'> &
    Partial<Pick<ProviderStatusView, 'machineContext' | 'nextResetAt' | 'tone' | 'worstUsedPercent'>> & {
      hasQuotaWindow?: boolean;
      /** Defaults to the label. Pass `null` to exercise a labelled observation without an id. */
      machineId?: string | null;
      warnings?: string[];
    },
): ProviderStatusView => {
  const machineId = input.machineId === null ? undefined : (input.machineId ?? input.machineContext ?? undefined);
  return {
    accountContext: null,
    creditsSummary: null,
    machineContext: input.machineContext ?? null,
    nextResetAt: input.nextResetAt ?? null,
    provider: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      key: input.key,
      label: input.label,
      source: input.state === 'unsupported' ? 'unsupported' : 'local-history',
      state: input.state,
      ...(machineId === undefined ? {} : { machineId }),
      ...(input.warnings ? { warnings: input.warnings } : {}),
      windows: [],
    },
    sourceLabel: 'Local history',
    tone: input.tone ?? 'ok',
    windowGroups: input.hasQuotaWindow
      ? [
          {
            key: '5h',
            label: '5h',
            windows: [
              {
                blocked: false,
                group: '5h',
                id: 'primary',
                label: '5h',
                limitSeconds: 18_000,
                remainingPercent: 17,
                resetsAt: input.nextResetAt ?? null,
                scope: 'global',
                usedPercent: input.worstUsedPercent ?? null,
              },
            ],
          },
        ]
      : [],
    worstUsedPercent: input.worstUsedPercent ?? null,
  };
};

const codex = providerView({
  key: 'codex',
  label: 'Codex',
  state: 'ok',
  tone: 'warning',
  hasQuotaWindow: true,
  worstUsedPercent: 83,
  nextResetAt: '2026-01-01T05:00:00.000Z',
});
const claude = providerView({ key: 'claude', label: 'Claude', state: 'unsupported', tone: 'muted' });
const cursor = providerView({
  key: 'cursor',
  label: 'Cursor',
  state: 'partial',
  tone: 'warning',
  warnings: ['No quota source', 'Account scope unknown'],
});
const opencode = providerView({
  key: 'opencode',
  label: 'OpenCode',
  state: 'error',
  tone: 'critical',
  warnings: ['Collector failed'],
});
const gemini = providerView({ key: 'gemini', label: 'Gemini', state: 'ok', tone: 'ok' });
const providers = [codex, claude, cursor, opencode, gemini];

describe('provider status panel summary', () => {
  test('partitions every provider into one reconcilable summary category', () => {
    const summary = buildProviderStatusPanelSummary(providers);

    expect(summary.quotaProviders).toEqual([codex]);
    expect(summary.criticalProvidersWithoutQuota).toEqual([opencode]);
    expect(summary.providersWithoutQuotaSource).toEqual([claude, cursor, gemini]);

    const categorizedProviders = [
      ...summary.quotaProviders,
      ...summary.criticalProvidersWithoutQuota,
      ...summary.providersWithoutQuotaSource,
    ];
    expect(categorizedProviders).toHaveLength(providers.length);
    expect(new Set(categorizedProviders).size).toBe(providers.length);
  });

  test('keeps only providers a reader can act on in the detail disclosure, in the ranked input order', () => {
    // `buildProviderStatusViews` ranks critical ahead of a provider with windows, so a detail list
    // built by concatenating the partitions would silently re-order the cards.
    const ranked = [opencode, codex, cursor, claude, gemini];
    expect(detailedProviders(buildProviderStatusPanelSummary(ranked))).toEqual([opencode, codex, cursor]);
    expect(detailedProviders(buildProviderStatusPanelSummary(providers))).toEqual([codex, cursor, opencode]);
  });

  test('describes the panel as one sentence whose counts reconcile with the total', () => {
    expect(describeProviderStatusSummary(buildProviderStatusPanelSummary(providers))).toBe(
      '5 providers · 1 reporting a usage limit · 3 with no limit reading (1 partial, 1 unsupported, 1 ok) · 1 critical · 1 with warnings',
    );
  });

  test('counts one provider seen on two machines twice, in the sentence and in its breakdown', () => {
    // Partial-data rule: the same provider on two machines is ordinary data. Counting unique labels
    // here printed "2 providers … (1 partial)" — a sentence that contradicted its own total.
    const laptopCursor = providerView({
      key: 'cursor',
      label: 'Cursor',
      machineContext: 'MacBook-Pro',
      state: 'partial',
      tone: 'warning',
    });
    const workstationCursor = providerView({
      key: 'cursor',
      label: 'Cursor',
      machineContext: 'Workstation',
      state: 'partial',
      tone: 'warning',
    });

    expect(describeProviderStatusSummary(buildProviderStatusPanelSummary([laptopCursor, workstationCursor]))).toBe(
      '2 providers · 0 reporting a usage limit · 2 with no limit reading (2 partial)',
    );
  });

  test('keeps the breakdown counts summing to the no-limit-reading count on every input', () => {
    const inputs: ProviderStatusView[][] = [
      providers,
      [
        providerView({ key: 'cursor', label: 'Cursor', machineContext: 'MacBook-Pro', state: 'partial' }),
        providerView({ key: 'cursor', label: 'Cursor', machineContext: 'Workstation', state: 'partial' }),
        providerView({ key: 'claude', label: 'Claude', machineContext: 'MacBook-Pro', state: 'unsupported' }),
        providerView({ key: 'claude', label: 'Claude', machineContext: 'Workstation', state: 'unsupported' }),
      ],
      [claude],
      [],
    ];

    for (const input of inputs) {
      const summary = buildProviderStatusPanelSummary(input);
      const sentence = describeProviderStatusSummary(summary);
      const match = sentence.match(SUMMARY_SENTENCE_PATTERN);
      expect(match).not.toBeNull();
      const [, total, withQuota, withoutSource, breakdown, critical] = match ?? [];
      expect(Number(withQuota) + Number(withoutSource) + Number(critical ?? 0)).toBe(Number(total));
      expect(Number(total)).toBe(input.length);
      const breakdownTotal = [...(breakdown ?? '').matchAll(BREAKDOWN_COUNT_PATTERN)].reduce(
        (sum, [, count]) => sum + Number(count),
        0,
      );
      expect(breakdownTotal).toBe(Number(withoutSource));
    }
  });
});

describe('providers with no limit reading, per machine', () => {
  const scopedCodex = providerView({
    key: 'codex',
    label: 'Codex',
    machineContext: 'MacBook-Pro',
    state: 'partial',
    tone: 'warning',
  });
  const scopedClaude = providerView({
    key: 'claude',
    label: 'Claude',
    machineContext: 'MacBook-Pro',
    state: 'unsupported',
    tone: 'muted',
  });
  const scopedCursor = providerView({
    key: 'cursor',
    label: 'Cursor',
    machineContext: 'MacBook-Pro',
    state: 'partial',
    tone: 'warning',
  });
  const workstationCursor = providerView({
    key: 'cursor',
    label: 'Cursor',
    machineContext: 'Workstation',
    state: 'partial',
    tone: 'warning',
  });
  const lines = providerMachineLines([scopedCodex, scopedClaude, scopedCursor, workstationCursor, gemini]);

  test('groups providers by machine and state with the unscoped group last', () => {
    expect(lines.map(({ text }) => text)).toEqual([
      'MacBook-Pro · Codex, Cursor — partial · Claude — unsupported',
      'Workstation · Cursor — partial',
      'Gemini — ok',
    ]);
    expect(lines.map(({ machineLabel }) => machineLabel)).toEqual(['MacBook-Pro', 'Workstation', null]);
    expect(new Set(lines.map(({ key }) => key)).size).toBe(lines.length);
  });

  test('keeps two machines that share a display name apart, on the stable machine id', () => {
    // Settled by `dashboard-model.test.ts` > "filters duplicate machine labels by stable machine ID":
    // the id is the identity and the repeated label is shown on both entries. Grouping on the label
    // collapsed them into one line while the sentence still counted two providers.
    const shared = (machineId: string) =>
      providerView({
        key: 'cursor',
        label: 'Cursor',
        machineContext: 'Shared machine',
        machineId,
        state: 'partial',
        tone: 'warning',
      });
    const views = [shared('machine-a'), shared('machine-b')];
    const sharedLines = providerMachineLines(views);

    expect(sharedLines.map(({ text }) => text)).toEqual([
      'Shared machine · Cursor — partial',
      'Shared machine · Cursor — partial',
    ]);
    expect(sharedLines.map(({ key }) => key)).toEqual(['machine:machine-a', 'machine:machine-b']);
    // The visible lines account for every provider the sentence counts.
    expect(sharedLines.flatMap(({ providers: grouped }) => grouped)).toHaveLength(views.length);
    expect(describeProviderStatusSummary(buildProviderStatusPanelSummary(views))).toBe(
      '2 providers · 0 reporting a usage limit · 2 with no limit reading (2 partial)',
    );
  });

  test('does not invent a shared machine identity from labels when ids are absent', () => {
    const views = [
      providerView({
        key: 'cursor',
        label: 'Cursor',
        machineContext: 'Fixture Laptop',
        machineId: null,
        state: 'partial',
      }),
      providerView({
        key: 'claude',
        label: 'Claude',
        machineContext: 'Fixture Workstation',
        machineId: null,
        state: 'unsupported',
      }),
    ];

    const unidentifiedLines = providerMachineLines(views);

    expect(unidentifiedLines.map(({ text }) => text)).toEqual([
      'Fixture Laptop · Cursor — partial',
      'Fixture Workstation · Claude — unsupported',
    ]);
    expect(new Set(unidentifiedLines.map(({ key }) => key)).size).toBe(views.length);
    expect(unidentifiedLines.flatMap(({ providers: grouped }) => grouped)).toEqual(views);
  });

  test('uses an available label for a stable machine id even when another provider omits it', () => {
    const views = [
      providerView({ key: 'cursor', label: 'Cursor', machineId: 'machine-a', state: 'partial' }),
      providerView({
        key: 'claude',
        label: 'Claude',
        machineContext: 'Fixture Machine',
        machineId: 'machine-a',
        state: 'unsupported',
      }),
    ];

    expect(providerMachineLines(views).map(({ text }) => text)).toEqual([
      'Fixture Machine · Cursor — partial · Claude — unsupported',
    ]);
  });

  test('namespaces rendered keys across stable, unscoped, and unidentified observations', () => {
    const collisionLines = providerMachineLines([
      providerView({
        key: 'cursor',
        label: 'Cursor',
        machineContext: 'Stable Fixture',
        machineId: 'unscoped',
        state: 'partial',
      }),
      providerView({
        key: 'claude',
        label: 'Claude',
        machineContext: 'Unidentified Fixture',
        machineId: null,
        state: 'unsupported',
      }),
      providerView({ key: 'gemini', label: 'Gemini', state: 'ok' }),
    ]);

    expect(collisionLines.map(({ key }) => key)).toEqual([
      'machine:unscoped',
      'observation:unidentified:1:claude',
      'scope:unscoped',
    ]);
    expect(new Set(collisionLines.map(({ key }) => key)).size).toBe(collisionLines.length);
  });

  test('keeps two providers that share a display name apart, on the provider key', () => {
    const sharedLabel = (key: string) =>
      providerView({ key, label: 'Assistant', machineContext: 'MacBook-Pro', state: 'partial', tone: 'warning' });
    const [line] = providerMachineLines([sharedLabel('vendor-a'), sharedLabel('vendor-b')]);

    expect(line?.text).toBe('MacBook-Pro · Assistant, Assistant — partial');
  });

  test('keeps a space on both sides of every separator', () => {
    for (const { text } of lines) {
      expect(text).not.toMatch(SEPARATOR_SPACING_PATTERN);
    }
    expect(lines[0]?.text).toMatch(CLAUSE_SEPARATOR_PATTERN);
  });

  test('spells a hyphenated state as words', () => {
    const [line] = providerMachineLines([
      providerView({ key: 'codex', label: 'Codex', machineContext: 'MacBook-Pro', state: 'auth-required' }),
    ]);
    expect(line?.text).toBe('MacBook-Pro · Codex — auth required');
  });
});
