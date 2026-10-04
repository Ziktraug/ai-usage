import { describe, expect, test } from 'bun:test';
import {
  campaignAnchorFor,
  campaignIndexAt,
  campaignOffsets,
  campaignRestoreAnchor,
  campaignVirtualWindow,
  createCampaignAcquisitionBudget,
} from './campaign-virtual-window';

describe('campaign virtual navigation geometry', () => {
  test('keeps a logical row and offset through append, prepend, reordering and changed heights', () => {
    const keys = ['root', 'child', 'tail'];
    const heights = new Map([
      ['root', 80],
      ['child', 120],
      ['tail', 60],
    ]);
    const anchor = campaignAnchorFor(keys, campaignOffsets(keys, heights, 100), 110)!;
    expect(anchor).toEqual({ key: 'child', offset: 30 });
    const appended = [...keys, 'more'];
    expect(campaignRestoreAnchor(anchor, appended, campaignOffsets(appended, heights, 100))?.top).toBe(110);
    const prepended = ['new', ...keys];
    expect(campaignRestoreAnchor(anchor, prepended, campaignOffsets(prepended, heights, 100))?.top).toBe(210);
    const reordered = ['tail', 'root', 'child'];
    expect(campaignRestoreAnchor(anchor, reordered, campaignOffsets(reordered, heights, 100))?.top).toBe(170);
    heights.set('root', 160);
    expect(campaignRestoreAnchor(anchor, keys, campaignOffsets(keys, heights, 100))?.top).toBe(190);
    heights.set('child', 20);
    expect(campaignRestoreAnchor(anchor, keys, campaignOffsets(keys, heights, 100))).toEqual({
      anchor: { key: 'child', offset: 19 },
      top: 179,
    });
  });

  test('falls back to a surviving parent when a collapsed descendant disappears', () => {
    const before = ['project', 'campaign', 'session-a', 'session-b', 'other'];
    const after = ['project', 'campaign', 'other'];
    const offsets = campaignOffsets(after, new Map(), 100);
    expect(campaignRestoreAnchor({ key: 'session-b', offset: 35 }, after, offsets, before)).toEqual({
      anchor: { key: 'campaign', offset: 0 },
      top: 100,
    });
    expect(campaignRestoreAnchor({ key: 'project', offset: 0 }, ['other'], [0, 100], before)?.anchor.key).toBe('other');
    expect(campaignRestoreAnchor({ key: 'missing', offset: 0 }, after, offsets, before)).toBeNull();
    expect(campaignAnchorFor([], [0], 500)).toBeUndefined();
  });

  test('bounds mounted rows by the viewport and overscan after visiting many pages', () => {
    const keys = Array.from({ length: 20_000 }, (_, index) => `row-${index}`);
    const offsets = campaignOffsets(keys, new Map(), 100);
    for (const top of [0, 10_000, 800_000, 1_999_500]) {
      const window = campaignVirtualWindow(offsets, top, 500);
      expect(window.end - window.start).toBeLessThanOrEqual(14);
      expect(window.end).toBeLessThanOrEqual(keys.length);
      expect(window.start).toBeGreaterThanOrEqual(0);
    }
    expect(campaignIndexAt([0, 80, 200, 260], 80)).toBe(1);
    expect(campaignIndexAt([0, 80, 200, 260], 199)).toBe(1);
    expect(campaignVirtualWindow([0], 0, 500)).toEqual({ start: 0, end: 0 });
  });
});

describe('campaign automatic acquisition budget', () => {
  test('shares two acquisitions between timeline ranges and the end, until user advancement', () => {
    const budget = createCampaignAcquisitionBudget();
    let acquisitions = 0;
    const acquire = () => {
      acquisitions += 1;
      return true;
    };
    expect(budget.run(acquire)).toBe(true);
    expect(budget.run(acquire)).toBe(true);
    for (let layout = 0; layout < 100; layout += 1) {
      expect(budget.run(acquire)).toBe(false);
    }
    expect(acquisitions).toBe(2);
    budget.advance();
    expect(budget.run(acquire)).toBe(true);
    expect(acquisitions).toBe(3);
  });

  test('does not spend the viewport budget while the query is busy, exhausted or in error', () => {
    const budget = createCampaignAcquisitionBudget();
    for (let update = 0; update < 20; update += 1) {
      expect(budget.run(() => false)).toBe(false);
    }
    expect(budget.run(undefined)).toBe(false);
    expect(budget.run(() => true)).toBe(true);
    expect(budget.run(() => undefined)).toBe(true);
    expect(budget.run(() => true)).toBe(false);
  });

  test('fills short pages before using two lookahead pages on regular and tall viewports', () => {
    for (const viewport of [800, 2060]) {
      const budget = createCampaignAcquisitionBudget();
      let total = 80;
      let acquisitions = 0;
      const acquire = () => {
        total += 80;
        acquisitions += 1;
        return true;
      };
      for (let layout = 0; layout < 100; layout += 1) {
        budget.run(acquire, { viewport, total });
      }
      expect(total).toBeGreaterThan(viewport);
      expect(acquisitions).toBe(Math.ceil(viewport / 80) + 1);
    }
  });

  test('unchanged and collapsed projections cannot drain pages or renew their allowance', () => {
    const budget = createCampaignAcquisitionBudget();
    let acquisitions = 0;
    const acquire = () => {
      acquisitions += 1;
      return true;
    };
    for (let layout = 0; layout < 1000; layout += 1) {
      budget.run(acquire, { viewport: 800, total: 80 });
    }
    expect(acquisitions).toBe(3);
    for (let layout = 0; layout < 1000; layout += 1) {
      budget.run(acquire, { viewport: 800, total: 40 });
    }
    expect(acquisitions).toBe(3);
    budget.advance();
    expect(budget.run(acquire, { viewport: 800, total: 40 })).toBe(true);
  });

  test('bounds gradual layout changes geometrically and keeps normal pages at two acquisitions', () => {
    const budget = createCampaignAcquisitionBudget();
    let acquisitions = 0;
    const acquire = () => {
      acquisitions += 1;
      return true;
    };
    for (let total = 0; total < 800; total += 1) {
      budget.run(acquire, { viewport: 800, total });
    }
    expect(acquisitions).toBe(Math.ceil(800 / 44) + 2);
    budget.advance();
    acquisitions = 0;
    for (let total = 4000; total < 100_000; total += 1000) {
      budget.run(acquire, { viewport: 800, total });
    }
    expect(acquisitions).toBe(2);
  });
});
