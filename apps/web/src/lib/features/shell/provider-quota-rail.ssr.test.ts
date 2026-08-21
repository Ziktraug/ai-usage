import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { buildProviderQuotaRail, type ProviderQuotaRailEntry } from './provider-quota-rail';

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Provider quota rail did not expose a Svelte component.');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());

const [railModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/shell/provider-quota-rail.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const ProviderQuotaRail = componentFrom(railModule);
const { render } = rendererFrom(svelteServerModule);

const NOW = '2026-08-07T12:00:00.000Z';

const measuredEntries = (): ProviderQuotaRailEntry[] =>
  buildProviderQuotaRail(
    {
      generatedAt: NOW,
      providers: [
        {
          generatedAt: NOW,
          key: 'codex',
          label: 'Codex',
          plan: 'Plus',
          source: 'live-api',
          state: 'ok',
          windows: [
            {
              blocked: false,
              group: '5h',
              id: '5h',
              label: '5h',
              limitSeconds: 18_000,
              remainingPercent: 29,
              resetsAt: '2026-08-07T16:40:00.000Z',
              scope: 'global',
              usedPercent: 71,
            },
          ],
        },
      ],
      schemaVersion: 1,
    },
    NOW,
  );

const CLASS_ATTRIBUTE_PATTERN = /class="([^"]*)"/;
const COMPACT_VALUE_MARKER = 'data-provider-quota-compact-value';
const SVELTE_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

interface RenderedSlot {
  readonly classes: string;
  readonly text: string;
}

/**
 * Each compact-value element with its own classes and its own text. Scoping to the element matters:
 * the labelled `xl` value and the flyout repeat the same percentage later in the document, so a
 * whole-document `toContain('71%')` would pass even if every compact span rendered empty.
 */
const compactValueSlots = (html: string): RenderedSlot[] => {
  const slots: RenderedSlot[] = [];
  let searchFrom = 0;
  for (;;) {
    const markerIndex = html.indexOf(COMPACT_VALUE_MARKER, searchFrom);
    if (markerIndex < 0) {
      return slots;
    }
    const tagStart = html.lastIndexOf('<', markerIndex);
    const tagEnd = html.indexOf('>', markerIndex);
    const closeIndex = html.indexOf('</span>', tagEnd);
    slots.push({
      classes: CLASS_ATTRIBUTE_PATTERN.exec(html.slice(tagStart, tagEnd))?.[1] ?? '',
      text: html
        .slice(tagEnd + 1, closeIndex)
        .replaceAll(SVELTE_COMMENT_PATTERN, '')
        .trim(),
    });
    searchFrom = closeIndex + 1;
  }
};

const renderRail = (entries: ProviderQuotaRailEntry[]): string =>
  render(ProviderQuotaRail, { props: { entries } }).body;

describe('rendered provider quota rail', () => {
  test('renders one slot per provider with the measured percentage in the first paint', () => {
    const html = renderRail(measuredEntries());

    expect(html).toContain('data-provider-quota-rail');
    for (const key of ['claude', 'codex', 'opencode', 'cursor']) {
      expect(html).toContain(`data-provider-quota="${key}"`);
    }
    expect(html).toContain('71%');
    expect(html).toContain('resets');
  });

  test('states which direction the percentage runs, in both the heading and each window', () => {
    const html = renderRail(measuredEntries());

    // A bare "71%" beside a ring is ambiguous: some providers publish what is left, not what is used.
    expect(html).toContain('Quota used');
    expect(html).toContain('29% left');
  });

  test('ships the detail flyout collapsed rather than absent, so hover has nothing to fetch', () => {
    const html = renderRail(measuredEntries());

    expect(html).toContain('data-quota-flyout');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="app-provider-quota"');
  });

  test('states the unmeasured providers instead of dropping them', () => {
    const html = renderRail(measuredEntries());

    expect(html).toContain('No quota source');
    expect(html).toContain('Claude');
    expect(html).toContain('Cursor');
  });

  test('gives up its rail slot entirely when no provider reports anything', () => {
    expect(renderRail(buildProviderQuotaRail(null, NOW))).not.toContain('data-provider-quota-rail');
  });

  test('carries a compact percentage per entry for the band where provider names do not fit', () => {
    const entries = measuredEntries();
    const slots = compactValueSlots(renderRail(entries));

    // One per provider slot, not one for the whole rail: every ring needs its own number, and the
    // text is read from inside each span so an empty one cannot borrow the labelled value's "71%".
    expect(slots).toHaveLength(entries.length);
    for (const slot of slots) {
      expect(slot.text.length).toBeGreaterThan(0);
    }
    expect(slots.map(({ text }) => text)).toContain('71%');
  });

  test('swaps the compact percentage and the labelled one at exactly the xl boundary', () => {
    const html = renderRail(measuredEntries());
    const [compact] = compactValueSlots(html);

    // The two are inverses: compact shows from `md` and stops at `xl`, where the labelled row with
    // the provider name takes over. Asserted on the emitted atomic classes because the rail's own
    // data query is gated to live mode and never renders under e2e.
    expect(compact?.classes).toContain('md:d_block');
    expect(compact?.classes).toContain('xl:d_none');
    expect(html).toContain('md:d_none');
    expect(html).toContain('xl:d_block');
  });

  test('gives the compact value the same em dash and stale tone the labelled value uses', () => {
    const [first, ...rest] = measuredEntries();
    if (!first) {
      throw new Error('Expected at least one rail entry.');
    }
    const measured = compactValueSlots(renderRail([{ ...first, stale: false }, ...rest]))[0];
    const stale = compactValueSlots(renderRail([{ ...first, stale: true, usedPercent: null }, ...rest]))[0];

    expect(stale?.text).toBe('—');
    // The tone must be on the compact element itself, not merely somewhere in the document: an aged
    // reading keeps its number but must not sit at a live one's weight.
    const staleOnlyClasses = (stale?.classes ?? '')
      .split(' ')
      .filter((token) => !(measured?.classes ?? '').split(' ').includes(token));
    expect(staleOnlyClasses.length).toBeGreaterThan(0);
  });
});
