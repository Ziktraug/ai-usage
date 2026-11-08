import { expect, test } from 'bun:test';
import { campaignDisplayLabelFor, presentCampaignTimelineSeries } from './campaign-label-overrides';

test('campaign display keeps operator labels literal and cleans only the derived fallback once', () => {
  for (const label of ['__init__ cleanup', '**literal** &amp; notes']) {
    expect(campaignDisplayLabelFor(new Map([['campaign', label]]), 'campaign', '**Derived**')).toBe(label);
  }
  expect(campaignDisplayLabelFor(new Map(), 'campaign', '**Derived**')).toBe('Derived');
  expect(campaignDisplayLabelFor(new Map(), 'campaign', '&amp;lt;')).toBe('&lt;');
  expect(presentCampaignTimelineSeries({ key: 'campaign:campaign', label: '**Derived**' }, new Map())).toEqual({
    key: 'campaign:campaign',
    label: 'Derived',
  });
  expect(
    presentCampaignTimelineSeries(
      { key: 'campaign:campaign', label: '**Derived**' },
      new Map([['campaign', '**literal**']]),
    ),
  ).toEqual({
    key: 'campaign:campaign',
    label: '**literal**',
  });
});
