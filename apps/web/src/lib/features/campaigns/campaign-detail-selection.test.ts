import { describe, expect, test } from 'bun:test';
import {
  enrichSessionPresentationRow,
  sessionCampaignIdentityForRow,
  sessionLookupFingerprint,
} from '@ai-usage/report-core/session-query';
import { campaignMapFixtureRows } from '../../../campaign-map-fixture';
import { resolveCampaignDetailSelection } from './campaign-detail-selection';

const rows = campaignMapFixtureRows.map(enrichSessionPresentationRow);
const row = rows[0];
if (!row) {
  throw new Error('Campaign fixture needs a session');
}
const input = {
  campaignKey: sessionCampaignIdentityForRow(row).campaignKey,
  knownRevision: 'revision-a',
  knownRows: [],
  lookup: undefined,
  revision: 'revision-a',
  rowId: row.rowId,
};
const lookup = {
  requestFingerprint: sessionLookupFingerprint({ revision: 'revision-a', rowId: row.rowId }),
  revision: 'revision-a',
  row,
};

describe('campaign detail selection', () => {
  test('uses a known canonical row without requiring a lookup', () => {
    expect(resolveCampaignDetailSelection({ ...input, knownRows: [row] })).toEqual({
      kind: 'open',
      selection: {
        revision: 'revision-a',
        row,
        target: { kind: 'session', reportRowId: row.rowId, summaryRow: row },
      },
    });
  });

  test('opens a distant session from one exact lookup without requiring acquired member pages', () => {
    expect(resolveCampaignDetailSelection(input)).toEqual({ kind: 'loading' });
    const result = resolveCampaignDetailSelection({ ...input, lookup });
    expect(result).toMatchObject({ kind: 'open', selection: { revision: 'revision-a', row } });
  });

  test('never applies a late response for A after the URL selected B', () => {
    expect(
      resolveCampaignDetailSelection({
        ...input,
        lookup,
        rowId: 'another-session',
      }),
    ).toEqual({ kind: 'loading' });
  });

  test('never reports B missing from a late not-found response for A', () => {
    expect(
      resolveCampaignDetailSelection({ ...input, lookup: { ...lookup, row: null }, rowId: 'another-session' }),
    ).toEqual({ kind: 'loading' });
  });

  test('does not relabel retained lookup or acquired rows with a replacement revision', () => {
    expect(
      resolveCampaignDetailSelection({
        ...input,
        knownRows: [row],
        lookup,
        revision: 'revision-b',
      }),
    ).toEqual({ kind: 'loading' });
  });

  test('reports missing sessions and rejects a session from a different campaign', () => {
    expect(resolveCampaignDetailSelection({ ...input, lookup: { ...lookup, row: null } })).toEqual({
      kind: 'missing',
    });
    expect(
      resolveCampaignDetailSelection({
        ...input,
        campaignKey: 'another-campaign',
        lookup,
      }),
    ).toEqual({ kind: 'missing' });
  });

  test('closes immediately when the URL no longer selects a session', () => {
    expect(resolveCampaignDetailSelection({ ...input, lookup, rowId: '' })).toEqual({
      kind: 'closed',
    });
  });
});
