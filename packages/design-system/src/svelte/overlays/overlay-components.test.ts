import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const overlayDirectory = dirname(fileURLToPath(import.meta.url));

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

  test('Popover remains lazy, portalled, dismissible, and positioned with a four-pixel gutter', async () => {
    const source = await readOverlay('popover.svelte');
    expect(source).toContain('lazyMount positioning={{ gutter: 4 }} unmountOnExit');
    expect(source).toContain('<Portal>');
    expect(source).toContain('type="button"');
    expect(source).toContain('triggerAriaLabel');
    expect(source).toContain('triggerTitle');
  });

  test('Tooltip keeps the 300ms default, arbitrary content, caller-owned trigger, lazy portal, and cleanup owner', async () => {
    const source = await readOverlay('tooltip.svelte');
    expect(source).toContain('openDelay = 300');
    expect(source).toContain('content: Snippet | string');
    expect(source).toContain('{@render trigger(_getTriggerProps())}');
    expect(source).not.toContain('<span');
    expect(source).toContain('lazyMount {openDelay} unmountOnExit');
    expect(source).toContain('<Portal>');
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

  test('the bounded system-Chrome proof owns error assertions and all-settled cleanup', async () => {
    const source = await readOverlay('overlays.browser.ts');
    for (const contract of [
      "Bun.which('google-chrome')",
      'CHROME_LAUNCH_TIMEOUT_MS',
      'setDefaultNavigationTimeout(ACTION_TIMEOUT_MS)',
      'setDefaultTimeout(ACTION_TIMEOUT_MS)',
      'browserErrors.length',
      'Promise.allSettled',
      'Drawer/Popover/Tooltip focus, Tab, Shift+Tab, Escape, outside, lazy, portal, reduced-motion, provenance, and cleanup parity',
    ]) {
      expect(source).toContain(contract);
    }
  });
});
