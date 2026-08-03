import { currentRecord, playwrightTitleRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'R1' as const;
const implementationCommit = '7c85cf198ca2af004b53eef182a727f59d4ab5e4';
const targetEvidence = (kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit: implementationCommit,
  kind,
  phase: 'target',
  reference,
});
const completeRecord = (record: ParityRecord, evidence: readonly ParityEvidence[]): ParityRecord => ({
  ...record,
  evidence: [...record.evidence, ...evidence],
  status: 'complete',
});
const completeNewRecord = (record: ParityRecord, evidence: readonly ParityEvidence[]): ParityRecord => ({
  ...record,
  evidence,
  status: 'complete',
});
const reviewEvidence = targetEvidence(
  'review',
  '/root/d123_parity_review code-quality/seams ACCEPT and /root/q2_spec_review parity/spec ACCEPT for 31aa91d..7c85cf1',
);
const feature = (id: string, currentOwner: string, currentTest: string, targetSource: string, targetTest: string) =>
  completeRecord(
    currentRecord(owner, {
      currentOwner,
      evidence: [
        { kind: 'source', reference: currentOwner },
        { kind: 'test', reference: currentTest },
      ],
      id,
      kind: 'feature',
    }),
    [
      targetEvidence('source', targetSource),
      targetEvidence('test', targetTest),
      targetEvidence(
        'command',
        'bun run --cwd apps/web test:e2e-svelte-shadow (6 passed); bun run check; bun run lint; bun run typecheck; bun run test; bun run build',
      ),
      reviewEvidence,
    ],
  );
const productionReplacementBySource: Readonly<Record<string, { readonly source: string; readonly test: string }>> = {
  'apps/web/src/app-navigation.tsx': {
    source:
      'apps/web/src/lib/features/shell/app-navigation.svelte; apps/web/src/lib/features/shell/app-shell.svelte; apps/web/src/lib/features/shell/navigation-link.svelte',
    test: 'apps/web/e2e/svelte-shell.spec.ts › server-renders and reloads every Svelte shell route with accessible navigation; blocks dirty navigation through Keep, Discard, reload, focus, and cleanup',
  },
  'apps/web/src/dashboard-theme.tsx': {
    source:
      'apps/web/src/lib/features/shell/theme-toggle.svelte; apps/web/src/lib/features/shell/theme.ts; apps/web/svelte-shadow/app.html',
    test: 'apps/web/src/lib/features/shell/theme.test.ts; apps/web/e2e/svelte-shell.spec.ts › resolves stored and system theme before paint and toggles the named preference',
  },
  'apps/web/src/router.tsx': {
    source:
      'apps/web/src/lib/features/shell/app-shell.svelte; apps/web/src/lib/features/shell/app-navigation.svelte; apps/web/src/lib/features/shell/navigation.ts; apps/web/src/lib/features/shell/error-shell.svelte; apps/web/svelte-shadow/routes/+error.svelte',
    test: 'apps/web/e2e/svelte-shell.spec.ts › restores Svelte history and scroll without feedback loops; renders retryable route errors and the default accessible Not Found shell',
  },
  'apps/web/src/routes/__root.tsx': {
    source:
      'apps/web/svelte-shadow/routes/+layout.server.ts; apps/web/svelte-shadow/routes/+layout.ts; apps/web/svelte-shadow/routes/+layout.svelte; apps/web/src/lib/features/shell/app-shell.svelte; apps/web/src/lib/query/provider.svelte',
    test: 'apps/web/src/lib/features/shell/query-load.test.ts; apps/web/e2e/svelte-shell.spec.ts › server-renders and reloads every Svelte shell route with accessible navigation',
  },
};
const completeProductionReplacement = (record: ParityRecord): ParityRecord => {
  const replacement = productionReplacementBySource[record.currentOwner];
  if (replacement === undefined) {
    throw new Error(`Missing R1 replacement evidence for ${record.currentOwner}`);
  }
  return completeRecord(record, [
    targetEvidence('source', replacement.source),
    targetEvidence('test', replacement.test),
    targetEvidence(
      'command',
      'bun run --cwd apps/web test:e2e-svelte-shadow (6 passed); bun run check; bun run lint; bun run typecheck; bun run test; bun run build',
    ),
    reviewEvidence,
  ]);
};
const completePlaywrightTitle = (record: ParityRecord): ParityRecord =>
  completeNewRecord(record, [
    targetEvidence('test', record.id.replace('pw:', '').replace('::', ' › ')),
    targetEvidence('command', 'bun run --cwd apps/web test:e2e-svelte-shadow (6 passed)'),
    reviewEvidence,
  ]);

export default defineParityShard({
  owner,
  records: [
    feature(
      'SHELL-01',
      'apps/web/src/app-navigation.tsx; apps/web/src/routes/__root.tsx',
      'apps/web/e2e/accessibility.spec.ts › shared navigation and deep-scroll cases',
      'apps/web/src/lib/features/shell/app-navigation.svelte; apps/web/src/lib/features/shell/app-shell.svelte; apps/web/svelte-shadow/routes/+layout.svelte',
      'apps/web/e2e/svelte-shell.spec.ts › server-renders and reloads every Svelte shell route with accessible navigation; blocks dirty navigation through Keep, Discard, reload, focus, and cleanup',
    ),
    feature(
      'SHELL-02',
      'apps/web/src/dashboard-theme.tsx; apps/web/src/routes/__root.tsx',
      'apps/web/e2e/theme.spec.ts; apps/web/e2e/accessibility.spec.ts › focus and reduced motion',
      'apps/web/src/lib/features/shell/theme.ts; apps/web/src/lib/features/shell/theme-toggle.svelte; apps/web/svelte-shadow/app.html',
      'apps/web/e2e/svelte-shell.spec.ts › resolves stored and system theme before paint and toggles the named preference',
    ),
    feature(
      'SHELL-03',
      'apps/web/src/router.tsx; apps/web/src/routes/index.tsx',
      'apps/web/e2e/dashboard.spec.ts › retries a failed report through the Router loading lifecycle',
      'apps/web/src/lib/features/shell/error-shell.svelte; apps/web/svelte-shadow/routes/+error.svelte; apps/web/svelte-shadow/routes/+page.server.ts',
      'apps/web/e2e/svelte-shell.spec.ts › restores Svelte history and scroll without feedback loops; renders retryable route errors and the default accessible Not Found shell',
    ),
    feature(
      'PRIVACY-01',
      'apps/web/src/server/demo-boundary.server.ts; apps/web/src/demo-route-guard.ts',
      'apps/web/e2e/demo-privacy.spec.ts › serves only the synthetic report and keeps every local boundary inert',
      'apps/web/src/lib/features/shell/demo-policy.server.ts; apps/web/svelte-shadow/hooks.server.ts',
      'apps/web/src/lib/features/shell/demo-policy.server.test.ts; apps/web/e2e/svelte-shell.spec.ts › redirects Svelte demo routes before protected acquisition',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/app-navigation.tsx',
      'apps/web/src/dashboard-theme.tsx',
      'apps/web/src/router.tsx',
      'apps/web/src/routes/__root.tsx',
    ]).map(completeProductionReplacement),
    ...playwrightTitleRecords(
      owner,
      [
        'server-renders and reloads every Svelte shell route with accessible navigation',
        'resolves stored and system theme before paint and toggles the named preference',
        'restores Svelte history and scroll without feedback loops',
        'renders retryable route errors and the default accessible Not Found shell',
        'redirects Svelte demo routes before protected acquisition',
        'blocks dirty navigation through Keep, Discard, reload, focus, and cleanup',
      ].map((title) => ({ file: 'apps/web/e2e/svelte-shell.spec.ts', title })),
    ).map(completePlaywrightTitle),
  ],
});
