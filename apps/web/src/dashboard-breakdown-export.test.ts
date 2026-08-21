import { describe, expect, test } from 'bun:test';
import { SESSION_CAMPAIGN_EXPORT_COLUMNS } from '@ai-usage/report-core/csv';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { createSessionsExport, sessionsExportScopeLabel } from './dashboard-breakdown-export';
import { syntheticSessionRow } from './lib/features/sessions/table/session-table.fixtures';

const GENERATED_AT = '2026-08-20T18:45:00.000Z';
const campaignHeader = SESSION_CAMPAIGN_EXPORT_COLUMNS.join(',');

const campaignRow = (index: number, overrides: Partial<SessionPresentationRow> = {}): SessionPresentationRow => ({
  ...syntheticSessionRow(index),
  campaignKey: `campaign-${index}`,
  campaignTotalCount: 4,
  campaignVisibleCount: 2,
  ...overrides,
});

describe('sessions CSV export adapter', () => {
  test('emits the explicit campaign-aggregate schema and one line per loaded row', async () => {
    const rows = [campaignRow(1), campaignRow(2)];
    const { csv, filename } = await createSessionsExport(GENERATED_AT, rows);
    const lines = csv.trimEnd().split('\r\n');

    expect(lines[0]).toBe(campaignHeader);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toStartWith('campaign_aggregate,');
    expect(filename).toBe('ai-usage-sessions-2026-08-20.csv');
  });

  test('does not export root identity fields beside filtered child aggregates', async () => {
    const hybridDisplayRow = campaignRow(3, {
      harness: 'codex',
      model: 'root-model',
      project: 'root-project',
      provider: 'root-provider',
      tokIn: 4321,
    });
    const { csv } = await createSessionsExport(GENERATED_AT, [hybridDisplayRow]);
    const header = csv.split('\r\n')[0]?.split(',') ?? [];

    expect(header).not.toContain('harness');
    expect(header).not.toContain('machine');
    expect(header).not.toContain('model');
    expect(header).not.toContain('provider');
    expect(header).not.toContain('project');
    expect(header).not.toContain('session');
    expect(csv).toContain('4321');
    expect(csv).not.toContain('root-model');
    expect(csv).not.toContain('root-project');
    expect(csv).not.toContain('root-provider');
  });

  test('exports a header-only file when no rows are loaded', async () => {
    const { csv } = await createSessionsExport(GENERATED_AT, []);

    expect(csv).toBe(`${campaignHeader}\r\n`);
  });

  test('keeps formula neutralization for campaign labels', async () => {
    const dangerous = campaignRow(4, { sessionLabel: '=HYPERLINK("https://example.test")' });
    const { csv } = await createSessionsExport(GENERATED_AT, [dangerous]);
    const cells = csv.trimEnd().split('\r\n')[1]?.split(',') ?? [];
    const labelIndex = SESSION_CAMPAIGN_EXPORT_COLUMNS.indexOf('campaign_label');

    expect(cells[labelIndex]).toStartWith('"\'=HYPERLINK');
  });

  test.each([
    ['a singleton campaign', 1, 1],
    ['a fully loaded campaign', 4, 4],
    ['a partially loaded campaign', 2, 4],
  ] as const)('reports visible and total session coverage for %s', async (_case, visible, total) => {
    const { csv } = await createSessionsExport(GENERATED_AT, [
      campaignRow(6, { campaignTotalCount: total, campaignVisibleCount: visible }),
    ]);
    const cells = csv.trimEnd().split('\r\n')[1]?.split(',') ?? [];

    expect(cells[SESSION_CAMPAIGN_EXPORT_COLUMNS.indexOf('visible_sessions')]).toBe(String(visible));
    expect(cells[SESSION_CAMPAIGN_EXPORT_COLUMNS.indexOf('campaign_sessions')]).toBe(String(total));
  });

  test.each(['=', '+', '-', '@'])('neutralizes a campaign label opening with "%s"', async (marker) => {
    const dangerous = campaignRow(7, { sessionLabel: `${marker}cmd|'/C calc'!A0` });
    const { csv } = await createSessionsExport(GENERATED_AT, [dangerous]);
    const cells = csv.trimEnd().split('\r\n')[1]?.split(',') ?? [];

    expect(cells[SESSION_CAMPAIGN_EXPORT_COLUMNS.indexOf('campaign_label')]).toBe(`'${marker}cmd|'/C calc'!A0`);
  });

  test('states campaign pagination and represented session coverage in their own units', () => {
    const rows = [campaignRow(1, { campaignVisibleCount: 3 }), campaignRow(2, { campaignVisibleCount: 2 })];
    expect(sessionsExportScopeLabel(rows, 12, 47)).toBe(
      'Exports 2 of 12 campaign rows currently loaded, representing 5 of 47 filtered sessions',
    );
    expect(sessionsExportScopeLabel([], 0, 0)).toBe(
      'Exports 0 of 0 campaign rows currently loaded, representing 0 of 0 filtered sessions',
    );
  });

  test('refuses a non-campaign presentation row instead of exporting a fabricated aggregate', async () => {
    await expect(createSessionsExport(GENERATED_AT, [syntheticSessionRow(5)])).rejects.toThrow(
      'top-level campaign presentation rows',
    );
  });
});
