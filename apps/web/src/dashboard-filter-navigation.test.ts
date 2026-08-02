import { describe, expect, test } from 'bun:test';
import { applyTimelineDimensionFilter } from './dashboard-filter-navigation';
import { type DashboardSearch, dashboardSearchDefaultsFor } from './dashboard-search';

describe('dashboard timeline filter navigation', () => {
  test('maps every timeline dimension onto its canonical search field', () => {
    const defaults = dashboardSearchDefaultsFor('cost');

    expect(applyTimelineDimensionFilter(defaults, 'campaign', 'campaign:machine:codex:root')).toMatchObject({
      filters: { campaign: 'machine:codex:root' },
    });
    expect(applyTimelineDimensionFilter(defaults, 'origin', 'human')).toMatchObject({ origin: ['human'] });
    expect(applyTimelineDimensionFilter(defaults, 'harness', 'Codex')).toMatchObject({ harness: ['Codex'] });
    expect(applyTimelineDimensionFilter(defaults, 'machine', 'machine-a')).toMatchObject({ machine: ['machine-a'] });
    expect(applyTimelineDimensionFilter(defaults, 'model', 'gpt-5')).toMatchObject({
      filters: { model: 'gpt-5' },
    });
    expect(applyTimelineDimensionFilter(defaults, 'project', 'ai-usage')).toMatchObject({
      filters: { project: 'ai-usage' },
    });
    expect(applyTimelineDimensionFilter(defaults, 'provider', 'Codex API')).toMatchObject({
      filters: { provider: 'Codex API' },
    });
  });

  test('toggles an existing exact selection and ignores invalid origin values', () => {
    const defaults = dashboardSearchDefaultsFor('cost');
    const selected: DashboardSearch = {
      ...defaults,
      filters: { campaign: 'machine:codex:root', provider: 'Codex API' },
      harness: ['Codex'],
      machine: ['machine-a'],
      origin: ['human'],
    };

    expect(applyTimelineDimensionFilter(selected, 'campaign', 'campaign:machine:codex:root').filters).toEqual({
      provider: 'Codex API',
    });
    expect(applyTimelineDimensionFilter(selected, 'harness', 'Codex').harness).toEqual([]);
    expect(applyTimelineDimensionFilter(selected, 'machine', 'machine-a').machine).toEqual([]);
    expect(applyTimelineDimensionFilter(selected, 'origin', 'human').origin).toEqual([]);
    expect(applyTimelineDimensionFilter(selected, 'origin', 'unsupported').origin).toEqual(['human']);
  });
});
