import { describe, expect, test } from 'bun:test';
import { buildCampaignChronology, type SessionPageItem } from '@ai-usage/report-core/session-query';
import { campaignMapFixtureGeneratedAt } from '../../../campaign-map-fixture';
import { dashboardSearchDefaultsFor, validateDashboardSearch } from '../../../dashboard-search';
import { barForInterval, buildCampaignTimeline } from './campaign-timeline-model';
import { campaignProjectSegments } from './campaign-timeline-projection';
import { campaignsRequest } from './campaigns-query';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

const instant = (clock: string): string => `2026-06-11T${clock}:00.000Z`;
const epoch = (clock: string): number => Date.parse(instant(clock));
const allHistory = { from: null, to: null };

const fixtureItems = async (): Promise<SessionPageItem[]> => {
  const result = await createSyntheticCampaignClient().page(
    campaignsRequest(
      validateDashboardSearch({ range: 'all' }, dashboardSearchDefaultsFor('date')),
      campaignMapFixtureGeneratedAt,
      'timeline-revision',
    ),
  );
  if (!result.ok) {
    throw new Error('The synthetic campaign page must be available');
  }
  return result.data.items;
};

describe('project campaign timeline', () => {
  test('appends continuations without inserting campaigns into previously traversed project segments', async () => {
    const template = (await fixtureItems())[0]!;
    const items = Array.from(
      { length: 120 },
      (_, index): SessionPageItem => ({
        ...template,
        campaignKey: `campaign-${index}`,
        row: { ...template.row, projectKey: `project-${index % 12}` },
      }),
    );
    const pages = [items.slice(0, 40), items.slice(40, 80), items.slice(80)];
    const project = (count: number) =>
      campaignProjectSegments(
        buildCampaignTimeline(pages.slice(0, count).flat(), allHistory),
        pages.slice(0, count).map((entries) => entries.map((item) => item.campaignKey)),
      );
    const keys = (count: number) =>
      project(count).flatMap((segment) => [
        segment.key,
        ...segment.project.campaigns.map((campaign) => campaign.item.campaignKey),
      ]);
    const first = keys(1);
    const second = keys(2);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(keys(3).slice(0, second.length)).toEqual(second);
    expect(project(3).flatMap((segment) => segment.project.campaigns)).toHaveLength(120);
    expect(new Set(keys(3)).size).toBe(keys(3).length);
    expect(project(3).filter((segment) => segment.continuation)).toHaveLength(24);
  });
  test('places projects and complete campaign spans on one scale and retains one-sided timing as a point', async () => {
    const items = await fixtureItems();
    const result = buildCampaignTimeline(items, allHistory);
    expect(result.loadedCampaignCount).toBe(4);
    expect(result.groups).toHaveLength(3);
    expect(result.axis).toMatchObject({ startMs: epoch('06:45'), endMs: epoch('09:20') });
    expect(
      result.groups
        .flatMap((group) => group.campaigns)
        .map(({ timing }) => timing)
        .sort(),
    ).toEqual(['complete', 'complete', 'complete', 'partial']);
    const partial = result.groups.flatMap((group) => group.campaigns).find(({ timing }) => timing === 'partial');
    expect(partial?.bar).toMatchObject({ point: true, widthPercent: 0 });
    expect(buildCampaignTimeline(items.toReversed(), allHistory)).toEqual(result);
  });

  test('groups by canonical project identity and leaves idle gaps between campaigns', async () => {
    const template = (await fixtureItems())[0]!;
    const item = (key: string, projectKey: string, start: string, end: string): SessionPageItem => ({
      ...template,
      campaignKey: key,
      row: { ...template.row, projectKey, projectLabel: 'Same project label' },
      chronology: buildCampaignChronology([{ date: instant(start), endDate: instant(end) }]),
    });
    const result = buildCampaignTimeline(
      [
        item('a', 'project-a', '08:00', '08:20'),
        item('b', 'project-a', '08:40', '09:00'),
        item('c', 'project-b', '08:10', '08:30'),
      ],
      allHistory,
    );
    expect(result.groups).toHaveLength(2);
    expect(result.groups.find((group) => group.projectKey === 'project-a')?.bars).toHaveLength(2);
    expect(result.groups.find((group) => group.projectKey === 'project-b')?.bars).toHaveLength(1);
  });

  test('clips loaded campaign bounds to the displayed discovery period and flags clipped edges', async () => {
    const template = (await fixtureItems())[0]!;
    const result = buildCampaignTimeline(
      [{ ...template, chronology: buildCampaignChronology([{ date: instant('06:00'), endDate: instant('12:00') }]) }],
      { from: instant('08:00'), to: instant('10:00') },
    );
    expect(result.axis).toMatchObject({ startMs: epoch('08:00'), endMs: epoch('10:00') });
    expect(result.groups[0]?.campaigns[0]?.bar).toEqual({
      clippedStart: true,
      clippedEnd: true,
      leftPercent: 0,
      widthPercent: 100,
      point: false,
    });
    expect(barForInterval(epoch('07:00'), epoch('07:30'), result.axis)).toBeNull();
    expect(barForInterval(epoch('08:30'), epoch('09:00'), result.axis)).toMatchObject({
      leftPercent: 25,
      widthPercent: 25,
    });
  });

  test('keeps timing quality through project unions and leaves complete bands across real gaps', async () => {
    const template = (await fixtureItems())[0]!;
    const item = (key: string, start: string, end: string, partial: boolean): SessionPageItem => ({
      ...template,
      campaignKey: key,
      chronology: buildCampaignChronology([
        { date: instant(start), endDate: instant(end) },
        ...(partial ? [{ date: null, endDate: null }] : []),
      ]),
    });
    const complete = item('complete', '08:00', '08:20', false);
    const partial = item('partial', '08:10', '08:40', true);
    expect(buildCampaignTimeline([complete], allHistory).groups[0]?.bars[0]).toMatchObject({ timing: 'complete' });
    expect(buildCampaignTimeline([partial], allHistory).groups[0]?.bars[0]).toMatchObject({ timing: 'partial' });
    const mixed = buildCampaignTimeline([complete, partial, item('after-gap', '09:00', '09:20', false)], allHistory);
    expect(mixed.groups[0]?.bars).toHaveLength(2);
    expect(mixed.groups[0]?.bars.map(({ timing }) => timing)).toEqual(['partial', 'complete']);
  });

  test('fixes finite periods and retains a fitted all-history axis while older pages append', async () => {
    const template = (await fixtureItems())[0]!;
    const recent = {
      ...template,
      chronology: buildCampaignChronology([{ date: instant('08:00'), endDate: instant('09:00') }]),
    };
    const older = {
      ...template,
      campaignKey: 'older',
      chronology: buildCampaignChronology([{ date: instant('06:00'), endDate: instant('07:00') }]),
    };
    const range = { from: instant('05:00'), to: instant('10:00') };
    const finite = buildCampaignTimeline([recent], range);
    expect(finite.axis).toMatchObject({ startMs: epoch('05:00'), endMs: epoch('10:00') });
    expect(buildCampaignTimeline([recent, older], range).axis).toEqual(finite.axis);
    expect(buildCampaignTimeline([], range).axis).toEqual(finite.axis);
    const fitted = buildCampaignTimeline([recent], allHistory);
    const appended = buildCampaignTimeline([recent, older], allHistory, fitted.axis);
    expect(appended.axis).toBe(fitted.axis);
    expect(appended.groups[0]?.campaigns.find(({ item }) => item.campaignKey === recent.campaignKey)?.bar).toEqual(
      fitted.groups[0]?.campaigns[0]?.bar,
    );
    expect(appended.groups[0]?.campaigns.find(({ item }) => item.campaignKey === 'older')).toMatchObject({
      bar: null,
      outsideRange: true,
    });
    expect(buildCampaignTimeline([recent, older], allHistory).axis).toMatchObject({
      startMs: epoch('06:00'),
      endMs: epoch('09:00'),
    });
  });

  test('does not invent an axis for unknown, invalid, or entirely out-of-period timing', async () => {
    const template = (await fixtureItems())[0]!;
    const unavailable = { ...template, chronology: buildCampaignChronology([{ date: null, endDate: null }]) };
    const unknown = buildCampaignTimeline([unavailable], allHistory);
    expect(unknown.axis).toBeNull();
    expect(unknown.groups[0]?.campaigns[0]).toMatchObject({ bar: null, timing: 'unavailable', outsideRange: false });
    const outside = buildCampaignTimeline([template], { from: '2027-01-01T00:00:00.000Z', to: null });
    expect(outside.axis).toBeNull();
    expect(outside.groups[0]?.campaigns[0]?.outsideRange).toBe(true);
    const axis = { startMs: epoch('08:00'), endMs: epoch('09:00'), ticks: [] };
    expect(barForInterval(Number.NaN, epoch('09:00'), axis)).toBeNull();
    expect(barForInterval(epoch('09:00'), epoch('08:00'), axis)).toBeNull();
  });

  test('keeps zero-length spans finite and distinguishes dates across midnight', async () => {
    const template = (await fixtureItems())[0]!;
    const point = buildCampaignTimeline(
      [{ ...template, chronology: buildCampaignChronology([{ date: instant('08:00'), endDate: instant('08:00') }]) }],
      allHistory,
    );
    expect(point.axis?.ticks).toHaveLength(1);
    expect(point.groups[0]?.bars[0]).toMatchObject({ leftPercent: 0, widthPercent: 0, point: true });
    const overnight = buildCampaignTimeline(
      [
        {
          ...template,
          chronology: buildCampaignChronology([{ date: instant('23:00'), endDate: '2026-06-12T01:00:00.000Z' }]),
        },
      ],
      allHistory,
    );
    expect(overnight.axis?.ticks.map(({ label }) => label)).toEqual(['06-11 23:00', '06-12 00:00', '06-12 01:00']);
  });
});
