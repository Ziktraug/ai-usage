import { describe, expect, test } from 'bun:test';
import type { ProviderStatusView } from './provider-status-model';
import { buildProviderStatusPanelSummary } from './provider-status-panel-model';

const providerView = (
  input: Pick<ProviderStatusView['provider'], 'key' | 'label' | 'state'> &
    Partial<Pick<ProviderStatusView, 'nextResetAt' | 'tone' | 'worstUsedPercent'>> & {
      hasQuotaWindow?: boolean;
      warnings?: string[];
    },
): ProviderStatusView => ({
  accountContext: null,
  creditsSummary: null,
  machineContext: null,
  nextResetAt: input.nextResetAt ?? null,
  provider: {
    generatedAt: '2026-01-01T00:00:00.000Z',
    key: input.key,
    label: input.label,
    source: input.state === 'unsupported' ? 'unsupported' : 'local-history',
    state: input.state,
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
});

describe('provider status panel summary', () => {
  test('partitions every provider into one reconcilable summary category', () => {
    const codex = providerView({
      key: 'codex',
      label: 'Codex',
      state: 'ok',
      tone: 'warning',
      hasQuotaWindow: true,
      worstUsedPercent: 83,
      nextResetAt: '2026-01-01T05:00:00.000Z',
    });
    const claude = providerView({
      key: 'claude',
      label: 'Claude',
      state: 'unsupported',
      tone: 'muted',
    });
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
    const gemini = providerView({
      key: 'gemini',
      label: 'Gemini',
      state: 'ok',
      tone: 'ok',
    });

    const providers = [codex, claude, cursor, opencode, gemini];
    const summary = buildProviderStatusPanelSummary(providers);

    expect(summary.quotaProviders).toEqual([codex]);
    expect(summary.criticalProvidersWithoutQuota).toEqual([opencode]);
    expect(summary.attentionProvidersWithoutQuota).toEqual([cursor]);
    expect(summary.unsupportedProvidersWithoutQuota).toEqual([claude]);
    expect(summary.otherProvidersWithoutQuota).toEqual([gemini]);

    const categorizedProviders = [
      ...summary.quotaProviders,
      ...summary.criticalProvidersWithoutQuota,
      ...summary.attentionProvidersWithoutQuota,
      ...summary.unsupportedProvidersWithoutQuota,
      ...summary.otherProvidersWithoutQuota,
    ];
    expect(categorizedProviders).toHaveLength(providers.length);
    expect(new Set(categorizedProviders).size).toBe(providers.length);
  });
});
