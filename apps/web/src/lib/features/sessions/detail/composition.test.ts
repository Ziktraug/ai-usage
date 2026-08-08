import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

describe('P4 stable Drawer composition', () => {
  test('keeps one Drawer and final-focus owner while selection moves between neighboring rows', () => {
    const slot = source('./session-detail-query-slot.svelte');
    const drawer = source('./session-drawer.svelte');

    expect(slot).not.toContain('{#key');
    expect(slot.match(/<SessionDrawer\b/g)).toHaveLength(1);
    expect(slot.match(/createQuery\(/g)).toHaveLength(3);
    expect(slot).toContain('optionalSessionNeighborsQueryOptions');
    expect(slot).toContain('optionalSessionDetailQueryOptions');
    expect(slot).toContain('optionalSessionVcsQueryOptions');
    expect(slot).not.toContain('createSessionDetailController');
    expect(slot).not.toContain('createSessionDetailQueryOwner');
    expect(drawer.match(/const previousFocus\b/g)).toHaveLength(1);
    expect(drawer).toContain('finalFocusEl={() =>');
    expect(drawer).toContain('previousFocus instanceof HTMLElement && previousFocus.isConnected');
  });

  test('keeps the P8 campaign slot between the comparison summary and the detail grid', () => {
    const drawer = source('./session-drawer.svelte');
    const comparison = drawer.indexOf('title="Compared with the median session in the current view"');
    const campaign = drawer.indexOf('{@render campaignSlot()}');
    const detailGrid = drawer.indexOf('<div class={drawerGrid}>');

    expect(comparison).toBeGreaterThan(-1);
    expect(campaign).toBeGreaterThan(comparison);
    expect(detailGrid).toBeGreaterThan(campaign);
  });

  test('keeps phase keys collision-safe and phase bands on the selected timeline scale', () => {
    const analysis = source('./session-analysis.svelte');

    expect(analysis).toContain('phaseRenderKey(phase, index)');
    expect(analysis).toContain('phase.startAt');
    expect(analysis).toContain('phase.endAt');
    expect(analysis).toContain('index');
    expect(analysis.match(/@render renderTimelineAxis\(/g)).toHaveLength(2);
    expect(analysis.match(/scaleMode === 'wall-clock' && wallClockTrack/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
