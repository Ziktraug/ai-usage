import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { EMPTY_WORK_ATTENTION_SEARCH, type WorkAttentionSearch, workRootId } from './work-attention-model';
import { syntheticWorkAttentionDataset } from './work-attention-synthetic';
import { WORK_DEMO_REVISION } from './work-synthetic';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work attention fixture did not expose a Svelte component.');
  }
  return value.default as Component;
};
const rendererFrom = (value: unknown): SvelteServerModule => {
  if (!(typeof value === 'object' && value !== null && 'render' in value && typeof value.render === 'function')) {
    throw new Error('Svelte server renderer is unavailable.');
  }
  return value as SvelteServerModule;
};

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: {
    alias: { '$app/environment': fileURLToPath(new URL('../sync/sync-ssr-environment.fixture.ts', import.meta.url)) },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());
const [fixtureModule, rendererModule] = await Promise.all([
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-attention.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

const forbiddenRead = (): Promise<never> => Promise.reject(new Error('Server-rendered Work must not acquire data'));
const sessionClient: SessionClientAdapter = {
  campaignChildren: forbiddenRead,
  detail: forbiddenRead,
  lookup: forbiddenRead,
  neighbors: forbiddenRead,
  page: forbiddenRead,
  vcs: forbiddenRead,
};
const dataset = syntheticWorkAttentionDataset();
const noop = (): void => undefined;
const html = (search: WorkAttentionSearch, selectedId: string | null = null): string => {
  const root = selectedId ? dataset.roots.find((candidate) => workRootId(candidate) === selectedId) : undefined;
  return render(fixture, {
    props: {
      board: { dataset, onFocusRow: noop, onSearch: noop, onSelect: noop, search, selectedId },
      ...(root
        ? {
            detail: {
              loadedRows: [],
              mode: 'demo',
              onClose: noop,
              providers: [],
              quotaUnavailable: true,
              reference: dataset.generatedAt,
              revision: WORK_DEMO_REVISION,
              root,
              sessionClient,
            },
          }
        : {}),
    },
  }).body.replaceAll(/\s+/g, ' ');
};
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
/** The rendered text without Svelte's hydration markers, for assertions that span a template boundary. */
const withoutMarkers = (body: string): string => body.replaceAll(/<!--[^>]*-->/g, '');
const rowsIn = (body: string, section: string): number => {
  const start = body.indexOf(`data-work-section="${section}"`);
  const end = body.indexOf('</section>', start);
  return occurrences(body.slice(start, end), 'data-work-root=');
};

describe('Work resume surface server rendering from the synthetic dataset', () => {
  test('renders the five sections, the coverage line and compact rows without any acquisition', () => {
    const body = html(EMPTY_WORK_ATTENTION_SEARCH);
    for (const heading of [
      'Needs you',
      'Waiting on others',
      'Leads',
      'Recent · no pending declaration read',
      'Codex · no declared wait read',
    ]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain('Nothing pending was read here; that is not proof that nothing is pending.');
    expect(body).not.toContain('nothing pending</h2>');
    expect(body).toContain('39 of 41 files parsed');
    expect(body).toContain('2 unsupported');
    expect(body).toContain('4 older roots without pending declarations hidden (30-day window)');
    expect(withoutMarkers(body)).toContain('Jira: 1 observed');
    expect(body).toContain(
      `${dataset.roots.length} of ${dataset.roots.length} roots shown; not shown: 4 older roots without a pending declaration (30-day window), 9 beyond the ranking limit.`,
    );
    expect(body).not.toContain('Known waits');
    expect(body).not.toContain('Simulate review assignment');
    expect(occurrences(body, 'Declared by the session; current state unobserved.')).toBe(3);
    expect(rowsIn(body, 'human-request')).toBe(8);
    expect(rowsIn(body, 'none')).toBe(10);
    expect(body).toContain('Show all 12 in Recent · no pending declaration read');
    expect(body).toContain('possibly answered · PR #61');
    expect(body).toContain('Confirm whether the Codex quota window should be dated by its last confirmation');
    expect(body).toContain('blocked · <time datetime="2026-06-11T09:00:00.000Z"');
    expect(body).toContain('3 h ago');
    expect(body).toContain('28 d ago');
    // The eleventh and later recent rows are folded behind the explicit control.
    expect(body).not.toContain('40 d ago');
    // The automatic-title marker is detail-only; rows carry the title alone.
    expect(body).not.toContain('auto title');
    expect(body).not.toContain('title: automatic');
    expect(body).toContain('archived');
    expect(body).toContain('PR #71 checks pending');
    expect(body).toContain('· observed 40 min ago');
    expect(body).toContain('checkout 3 modified · 1 untracked · 2 ahead');
    expect(body).not.toContain('checkout dirty');
    expect(body).toContain('Jira XLB-2090 · In Progress · 2 new replies');
  });
  test('says per harness what was read and keeps a Codex row apart from nothing pending (ADR 0059)', () => {
    const body = withoutMarkers(html(EMPTY_WORK_ATTENTION_SEARCH));
    expect(body).toContain('Claude Desktop registry · declared waits: collected');
    expect(body).toContain(
      'Codex · sessions only, no declared waits: 1 of 1 Codex campaign shown, active in the last 30 days (served report)',
    );
    expect(body).toContain('Other harnesses: not read here');
    expect(body).not.toContain('Declarations: Claude Desktop only');
    expect(rowsIn(body, 'not-observable')).toBe(1);
    const start = body.indexOf('data-work-section="not-observable"');
    const codexSection = body.slice(start, body.indexOf('</section>', start));
    expect(codexSection).toContain('Build report UI');
    expect(codexSection).toContain('wait unknown · not declared by Codex');
    expect(codexSection).toContain('wait not declared');
    expect(codexSection).toContain('data-work-standing="not-declared"');
    expect(codexSection).toContain('Next: Check the session in Codex; this view cannot tell whether it waits on you.');
    expect(codexSection).toContain('Whether one waits on you is unknown — not declared by this harness');
    // Never "declared by the session": Codex declared nothing.
    expect(codexSection).not.toContain('Declared by the session; current state unobserved.');
    expect(rowsIn(body, 'none')).toBe(10);
  });
  test('a Codex detail names the unknown standing and does not count undeclared child statuses', () => {
    const codex = dataset.roots.find((root) => root.key.harness === 'codex');
    const body = withoutMarkers(html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(codex!)));
    expect(body).toContain('Request · Unknown — not declared by this harness');
    expect(body).toContain(
      'Codex records no turn declaration for its sessions: whether this one waits on you is unknown — not declared by this harness.',
    );
    expect(body).toContain(
      '2 child sessions · linked by their declared parent in Codex; their outcomes are not declared',
    );
    expect(body).not.toContain('0 blocked · 0 review ready');
    expect(body).toContain('Codex records no turn status: whether this session waits on you is unknown');
    expect(body).toContain('Open session detail');
  });
  test('a root with a Jira fact lists it under its own source with the arrival named and its uncertainty', () => {
    const withJira = dataset.roots.find((root) => root.facts.some((fact) => fact.kind === 'jira-issue'));
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(withJira!));
    expect(body).toContain('data-work-detail=');
    expect(body).toContain('>Jira<');
    expect(body).toContain(
      'Jira XLB-2090 In Progress, 2 comments, 2 new replies since the latest activity on this key',
    );
    expect(body).toContain('2 comments arrived on XLB-2090 after this session family');
    expect(body).toContain('You may have read them in Jira; this view cannot tell.');
  });
  test('the coverage line says why Jira was not observed, or that it was not', () => {
    const withJira = (jira: typeof dataset.coverage.jira): string =>
      withoutMarkers(
        render(fixture, {
          props: {
            board: {
              dataset: { ...dataset, coverage: { ...dataset.coverage, jira } },
              onFocusRow: noop,
              onSearch: noop,
              onSelect: noop,
              search: EMPTY_WORK_ATTENTION_SEARCH,
              selectedId: null,
            },
          },
        }).body.replaceAll(/\s+/g, ' '),
      );
    expect(
      withJira({ disabled: true, failed: 0, lastRunAt: null, observed: 0, reason: 'acli not installed' }),
    ).toContain('Jira: acli not installed');
    expect(withJira({ disabled: true, failed: 0, lastRunAt: null, observed: 0, reason: null })).toContain(
      'Jira: observation disabled',
    );
    expect(withJira({ disabled: false, failed: 0, lastRunAt: null, observed: 0, reason: null })).toContain(
      'Jira: not observed',
    );
    expect(
      withJira({ disabled: false, failed: 2, lastRunAt: dataset.coverage.jira.lastRunAt, observed: 3, reason: null }),
    ).toContain('Jira: 3 observed, 2 failed');
  });
  test('a checkout reads the same counts in the row and in the detail: staged, untracked, clean', () => {
    const base = dataset.roots.find((root) => root.title === 'Recover Claude history');
    const fact = base?.facts.find((candidate) => candidate.kind === 'checkout-status');
    if (base === undefined || fact?.kind !== 'checkout-status') {
      throw new Error('Synthetic root must carry a checkout fact');
    }
    const rendered = (counts: Partial<typeof fact>): string => {
      const root = { ...base, facts: [{ ...fact, ...counts }] };
      return withoutMarkers(
        render(fixture, {
          props: {
            board: {
              dataset: { ...dataset, roots: dataset.roots.map((entry) => (entry === base ? root : entry)) },
              onFocusRow: noop,
              onSearch: noop,
              onSelect: noop,
              search: EMPTY_WORK_ATTENTION_SEARCH,
              selectedId: workRootId(root),
            },
            detail: {
              loadedRows: [],
              mode: 'demo',
              onClose: noop,
              providers: [],
              quotaUnavailable: true,
              reference: dataset.generatedAt,
              revision: WORK_DEMO_REVISION,
              root,
              sessionClient,
            },
          },
        }).body.replaceAll(/\s+/g, ' '),
      );
    };
    const where = `Checkout ${fact.checkoutPath} on ${fact.branch}`;
    const staged = rendered({ ahead: 2, modifiedCount: 0, stagedCount: 28, untrackedCount: 1 });
    expect(staged).toContain('checkout 28 staged · 1 untracked · 2 ahead');
    expect(staged).toContain(`${where}: 28 staged · 1 untracked · 2 ahead`);
    expect(staged).not.toContain('0 modified');
    const untracked = rendered({ ahead: 0, modifiedCount: 0, stagedCount: 0, untrackedCount: 2 });
    expect(untracked).toContain('checkout 2 untracked');
    expect(untracked).toContain(`${where}: 2 untracked`);
    const clean = rendered({ ahead: 0, dirty: false, modifiedCount: 0, stagedCount: 0, untrackedCount: 0 });
    expect(clean).toContain(`${where}: clean`);
    expect(clean).not.toContain('checkout clean');
  });
  test('the coverage line says why checkouts were not read, and a removed checkout reads as a past fact', () => {
    const base = dataset.roots.find((root) => root.title === 'Recover Claude history');
    const fact = base?.facts.find((candidate) => candidate.kind === 'checkout-status');
    if (base === undefined || fact?.kind !== 'checkout-status') {
      throw new Error('Synthetic root must carry a checkout fact');
    }
    const gone = { ...fact, dirty: null, modifiedCount: null, outcome: 'missing' as const, stagedCount: null };
    const notRepository = { ...gone, checkoutPath: '/fixture/home', id: 'home', outcome: 'not-a-repository' as const };
    const root = { ...base, facts: [gone, notRepository] };
    const body = withoutMarkers(
      render(fixture, {
        props: {
          board: {
            dataset: {
              ...dataset,
              coverage: { ...dataset.coverage, checkouts: { ...dataset.coverage.checkouts, failed: 11, observed: 10 } },
              roots: dataset.roots.map((entry) => (entry === base ? root : entry)),
            },
            onFocusRow: noop,
            onSearch: noop,
            onSelect: noop,
            search: EMPTY_WORK_ATTENTION_SEARCH,
            selectedId: workRootId(root),
          },
          detail: {
            loadedRows: [],
            mode: 'demo',
            onClose: noop,
            providers: [],
            quotaUnavailable: true,
            reference: dataset.generatedAt,
            revision: WORK_DEMO_REVISION,
            root,
            sessionClient,
          },
        },
      }).body.replaceAll(/\s+/g, ' '),
    );
    expect(body).toContain('Checkouts: 10 observed, 11 not read');
    expect(body).not.toContain('11 failed');
    expect(body).toContain(
      'of the checkouts the roots shown name: 1 no longer on disk (removed since the session), 1 not a git repository',
    );
    expect(body).toContain('checkout no longer on disk (removed since the session)');
    expect(body).toContain(`Checkout ${fact.checkoutPath}: no longer on disk (removed since the session)`);
    expect(body).toContain('Checkout /fixture/home: not a git repository');
  });
  test('the detail names an automatic title once, where the row does not', () => {
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, 'desk-enquete-retention');
    expect(occurrences(body, 'title: automatic')).toBe(1);
    expect(body).not.toContain('auto title');
  });
  test('applies the address filters on the server and reports the narrowed count', () => {
    const body = html({ ...EMPTY_WORK_ATTENTION_SEARCH, query: 'mobile navigation' });
    expect(occurrences(body, 'data-work-root=')).toBe(1);
    expect(body).toContain(
      `1 of ${dataset.roots.length} roots match. Searched the ${dataset.roots.length} roots in this ranking; not searched:`,
    );
    expect(body).toContain('aria-pressed="false"');
    const chips = html({ ...EMPTY_WORK_ATTENTION_SEARCH, attention: ['optional-lead'], harness: ['claude'] });
    expect(occurrences(chips, 'data-work-root=')).toBe(3);
    expect(chips).toContain('Clear filters');
    expect(occurrences(chips, 'aria-pressed="true"')).toBe(2);
  });
  test('marks the selected row and renders its detail with the exact declaration date and grouped facts', () => {
    const selected = dataset.roots.find((root) => root.title === 'Fix mobile navigation label overlap');
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(selected!));
    expect(occurrences(body, 'aria-current="true"')).toBe(1);
    expect(body).toContain('data-work-detail=');
    expect(body).toContain('Which of the two 320px layouts do you prefer?');
    expect(body).toContain('Declared by the session at Jun 10, 2026, 10:00 UTC; its current state is unobserved.');
    expect(body).toContain('Facts by source');
    for (const source of ['Claude Desktop metadata', 'GitHub', 'Local checkout']) {
      expect(body).toContain(source);
    }
    expect(body).toContain('Uncertainty:');
    expect(body).toContain('Review assignment simulation');
    expect(body).toContain('Transcript not collected yet');
    expect(body).not.toContain('Run simulation');
  });
  test('a root joined to a served Session links to its detail and offers the related sessions on demand', () => {
    const joined = dataset.roots.find((root) => root.session?.campaignKey);
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(joined!));
    expect(body).toContain('Open session detail');
    expect(body).toContain(`/sessions/${encodeURIComponent(joined!.session!.rowId)}`);
    expect(body).toContain('Related served sessions');
    expect(body).toContain('Resolving the collected Session for this root');
  });
});

describe('Work resume surface server rendering of request standings (ADR 0056)', () => {
  test('current blocks lead Needs you; older declarations to reconsider follow under their own heading', () => {
    const body = html(EMPTY_WORK_ATTENTION_SEARCH);
    const section = body.slice(
      body.indexOf('data-work-section="human-request"'),
      body.indexOf('data-work-section="external-wait"'),
    );
    const heading = section.indexOf('Older declarations to reconsider · 3');
    expect(heading).toBeGreaterThan(0);
    // Every current block is rendered before the heading, every row to reconsider after it.
    expect(occurrences(section.slice(0, heading), 'data-work-standing="current"')).toBe(5);
    expect(occurrences(section.slice(0, heading), 'data-work-standing="reconsider"')).toBe(0);
    expect(occurrences(section.slice(heading), 'data-work-standing="reconsider"')).toBe(3);
    // The marker is words, not only a style.
    expect(occurrences(section, '>Older declaration to reconsider<')).toBe(3);
    // A request untouched for over a week (ADR 0056 age tier) is dated, still asked, never hidden.
    const dormant = withoutMarkers(section.slice(section.indexOf('Session distillation worker redaction')));
    expect(dormant).toContain('The redaction fixed-point test needs a real sample');
    expect(dormant).toContain('blocked · <time datetime="2026-06-02T12:00:00.000Z"');
    expect(dormant).toContain('9 d ago</time>, no activity since');
    expect(dormant).toContain(
      'Next: Nothing happened in it for over 7 days; answer or archive the session in Claude Desktop to settle it.',
    );
    expect(dormant).toContain('checkout 28 staged · 1 untracked · 2 ahead');
    expect(section).toContain('or nothing happened in their session for over 7 days.');
    expect(body).toContain('data-work-standing="handled"');
    expect(body).toContain('Handled in a linked session');
    expect(body).toContain('Next: Answer in Claude Desktop.');
  });
  test('the detail reads request, context, last decision and next action before the diagnostics', () => {
    const page = withoutMarkers(html(EMPTY_WORK_ATTENTION_SEARCH, 'desk-sources-label'));
    // The detail alone: the board before it repeats the decision and the next action per row.
    const body = page.slice(page.indexOf('data-work-detail='));
    const order = [
      'data-work-request="current"',
      'data-work-question',
      'data-work-context',
      'Last decision: Earlier “Call the rail entry “Inputs” or “Collectors”?” answered in Claude Desktop',
      'Next: Answer in Claude Desktop.',
      'Declared by the session',
      'Interpretations',
      'Facts by source',
    ].map((needle) => body.indexOf(needle));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(occurrences(body, 'data-work-question')).toBe(1);
    expect(body).toContain('Earlier declaration, blocked: Call the rail entry “Inputs” or “Collectors”?');
    expect(body).toContain('you wrote to the session at');
  });
});
