import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';
import type { SessionVcsContext } from '@ai-usage/report-core/session-vcs';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { syntheticSessionRow } from '../table/session-table.fixtures';
import { emptySessionDetailSnapshot, type SessionDetailController } from './types';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('P4 fixture did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
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
afterAll(async () => await viteServer.close());

const [highlightModule, detailItemModule, analysisModule, vcsModule, drawerModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sessions/detail/highlighted-text.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sessions/detail/session-analysis.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sessions/detail/session-drawer.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const HighlightedText = componentFrom(highlightModule);
const DrawerDetailItem = componentFrom(detailItemModule);
const SessionAnalysis = componentFrom(analysisModule);
const SessionVcsSummary = componentFrom(vcsModule);
const SessionDrawer = componentFrom(drawerModule);
const { render } = rendererFrom(serverModule);

const row = syntheticSessionRow(7);
const target = { kind: 'session' as const, reportRowId: row.rowId, summaryRow: row };
const tokens = (total: number) => ({ cacheRead: 0, cacheWrite: 0, input: total, output: 0, total });
const orphanPromptText = `${'Orphan prompt content '.repeat(9)}tail`;
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
});
const fmtDateTime = (value: string): string => dateTimeFormatter.format(new Date(value));
const availableResponse: SessionDetailResponse = {
  consistency: { checkedFields: ['tokens'], status: 'matches-report' },
  detail: {
    activeDurationMs: 120_000,
    durationStatus: 'partial',
    efforts: ['high', 'default'],
    elapsedDurationMs: 18_120_000,
    endedAt: '2026-08-01T15:02:00.000Z',
    idleDurationMs: 18_000_000,
    models: ['gpt-5.6-sol', 'claude-opus'],
    observedAt: '2026-08-01T15:02:01.000Z',
    phases: [
      {
        cost: 0.123_45,
        costKind: 'approximate',
        effort: 'high',
        effortKind: 'recorded',
        endAt: '2026-08-01T10:01:00.000Z',
        model: 'gpt-5.6-sol',
        startAt: '2026-08-01T10:00:00.000Z',
        tokens: tokens(100),
      },
      {
        cost: null,
        costKind: 'unknown',
        effort: null,
        effortKind: 'default',
        endAt: '2026-08-01T15:02:00.000Z',
        model: 'claude-opus',
        startAt: '2026-08-01T15:01:00.000Z',
        tokens: tokens(50),
      },
    ],
    prompts: [
      {
        id: 'prompt-a',
        text: 'Explain the chronology clearly',
        timestamp: '2026-08-01T10:00:00.000Z',
        truncated: false,
      },
      {
        id: 'prompt-orphan',
        text: orphanPromptText,
        timestamp: '2026-08-01T12:30:00.000Z',
        truncated: true,
      },
    ],
    promptsTruncated: false,
    sourceSessionId: 'synthetic-session',
    startedAt: '2026-08-01T10:00:00.000Z',
    turns: [
      {
        durationMs: 60_000,
        effort: 'high',
        effortKind: 'recorded',
        endAt: '2026-08-01T10:01:00.000Z',
        index: 0,
        intervals: [
          {
            endAt: '2026-08-01T10:01:00.000Z',
            startAt: '2026-08-01T10:00:00.000Z',
          },
        ],
        model: 'gpt-5.6-sol',
        promptIds: ['prompt-a'],
        startAt: '2026-08-01T10:00:00.000Z',
        timingStatus: 'recorded',
        tokens: tokens(100),
        tools: 1,
      },
      {
        durationMs: 60_000,
        effort: null,
        effortKind: 'default',
        endAt: '2026-08-01T15:02:00.000Z',
        index: 1,
        intervals: [
          {
            endAt: '2026-08-01T15:02:00.000Z',
            startAt: '2026-08-01T15:01:00.000Z',
          },
        ],
        model: 'claude-opus',
        promptIds: [],
        startAt: '2026-08-01T15:01:00.000Z',
        timingStatus: 'recorded',
        tokens: tokens(50),
        tools: 0,
      },
    ],
    turnsStatus: 'partial',
  },
  revision: 'revision-p4',
  status: 'available',
};

const vcsContext: SessionVcsContext = {
  branches: [
    {
      firstObservedAt: '2026-08-01T10:00:00.000Z',
      lastObservedAt: '2026-08-01T10:01:00.000Z',
      name: 'main',
      provenance: 'harness-recorded',
      webUrl: 'https://github.com/synthetic/project/tree/main',
    },
  ],
  headCommit: {
    hash: '0123456789abcdef',
    observedAt: '2026-08-01T10:01:00.000Z',
    provenance: 'harness-recorded',
    webUrl: 'https://github.com/synthetic/project/commit/0123456789abcdef',
  },
  partial: true,
  pullRequests: [],
  repository: {
    host: 'github.com',
    ownerPath: 'synthetic/project',
    provenance: 'local-derived',
    webUrl: 'https://github.com/synthetic/project',
  },
};

describe('P4 Svelte detail rendering', () => {
  test('preserves literal Unicode highlighting and Popover accessibility', () => {
    const highlighted = render(HighlightedText, {
      props: { query: '[β]', text: `prefix [β] ${'🧪'.repeat(220)}` },
    }).body;
    const detail = render(DrawerDetailItem, {
      props: { hint: 'Covered by subscription quota', label: 'Sub value', value: '$12.00' },
    }).body;
    expect(highlighted).toContain('<mark');
    expect(highlighted).toContain('[β]');
    expect(highlighted).toContain('…');
    expect(detail).toContain('data-detail-item="Sub value"');
    expect(detail).toContain('aria-label="About Sub value"');
    expect(detail).toContain('aria-haspopup="dialog"');
  });

  test('renders recorded/partial chronology, compressed gaps, phase trust, and multi-harness labels', () => {
    const html = render(SessionAnalysis, {
      props: {
        harnessKey: 'claude',
        loading: false,
        response: availableResponse,
        target,
      },
    }).body;
    expect(html).toContain('Session analysis');
    expect(html).toContain('Claude chronology');
    expect(html).toContain('data-session-analysis-scale="compressed"');
    expect(html).toContain('aria-label="Show real gaps"');
    expect(html).toContain('title="5h"');
    expect(html).toContain('id="session-model-phases"');
    expect(html).toContain('Prompt: Explain the chronology clearly');
    expect(html).toContain('data-session-analysis-item="partial-duration"');
    expect(html).toContain('data-session-analysis-item="partial-turns"');
    expect(html).toContain('≈ $0.1235');
    expect(html).toContain('price unknown');
    const partialDuration = html.indexOf('data-session-analysis-item="partial-duration"');
    const description = html.indexOf(
      'Bars show recorded Claude turn intervals. Point markers show turns whose active duration is unavailable.',
    );
    const partialTurns = html.indexOf('data-session-analysis-item="partial-turns"');
    const privacy = html.indexOf('data-session-analysis-item="privacy"');
    const truncation = html.indexOf('data-session-analysis-item="prompt-truncation"');
    expect([partialDuration, description, partialTurns, privacy, truncation]).toEqual(
      [...[partialDuration, description, partialTurns, privacy, truncation]].sort((left, right) => left - right),
    );
    expect(partialDuration).toBeGreaterThan(-1);
    expect(html.match(/Compressed gaps/g)).toHaveLength(2);
    expect(html.match(/>Tokens<\/span>/g)).toHaveLength(1);
    expect(html).toContain(
      `from ${fmtDateTime('2026-08-01T10:00:00.000Z')} to ${fmtDateTime('2026-08-01T10:01:00.000Z')}`,
    );
    expect(html).toContain('67% of tokens');
    expect(html).toContain('33% of tokens');
    expect(html).toContain(`datetime="2026-08-01T12:30:00.000Z"`);
    expect(html).toContain(fmtDateTime('2026-08-01T12:30:00.000Z'));
    expect(html).toContain('prompt without task attribution');
    expect(html).toContain('Truncated');
    expect(html).toContain('orphan prompt');
    expect(html).toContain(
      `from ${fmtDateTime('2026-08-01T12:30:00.000Z')} to ${fmtDateTime('2026-08-01T12:30:00.000Z')}`,
    );
  });

  test('keeps unavailable Retry semantics and sanitized VCS links exact', () => {
    const retryable = render(SessionAnalysis, {
      props: {
        harnessKey: 'codex',
        loading: false,
        onRetry: () => undefined,
        response: {
          message: 'Synthetic history unavailable',
          reason: 'history-unavailable',
          status: 'unavailable',
        },
        target,
      },
    }).body;
    const terminal = render(SessionAnalysis, {
      props: {
        harnessKey: 'opencode',
        loading: false,
        onRetry: () => undefined,
        response: {
          message: 'Synthetic revision expired',
          reason: 'revision-expired',
          status: 'unavailable',
        },
        target,
      },
    }).body;
    const vcs = render(SessionVcsSummary, {
      props: { context: vcsContext, onResolve: () => undefined, resolution: null, resolving: false },
    }).body;
    const invalid = render(SessionVcsSummary, {
      props: {
        context: { private: 'PRIVATE', repository: { webUrl: 'javascript:alert(1)' } },
        resolution: null,
        resolving: false,
      },
    }).body;
    expect(retryable).toContain('>Retry</button>');
    expect(terminal).not.toContain('>Retry</button>');
    expect(vcs).toContain('Session source control');
    expect(vcs).toContain('target="_blank"');
    expect(vcs).toContain('rel="noopener"');
    expect(vcs).toContain('<svg');
    expect(vcs).not.toContain('↗');
    expect(vcs).toContain('Some recorded source-control context could not be represented safely.');
    expect(invalid).not.toContain('PRIVATE');
    expect(invalid).not.toContain('javascript:');
  });

  test('keeps the portal Drawer client-owned while its controlled selection is settled during SSR', () => {
    const snapshot = {
      ...emptySessionDetailSnapshot(),
      row,
      target: { kind: 'session' as const, reportRowId: row.rowId, summaryRow: row },
    };
    const controller: SessionDetailController = {
      close: () => undefined,
      current: () => snapshot,
      dispose: () => undefined,
      handleKeyDown: () => undefined,
      navigate: () => undefined,
      resolveVcs: () => Promise.resolve(),
      retryAnalysis: () => Promise.resolve(),
      select: () => undefined,
      subscribe: () => () => undefined,
      toggleAnalysis: () => Promise.resolve(),
    };
    const html = render(SessionDrawer, { props: { controller, rows: [row], snapshot } }).body;
    expect(snapshot).toMatchObject({
      row: { rowId: row.rowId },
      target: { kind: 'session', reportRowId: row.rowId },
    });
    expect(html).not.toContain(row.sessionLabel);
    expect(html).not.toContain('Loading');
  });
});
