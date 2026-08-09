import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const overlayDirectory = dirname(fileURLToPath(import.meta.url));
const POPOVER_LABELLED_BY_PATTERN = /aria-labelledby=\{`\$\{popoverId\}-trigger`\}/u;

const readOverlay = async (name: string): Promise<string> => readFile(resolve(overlayDirectory, name), 'utf8');

describe('Svelte overlay components', () => {
  test('Drawer delegates the complete controlled focus and dismissal contract to Ark', async () => {
    const source = await readOverlay('drawer.svelte');
    for (const contract of [
      '{closeOnInteractOutside}',
      '{finalFocusEl}',
      '{initialFocusEl}',
      '{modal}',
      '{open}',
      '{trapFocus}',
      'onOpenChange(details.open)',
      '<Portal>',
      'modal !== false',
      '<Drawer.Backdrop',
      'pointer-events: auto',
      '<Drawer.Positioner>',
    ]) {
      expect(source).toContain(contract);
    }
    expect(source).toContain('prefers-reduced-motion: reduce');
  });

  test('Popover uses the native HTML popover API, SSR-safe ids, 4px gutter, focus return, dialog semantics, and live repositioning', async () => {
    const source = await readOverlay('popover.svelte');
    expect(source).toContain('popover="auto"');
    expect(source).toContain('popovertarget={popoverId}');
    expect(source).toContain('POPOVER_GUTTER_PX = 4');
    expect(source).toContain('type="button"');
    expect(source).toContain('triggerAriaLabel');
    expect(source).toContain('triggerTitle');
    expect(source).toContain('$props.id()');
    expect(source).not.toContain('Math.random');
    expect(source).toContain('role="dialog"');
    expect(source).toMatch(POPOVER_LABELLED_BY_PATTERN);
    expect(source).toContain("addEventListener('resize', onResize)");
    expect(source).toContain("addEventListener('scroll', onCaptureScroll, { capture: true, passive: true })");
    expect(source).toContain('popoverElement.getBoundingClientRect().height');
    expect(source).not.toContain('+ 200 < viewportHeight');
    expect(source).toContain('inset: auto');
    expect(source).toContain('margin: 0');
    expect(source).toContain('position: fixed');
    expect(source).toContain('new ResizeObserver');
    expect(source).toContain('resizeObserver.disconnect()');
    expect(source).toContain('max-height: calc(100vh - 8px)');
    expect(source).toContain('overflow: auto');
    expect(source).not.toContain('popoverPositionerClass');
    expect(source).not.toContain('@ark-ui');
    expect(source).not.toContain('<Portal>');
  });

  test('Tooltip is a lightweight local implementation with SSR-safe ids, 300ms delay, focusable-child aria-describedby, scroll/resize close, and portal placement', async () => {
    const source = await readOverlay('tooltip.svelte');
    expect(source).toContain('openDelay = 300');
    expect(source).toContain('content: Snippet | string');
    expect(source).toContain('role="tooltip"');
    expect(source).toContain('use:describeFocusable={isOpen ? tooltipId : null}');
    expect(source).toContain('onfocusin={onFocusIn}');
    expect(source).toContain('onmouseenter={onMouseEnter}');
    expect(source).toContain('onmouseleave={onMouseLeave}');
    expect(source).toContain('TOOLTIP_GUTTER_PX = 4');
    expect(source).toContain('use:portalElement');
    expect(source).toContain('style:pointer-events="none"');
    expect(source).toContain("addEventListener('resize', hide)");
    expect(source).toContain("addEventListener('scroll', hide, { capture: true, passive: true })");
    expect(source).toContain('$props.id()');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('aria-describedby={isOpen ? tooltipId : undefined}');
    expect(source).toContain('FOCUSABLE_SELECTOR');
    expect(source).toContain('MutationObserver');
    expect(source).toContain('new ResizeObserver');
    expect(source).toContain('resizeObserver.disconnect()');
    expect(source).not.toContain('@ark-ui');
    expect(source).not.toContain('<Portal>');
    expect(source).toContain('prefers-reduced-motion: reduce');
  });

  test('the fixture directly consumes every overlay without a feature barrel', async () => {
    const source = await readOverlay('overlay-fixture.svelte');
    expect(source).toContain("import Drawer from './drawer.svelte'");
    expect(source).toContain("import Popover from './popover.svelte'");
    expect(source).toContain("import Tooltip from './tooltip.svelte'");
    expect(source).toContain('closeOnInteractOutside={true}');
    expect(source).toContain('closeOnInteractOutside={false}');
    expect(source).toContain('modal={true}');
    expect(source).toContain('modal={false}');
    expect(source).toContain('trapFocus={true}');
    expect(source).toContain('trapFocus={false}');
    expect(source).toContain('Outside overlay target');
    expect(source).toContain('Popover fixture action');
    expect(source).toContain('<CellWithProvenance {facts}>');
  });

  test('the bounded system-Chrome proof asserts popover geometry, focusable-describedby, top-layer placement, and reposition/close', async () => {
    const source = await readOverlay('overlays.browser.ts');
    for (const contract of [
      "Bun.which('google-chrome')",
      'CHROME_LAUNCH_TIMEOUT_MS',
      'setDefaultNavigationTimeout(ACTION_TIMEOUT_MS)',
      'setDefaultTimeout(ACTION_TIMEOUT_MS)',
      'browserErrors.length',
      'Promise.allSettled',
      'getBoundingClientRect',
      "getAttribute('aria-describedby')",
      'parentElement?.tagName',
      "matches(':popover-open')",
      "window.dispatchEvent(new Event('resize'))",
      'Drawer/Popover/Tooltip focus, Escape, outside, lazy, portal, reduced-motion, provenance, and cleanup parity',
    ]) {
      expect(source).toContain(contract);
    }
    expect(source).not.toContain('outsideTarget.click({ force: true })');
  });
});
