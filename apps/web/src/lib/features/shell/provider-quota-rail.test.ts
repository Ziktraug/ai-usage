import { describe, expect, test } from 'bun:test';
import type { ProviderStatus, ProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import { buildProviderQuotaRail, providerQuotaRailIsMeasured } from './provider-quota-rail';

const NOW = '2026-08-07T12:00:00.000Z';

const status = (overrides: Partial<ProviderStatus> & Pick<ProviderStatus, 'key'>): ProviderStatus => ({
  generatedAt: NOW,
  label: overrides.key,
  source: 'live-api',
  state: 'ok',
  windows: [],
  ...overrides,
});

const window = (overrides: Partial<ProviderStatusDataset['providers'][number]['windows'][number]> = {}) => ({
  blocked: false,
  group: '5h',
  id: 'primary',
  label: '5h',
  limitSeconds: 18_000,
  remainingPercent: 29,
  resetsAt: '2026-08-07T16:40:00.000Z',
  scope: 'global' as const,
  usedPercent: 71,
  ...overrides,
});

const dataset = (providers: ProviderStatus[]): ProviderStatusDataset => ({
  generatedAt: NOW,
  providers,
  schemaVersion: 1,
});

describe('provider quota rail', () => {
  test('lists every harness in catalogue order, including the unmeasurable ones', () => {
    const entries = buildProviderQuotaRail(dataset([status({ key: 'codex', windows: [window()] })]), NOW);

    expect(entries.map((entry) => entry.key)).toEqual(['claude', 'codex', 'opencode', 'cursor']);
    expect(entries.map((entry) => entry.measured)).toEqual([false, true, false, false]);
    expect(entries[0]?.reason).toBe('No quota source');
    expect(entries[0]?.usedPercent).toBeNull();
  });

  test('reports the worst window as the headline percentage and the soonest future reset', () => {
    const entries = buildProviderQuotaRail(
      dataset([
        status({
          key: 'codex',
          windows: [
            window({ id: '5h', label: '5h', resetsAt: '2026-08-07T16:40:00.000Z', usedPercent: 71 }),
            window({ id: 'weekly', label: 'Weekly', resetsAt: '2026-08-09T00:00:00.000Z', usedPercent: 88 }),
            window({ id: 'past', label: 'Expired', resetsAt: '2026-08-01T00:00:00.000Z', usedPercent: 4 }),
          ],
        }),
      ]),
      NOW,
    );
    const codex = entries.find((entry) => entry.key === 'codex');

    expect(codex?.usedPercent).toBe(88);
    expect(codex?.nextResetAt).toBe('2026-08-07T16:40:00.000Z');
    expect(codex?.windows).toHaveLength(3);
  });

  test('turns amber at the same threshold the Overview panel uses, and red when blocked', () => {
    const severityAt = (usedPercent: number, blocked = false) =>
      buildProviderQuotaRail(
        dataset([status({ key: 'codex', windows: [window({ blocked, usedPercent })] })]),
        NOW,
      ).find((entry) => entry.key === 'codex')?.severity;

    expect(severityAt(79)).toBe('ok');
    expect(severityAt(80)).toBe('warning');
    expect(severityAt(12, true)).toBe('danger');
  });

  test('gives each window its own severity instead of the provider headline', () => {
    const entries = buildProviderQuotaRail(
      dataset([
        status({
          key: 'codex',
          windows: [
            window({ id: '5h', label: '5h', usedPercent: 12 }),
            window({ id: 'weekly', label: 'Weekly', usedPercent: 94 }),
          ],
        }),
      ]),
      NOW,
    );
    const codex = entries.find((entry) => entry.key === 'codex');

    // The provider reads as warning because of its worst window, but a barely-touched 5h allowance
    // must not inherit that alarm — the two bars have to look different.
    expect(codex?.severity).toBe('warning');
    expect(codex?.windows.map((entryWindow) => entryWindow.severity)).toEqual(['ok', 'warning']);
  });

  test('treats a sign-in failure as danger rather than an empty ring', () => {
    const entries = buildProviderQuotaRail(dataset([status({ key: 'codex', state: 'auth-required' })]), NOW);
    const codex = entries.find((entry) => entry.key === 'codex');

    expect(codex?.severity).toBe('danger');
    expect(codex?.reason).toBe('Sign in to read this quota');
    expect(codex?.measured).toBe(false);
  });

  test('prefers a head carrying windows over a bare one for the same provider', () => {
    const entries = buildProviderQuotaRail(
      dataset([
        status({ generatedAt: '2026-08-07T11:59:00.000Z', key: 'codex:laptop', machineLabel: 'MacBook' }),
        status({
          generatedAt: '2026-08-07T11:00:00.000Z',
          key: 'codex:desktop',
          machineLabel: 'Desktop',
          windows: [window()],
        }),
      ]),
      NOW,
    );
    const codex = entries.find((entry) => entry.key === 'codex');

    expect(codex?.machineLabel).toBe('Desktop');
    expect(codex?.usedPercent).toBe(71);
  });

  test('flags an aged reading and reports how old it is', () => {
    const entries = buildProviderQuotaRail(
      dataset([status({ generatedAt: '2026-08-07T11:00:00.000Z', key: 'codex', windows: [window()] })]),
      NOW,
    );
    const codex = entries.find((entry) => entry.key === 'codex');

    // Quota moves fast: a reading an hour old can be tens of points wrong, so the percentage must
    // never be presented as confidently as a live one.
    expect(codex?.stale).toBe(true);
    expect(codex?.ageMs).toBe(3_600_000);
    expect(codex?.reason).toBe('Last reading is out of date');
    expect(codex?.severity).toBe('ok');
  });

  test('leaves a fresh reading unflagged', () => {
    const entries = buildProviderQuotaRail(dataset([status({ key: 'codex', windows: [window()] })]), NOW);
    const codex = entries.find((entry) => entry.key === 'codex');

    expect(codex?.stale).toBe(false);
    expect(codex?.ageMs).toBe(0);
  });

  test('survives a missing dataset and reports that nothing is measured', () => {
    const entries = buildProviderQuotaRail(null, NOW);

    expect(entries).toHaveLength(4);
    expect(providerQuotaRailIsMeasured(entries)).toBe(false);
    expect(providerQuotaRailIsMeasured(buildProviderQuotaRail(dataset([status({ key: 'codex' })]), NOW))).toBe(false);
  });
});
