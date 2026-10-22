import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
import type { WorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
import type { WorkRoutingContext, WorkRoutingQualification } from '@ai-usage/web-contract/work-routing';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { workRequest } from '../../query/options/work';
import { syntheticSessionRow } from '../sessions/table/session-table.fixtures';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work routing fixture did not expose a Svelte component.');
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
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-routing.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

const MACHINE = 'synthetic-machine';
const row = {
  ...syntheticSessionRow(0),
  harness: 'Claude',
  projectLabel: 'ai-usage',
  source: {
    harnessKey: 'claude' as const,
    machineId: MACHINE,
    sourceSessionId: 'root-session',
    rootSourceSessionId: 'root-session',
  },
};
const target = projectSessionPage([row], workRequest('synthetic')).items[0]?.row;
if (!target) {
  throw new Error('Synthetic target row is missing.');
}
const providers: ProviderStatus[] = [
  {
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    key: 'claude',
    label: 'Claude',
    machineId: MACHINE,
    machineLabel: 'Synthetic workstation',
    plan: 'max',
    source: 'live-api',
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: '5h',
        id: 'five_hour',
        label: '5h',
        limitSeconds: null,
        remainingPercent: 60,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
        scope: 'global',
        usedPercent: 40,
      },
    ],
  },
];
const context: WorkRoutingContext = {
  configPath: '/home/operator/.config/ai-usage/config.json',
  declarationErrors: ["routing.executors[1].subscription: must be 'verified' or 'api'"],
  declarations: [
    {
      accountScope: 'personal',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: '2026-10-20T08:00:00.000Z',
      effort: 'high',
      harness: 'claude-code',
      machineId: MACHINE,
      model: 'Opus',
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }],
    },
  ],
  executorObservations: [
    {
      authEvidence: 'claude auth status exit 0 loggedIn=true',
      authMethod: 'claude.ai',
      authState: 'logged-in',
      binaryPath: '/usr/bin/claude',
      harness: 'claude-code',
      machineId: MACHINE,
      observedAt: new Date(Date.now() - 120_000).toISOString(),
      outcome: 'observed',
      version: '2.1.303 (Claude Code)',
    },
  ],
  generatedAt: new Date().toISOString(),
  machineId: MACHINE,
  observationRead: { skipped: 0, truncated: false },
};

const HYDRATION_MARKER_PATTERN = /<!--[^>]*-->/g;
const html = (props: Record<string, unknown>): string =>
  render(fixture, { props: { routing: props } })
    .body.replaceAll(HYDRATION_MARKER_PATTERN, '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll('&lt;', '<');

describe('Work routing Svelte rendering from a supplied context', () => {
  test('renders a declared and observed candidate with per-field provenance and no simulation result', () => {
    const body = html({ context, mode: 'live', providers, quotaUnavailable: false, target });
    expect(body).toContain('Candidate evidence (1)');
    expect(body).toContain('Claude Code · personal · Synthetic workstation');
    expect(body).toContain('Authorization: allowed · declared 2026-10-20T08:00:00.000Z');
    expect(body).toContain('Subscription: verified (plan observed: max) · declared 2026-10-20T08:00:00.000Z');
    expect(body).toContain('Availability: available · observed-now');
    expect(body).toContain('Quota: ok at ');
    expect(body).toContain('· observed-now');
    expect(body).toContain('Model: Opus · declared');
    expect(body).toContain("routing.executors[1].subscription: must be 'verified' or 'api'");
    expect(body).toContain('/home/operator/.config/ai-usage/config.json');
    expect(body).not.toContain('To qualify this candidate');
    expect(body).not.toContain('Routing result');
    expect(body).not.toContain('Synthetic evidence examples');
  });

  test('renders the supplied attempts beside the simulation and keeps execution out of the demo', () => {
    const attempts: WorkAttemptsListOutput = {
      data: {
        attempts: [],
        generatedAt: new Date().toISOString(),
        skipped: 0,
        target: {
          admitted: false,
          checkoutOrigin: 'desktop-cwd',
          checkoutPath: '/home/operator/src/ai-usage',
          harness: 'claude',
          sourceSessionId: 'root-session',
        },
        truncated: false,
      },
      ok: true,
    };
    const body = html({ attempts, context, mode: 'live', providers, quotaUnavailable: false, target });
    expect(body).toContain('Review attempts');
    expect(body).toContain('No review attempt for this session yet.');
    // The button exists only after a simulation, which is a browser interaction; nothing renders it server-side.
    expect(body).not.toContain('Start read-only review');
    expect(body).not.toContain('Execution is not available in the demo.');

    const unavailable = html({ attempts: null, context, mode: 'live', providers, quotaUnavailable: false, target });
    expect(unavailable).toContain('Review attempts are unavailable.');

    const demo = html({ mode: 'demo', providers: [], quotaUnavailable: false, target });
    expect(demo).toContain('Execution is not available in the demo.');
    expect(demo).not.toContain('Review attempts');
  });

  test('names the missing declaration for an observed-only Codex and states an unavailable context', () => {
    const codex: ProviderStatus = { ...providers[0], key: 'codex', label: 'Codex' } as ProviderStatus;
    const body = html({ context, mode: 'live', providers: [...providers, codex], quotaUnavailable: false, target });
    expect(body).toContain('Candidate evidence (2)');
    expect(body).toContain("Add routing.executors[] for codex:<accountScope> with authorization 'allowed'");
    expect(body).toContain('Availability: unknown · unknown');

    const unavailable = html({ context: null, mode: 'live', providers, quotaUnavailable: true, target });
    expect(unavailable).toContain('Routing context unavailable');
    expect(unavailable).toContain('Candidate evidence (0)');
    expect(unavailable).toContain('Current quota observations are unavailable');
  });

  test('keeps the demo path on its fixtures without reading any context', () => {
    const body = html({ mode: 'demo', providers: [], quotaUnavailable: false, target });
    expect(body).toContain('Demo only');
    expect(body).toContain('Candidate evidence (2)');
    expect(body).toContain('Synthetic evidence examples');
    expect(body).not.toContain('Routing context unavailable');
  });
});

describe('Work routing qualification path (ADR 0057)', () => {
  const FINGERPRINT = '0123456789abcdef';
  const [declaration] = context.declarations;
  const [observation] = context.executorObservations;
  if (!(declaration && observation)) {
    throw new Error('The routing fixture has one declaration and one observation.');
  }
  const declaredId = `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`;
  const pinned: WorkRoutingContext = {
    ...context,
    declarations: [{ ...declaration, accountFingerprint: FINGERPRINT, alternateModels: ['Sonnet'], model: 'Fable' }],
    executorObservations: [{ ...observation, accountFingerprint: FINGERPRINT }],
    reviewTargets: [{ checkoutPath: '/home/operator/src/ai-usage', label: 'main' }],
  };
  const admitted: WorkAttemptsListOutput = {
    data: {
      attempts: [],
      generatedAt: new Date().toISOString(),
      skipped: 0,
      target: {
        admitted: true,
        checkoutOrigin: 'desktop-cwd',
        checkoutPath: '/home/operator/src/ai-usage',
        harness: 'claude',
        sourceSessionId: 'root-session',
      },
      truncated: false,
    },
    ok: true,
  };
  const qualification: WorkRoutingQualification = {
    candidates: [
      {
        accountScope: 'personal',
        actions: [],
        candidateId: `${declaredId}:model:1:Sonnet`,
        eligible: true,
        exclusionReasons: [],
        harness: 'claude-code',
        identity: {
          declared: FINGERPRINT,
          observed: FINGERPRINT,
          observedAt: observation.observedAt,
          state: 'confirmed',
        },
        missingData: ['Quota window Fable · Weekly applies to another model than Sonnet; not counted.'],
        model: 'Sonnet',
      },
      {
        accountScope: 'personal',
        actions: ['Quota window Fable · Weekly is exhausted; wait for its reset at 2026-10-24T05:00:00.000Z'],
        candidateId: declaredId,
        eligible: false,
        exclusionReasons: ['Quota window Fable · Weekly is exhausted or blocked.'],
        harness: 'claude-code',
        identity: {
          declared: FINGERPRINT,
          observed: FINGERPRINT,
          observedAt: observation.observedAt,
          state: 'confirmed',
        },
        missingData: [],
        model: 'Fable',
      },
    ],
    chosenCandidateId: `${declaredId}:model:1:Sonnet`,
    executors: { outcome: 'success', refreshed: true },
    omittedCandidates: 0,
    qualifiedAt: new Date().toISOString(),
    reasons: [
      'Simulation only: no harness is started and no permission is granted.',
      'Fable, Sonnet are models of one account (personal): one quota resource, not separate reserves.',
    ],
    recommendation: { candidateId: `${declaredId}:model:1:Sonnet`, kind: 'real', missing: null },
  };

  test('says once per machine what is detected, declared, authorized and missing', () => {
    const body = html({ context, mode: 'live', providers, quotaUnavailable: false, target });
    expect(body).toContain('Routing qualification on this machine');
    expect(body).toContain(
      'Detected: claude 2.1.303 (Claude Code) · signed in (claude.ai) · no account reported · observed',
    );
    expect(body).toContain(
      'Declared: account personal · allowed · subscription verified · models Opus · targets any local session · account not pinned · declared 2026-10-20T08:00:00.000Z.',
    );
    expect(body).toContain('Account: this harness reports no account without its credential file');
    expect(body).toContain('Target: this session is authorized by the declared targets.');
    expect(body).toContain('Declared: nothing; quota and observations alone never authorize.');
    expect(body).toContain('Execution: simulated only; this version launches no Codex review.');
    expect(body).toContain('Qualify now with the engine');
    // Nothing was asked of the engine during rendering.
    expect(body).not.toContain('Qualified by the engine');

    const unpinned = html({
      context: { ...context, executorObservations: [{ ...observation, accountFingerprint: FINGERPRINT }] },
      mode: 'live',
      providers,
      quotaUnavailable: false,
      target,
    });
    expect(unpinned).toContain(`account ${FINGERPRINT}`);
    expect(unpinned).toContain(`Account: ${FINGERPRINT} is observed, but the declaration pins no account`);
    expect(unpinned).toContain('Missing for Claude Code:');
    expect(unpinned).toContain(`Pin the signed-in account: add "accountFingerprint": "${FINGERPRINT}"`);

    const demo = html({ mode: 'demo', providers: [], quotaUnavailable: false, target });
    expect(demo).not.toContain('Routing qualification on this machine');
    expect(demo).not.toContain('Qualify now with the engine');
  });

  test('renders the engine decision with its reasons and limits, and opens the launch on it', () => {
    const body = html({
      attempts: admitted,
      context: pinned,
      mode: 'live',
      providers,
      qualification: { data: qualification, ok: true },
      quotaUnavailable: false,
      target,
    });
    expect(body).toContain('Real recommendation: Claude Code · personal · Sonnet.');
    expect(body).toContain('executors observed by the engine for this qualification');
    expect(body).toContain('Claude Code · personal · Sonnet: chosen');
    expect(body).toContain('Claude Code · personal · Fable: excluded');
    expect(body).toContain('Quota window Fable · Weekly is exhausted or blocked.');
    expect(body).toContain('Limits and missing data: Quota window Fable · Weekly applies to another model than Sonnet');
    expect(body).toContain('one quota resource, not separate reserves');
    expect(body).toContain(`Account: the signed-in account (observed ${FINGERPRINT}) is the pinned one.`);
    expect(body).toContain('data-work-launch="open"');
    expect(body).toContain('Start read-only review (Claude Code)');

    const conditional = html({
      attempts: admitted,
      context: pinned,
      mode: 'live',
      providers,
      qualification: {
        data: {
          ...qualification,
          chosenCandidateId: null,
          executors: { outcome: 'disabled', refreshed: false },
          recommendation: { candidateId: declaredId, kind: 'conditional', missing: 'account identity observation' },
        },
        ok: true,
      },
      quotaUnavailable: false,
      target,
    });
    expect(conditional).toContain(
      'Conditional on Claude Code · personal · Fable (missing: account identity observation)',
    );
    expect(conditional).toContain('executors not refreshed: the executors source is disabled');
    expect(conditional).toContain('data-work-launch="closed"');
    expect(conditional).not.toContain('Start read-only review');

    const unavailable = html({
      context: pinned,
      mode: 'live',
      providers,
      qualification: { error: { message: 'The engine is not running.', tag: 'Unavailable' }, ok: false },
      quotaUnavailable: false,
      target,
    });
    expect(unavailable).toContain('Engine qualification unavailable (Unavailable: The engine is not running.)');
  });
});
