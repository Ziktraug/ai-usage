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
    expect(slot).toContain('{#if drawerModule}');
    expect(slot).not.toContain('{#if selection?.row && drawerModule}');
    expect(slot.match(/createQuery\(/g)).toHaveLength(3);
    expect(slot).toContain('optionalSessionNeighborsQueryOptions');
    expect(slot).toContain('optionalSessionDetailQueryOptions');
    expect(slot).toContain('optionalSessionVcsQueryOptions');
    expect(slot).not.toContain('createSessionDetailController');
    expect(slot).not.toContain('createSessionDetailQueryOwner');
    expect(drawer.match(/let previousFocus\b/g)).toHaveLength(1);
    expect(drawer).toContain('const drawerOpen = $derived');
    expect(drawer).toContain('$effect.pre(() =>');
    expect(drawer).toContain('finalFocusEl={previousFocusElement}');
    expect(drawer).toContain('open={drawerOpen}');
    expect(drawer).toContain('previousFocus instanceof HTMLElement');
    expect(drawer).toContain('previousFocus.isConnected');
    expect(drawer).toContain('previousFocus.getClientRects().length > 0');
    expect(drawer).toContain("document.querySelectorAll<HTMLElement>('[data-session-row-id]')");
    expect(drawer).toContain('candidate.dataset.sessionRowId !== row.rowId');
    expect(drawer).toContain('candidate.getClientRects().length === 0');
    expect(drawer).toContain('openHint = null');
    expect(drawer).toContain('await Promise.all(hintExitPromises.values())');
    expect(drawer).toContain('onclick={closeDrawerAfterHints}');
  });

  test('drives one responsive Drawer as a modal sheet below md and a non-modal panel at md', () => {
    const drawer = source('./session-drawer.svelte');

    expect(drawer.match(/<Drawer\b/g)).toHaveLength(1);
    expect(drawer).toContain("new MediaQuery('(min-width: 48rem)', false)");
    expect(drawer).toContain('closeOnInteractOutside={mobileDrawer}');
    expect(drawer).toContain('modal={mobileDrawer}');
    expect(drawer).toContain('preventScroll={mobileDrawer}');
    expect(drawer).toContain('trapFocus={mobileDrawer}');
    expect(drawer).toContain('mobileDrawer ? (closeButton ?? null) : previousFocusElement()');
    expect(drawer).not.toContain('modal={false}');
    expect(drawer).not.toContain('trapFocus={false}');
  });

  test('leaves Escape from an open Drawer content to Ark while retaining global keyboard commands', () => {
    const slot = source('./session-detail-query-slot.svelte');

    expect(slot).toContain('[data-scope="drawer"][data-part="content"][data-state="open"][role="dialog"]');
    expect(slot).toContain("event.key !== 'Escape'");
    expect(slot).toContain("Pick<KeyboardEvent, 'defaultPrevented' | 'key' | 'target'>");
    expect(slot).toContain('event.defaultPrevented');
    expect(slot).toContain('escapeBelongsToActiveOverlay(event)');
    expect(slot).toContain("command === 'next'");
    expect(slot).toContain("command === 'previous'");
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
