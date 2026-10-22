import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { WorkAttemptsListOutput, WorkAttemptWire } from '@ai-usage/web-contract/work-attempts';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work attempts fixture did not expose a Svelte component.');
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
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-attempts.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

/** Svelte leaves a hydration marker between the id and the suffix; the words are what matter. */
const NOT_COLLECTED_YET = /Native session: native-2 (?:<!--[^>]*-->\s*)*· not collected yet/u;

const attempt = (overrides: Partial<WorkAttemptWire>): WorkAttemptWire => ({
  acceptance: 'pending',
  attemptId: '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f',
  candidateId: 'declared:["m","claude-code","personal"]',
  declared: { accountScope: 'personal', effort: null, model: 'opus' },
  durationMs: 12_345,
  endedAt: '2026-10-22T10:01:00.000Z',
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  guarantee: null,
  machineId: 'm',
  nativeSessionId: 'native-1',
  nativeSessionRowId: null,
  numTurns: 3,
  requestedAt: '2026-10-22T10:00:00.000Z',
  reservation: { held: false, releaseEvidence: null, releasedAt: null },
  resultExcerpt: 'Finding 1: src/a.ts:12 (medium)\nA null path reaches the launcher.',
  resultKind: 'review',
  scope: null,
  startedAt: '2026-10-22T10:00:01.000Z',
  state: 'finished',
  target: {
    checkoutOrigin: 'desktop-cwd',
    checkoutPath: '/home/operator/src/ai-usage',
    desktopSessionId: 'local_desk',
    harness: 'claude',
    projectLabel: 'ai-usage',
    sessionTitle: 'Investigate checkout 3',
    sourceSessionId: 'session-a',
  },
  updatedAt: '2026-10-22T10:01:00.000Z',
  validations: [],
  ...overrides,
});

const list = (attempts: WorkAttemptWire[]): WorkAttemptsListOutput => ({
  data: { attempts, generatedAt: '2026-10-22T10:05:00.000Z', skipped: 0, target: null, truncated: false },
  ok: true,
});

const html = (props: Record<string, unknown>): string =>
  render(fixture, { props: { attempts: props } })
    .body.replaceAll(/\s+/g, ' ')
    .replaceAll('&lt;', '<');

describe('Work attempts Svelte rendering', () => {
  test('offers owned Codex stop and keeps partial output, native turn and target context', () => {
    const body = html({
      attempts: list([
        attempt({ executorHarness: 'codex', state: 'running', nativeTurnId: 'turn-native', endedAt: null }),
      ]),
      pending: false,
      onStop: async () => 'requested',
    });
    expect(body).toContain('Request stop (Codex)');
    expect(body).toContain('turn turn-native');
    expect(body).toContain('Finding 1: src/a.ts:12');
    expect(body).toContain('Investigate checkout 3');
    const pending = html({
      attempts: list([
        attempt({ executorHarness: 'codex', state: 'running', stopRequestedAt: '2026-10-22T10:04:00.000Z' }),
      ]),
      pending: false,
      onStop: async () => 'requested',
    });
    expect(pending).toContain('awaiting native confirmation');
    expect(pending).not.toContain('data-work-attempt-stop=');
    const confirmed = html({
      attempts: list([attempt({ executorHarness: 'codex', stopConfirmedAt: '2026-10-22T10:04:10.000Z' })]),
      pending: false,
    });
    expect(confirmed).toContain('stopped (native turn confirmed)');
    expect(confirmed).toContain('descendant processes are not confirmed stopped');
  });
  test('renders a finished attempt with its excerpt, dates, validations and acceptance, and links a collected session', () => {
    const body = html({
      attempts: list([
        attempt({ nativeSessionRowId: 'row-native-1' }),
        attempt({
          attemptId: 'lost-attempt',
          endedAt: '2026-10-22T10:30:00.000Z',
          failureReason: 'engine restarted while running',
          nativeSessionId: 'native-2',
          resultExcerpt: null,
          reservation: { held: true, releaseEvidence: null, releasedAt: null },
          resultKind: null,
          state: 'lost',
        }),
        attempt({ attemptId: 'live-attempt', endedAt: null, resultExcerpt: null, resultKind: null, state: 'running' }),
      ]),
      pending: false,
    });
    expect(body).toContain('Review attempts');
    expect(body).toContain('finished · attempt 0f2c2b0e');
    expect(body).toContain('Requested 5 min ago (');
    expect(body).toContain('Launched with account personal · model opus · effort unknown.');
    expect(body).toContain('Checkout: /home/operator/src/ai-usage (Desktop session cwd).');
    expect(body).toContain('Native session: native-1');
    expect(body).toContain('Open session detail');
    expect(body).toContain('href="/sessions/row-native-1?tab=sessions&amp;range=all"');
    expect(body).toContain('Result (review) · 3 turns · 12.3 s · exit 0:');
    expect(body).toContain('Finding 1: src/a.ts:12 (medium)');
    expect(body).toContain('Validations executed: none (read-only review).');
    expect(body).toContain('Acceptance: pending — not reviewed by you.');
    expect(body).toContain('contact lost; verify in the harness · attempt lost-att');
    expect(body).toContain('Contact lost; verify in the harness. The engine never relaunches an attempt.');
    expect(body).toContain('Failure: engine restarted while running');
    expect(body).toContain('data-work-attempt-reservation="held"');
    expect(body).toContain('It still reserves this target');
    // Without a release handler (no engine on this page) no release button is offered.
    expect(body).not.toContain('data-work-attempt-release');
    expect(body).toMatch(NOT_COLLECTED_YET);
    expect(body).toContain('running · attempt live-att');
    expect(body).toContain('last heartbeat');
    expect(body).not.toContain('Retry');
    expect(body).not.toContain('Relaunch');
  });

  test('states the commit a review was given, a truncated patch as partial, and the harness guarantee', () => {
    const body = html({
      attempts: list([
        attempt({
          guarantee: {
            cliVersion: '2.1.306',
            effort: null,
            model: 'opus',
            managedSettings: 'absent',
            safeMode: true,
            settingSources: [],
            tools: ['Read', 'Grep', 'Glob'],
          },
          scope: {
            base: 'first-parent',
            baseSha: 'c'.repeat(40),
            fileCount: 2,
            files: [
              {
                additions: 3,
                coverage: 'complete',
                deletions: 1,
                path: 'a.ts',
                previousPath: null,
                status: 'modified',
              },
              { additions: 9, coverage: 'omitted', deletions: 0, path: 'b.ts', previousPath: null, status: 'added' },
            ],
            headSha: 'b'.repeat(40),
            includedBytes: 2048,
            includedLines: 60,
            kind: 'commit',
            parentCount: 1,
            patchBytes: 5120,
            patchLines: 140,
            patchSha256: 'd'.repeat(64),
            repositoryPrefix: '',
            subject: 'fix: one',
            truncated: true,
            workingTreeDirty: true,
          },
        }),
        attempt({
          attemptId: 'released-attempt',
          reservation: {
            held: false,
            releaseEvidence: 'outcome-recorded-late',
            releasedAt: '2026-10-22T10:02:00.000Z',
          },
          state: 'lost',
        }),
      ]),
      pending: false,
    });
    expect(body).toContain(
      'Reviewed commit bbbbbbbbbbbb "fix: one" against its first parent cccccccccccc, one revision only.',
    );
    expect(body).toContain('Patch partial: 2 KB of 5 KB, 60 of 140 lines; 2 files (1 complete, 1 omitted)');
    expect(body).toContain('The working tree had uncommitted changes');
    expect(body).toContain('Result (review, partial: the patch was truncated) · 3 turns');
    expect(body).toContain('Ran under Claude Code 2.1.306: settings loaded none');
    expect(body).toContain('no OS sandbox is claimed');
    expect(body).toContain(
      'Reservation released: the engine that launched it recorded its end after contact was lost.',
    );
  });

  test('offers “Declare the review ended” on a held reservation only (ADR 0055)', () => {
    const body = render(fixture, {
      props: {
        attempts: {
          attempts: list([
            attempt({
              attemptId: 'held-attempt',
              reservation: { held: true, releaseEvidence: null, releasedAt: null },
              state: 'lost',
            }),
            attempt({
              attemptId: 'released-attempt',
              reservation: { held: false, releaseEvidence: 'process-absent', releasedAt: '2026-10-22T10:03:00.000Z' },
              state: 'lost',
            }),
            attempt({ attemptId: 'finished-attempt' }),
          ]),
          onRelease: () => Promise.resolve('released'),
          pending: false,
        },
      },
    }).body.replaceAll(/\s+/g, ' ');
    expect(body.match(/data-work-attempt-release=/gu)).toHaveLength(1);
    expect(body).toContain('data-work-attempt-release="held-attempt"');
    expect(body).toContain('Declare the review ended');
    expect(body).toContain('only if no such review still runs');
  });

  test('states the empty, pending and unavailable cases', () => {
    expect(html({ attempts: list([]), pending: false })).toContain('No review attempt for this session yet.');
    expect(html({ attempts: null, pending: true })).toContain('Reading review attempts…');
    expect(html({ attempts: null, pending: false })).toContain('Review attempts are unavailable.');
    expect(
      html({ attempts: { error: { message: 'Store is busy.', tag: 'Unavailable' }, ok: false }, pending: false }),
    ).toContain('Review attempts unavailable (Unavailable: Store is busy.)');
  });
});
