import { describe, expect, test } from 'bun:test';
import {
  enrichSessionPresentationRow,
  parseSessionLookupServerResult,
  sessionRowIdentity,
} from '@ai-usage/report-core/session-query';
import { campaignMapFixtureRows } from '../../../campaign-map-fixture';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

describe('synthetic campaign session lookup', () => {
  test('returns canonical fixture sessions at the requested revision without reading native history', async () => {
    const client = createSyntheticCampaignClient();
    for (const row of campaignMapFixtureRows) {
      const request = { revision: 'synthetic-campaign-map-v1', rowId: sessionRowIdentity(row) };
      const result = parseSessionLookupServerResult(await client.lookup(request), request);
      expect(result).toMatchObject({
        data: { found: true, row: enrichSessionPresentationRow(row) },
        ok: true,
        revision: request.revision,
      });
      expect(await client.detail(request)).toMatchObject({ reason: 'unsupported', status: 'unavailable' });
    }
  });

  test('reports identities outside the synthetic dataset as missing', async () => {
    const request = { revision: 'synthetic-campaign-map-v1', rowId: 'not-a-fixture-session' };
    const result = parseSessionLookupServerResult(await createSyntheticCampaignClient().lookup(request), request);
    expect(result).toMatchObject({ data: { found: false, row: null }, ok: true, revision: request.revision });
  });
});
