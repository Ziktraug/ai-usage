import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { normalizeClaudeAgentSdkQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { SourceControlEntryView } from '@ai-usage/report-core/source-control';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import {
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createRoutingQualificationService, executorRunOutcome } from './routing-qualification';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const STARTED = '2026-10-22T10:00:00.000Z';
const NOW = new Date('2026-10-22T10:00:05.000Z');
const SIGNED_IN = '0123456789abcdef';
const KEY = JSON.stringify([machine.id, 'claude-code', 'personal']);
const PRIMARY_ID = `declared:${KEY}`;
const OPUS_ID = `declared:${KEY}:model:1:Opus`;
const command = {
  command: 'qualify-review-routing',
  target: { desktopSessionId: null, harness: 'claude', sourceSessionId: 'cli-1' },
} as const;

const executorsEntry = (overrides: Partial<SourceControlEntryView> = {}): SourceControlEntryView => ({
  availability: 'detected',
  cadenceMs: 15 * 60_000,
  id: 'executors.capabilities',
  label: 'Executors',
  lastFinishedAt: '2026-10-22T10:00:02.000Z',
  lastOutcome: 'success',
  lifecycle: 'scheduled',
  policy: 'enabled',
  reason: { code: 'none' },
  warnings: [],
  ...overrides,
});

const observation = (overrides: Partial<ExecutorObservation> = {}): ExecutorObservation => ({
  accountFingerprint: SIGNED_IN,
  authEvidence: 'claude auth status exit 0 loggedIn=true authMethod=claude.ai',
  authMethod: 'claude.ai',
  authState: 'logged-in',
  binaryPath: '/usr/bin/claude',
  harness: 'claude-code',
  machineId: machine.id,
  observedAt: '2026-10-22T10:00:01.000Z',
  outcome: 'observed',
  version: '2.1.306 (Claude Code)',
  ...overrides,
});

const writeDeclaration = async (home: string, executor: Record<string, unknown>): Promise<void> => {
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    JSON.stringify({ routing: { executors: [executor] } }),
    { mode: 0o600 },
  );
};

const declared = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountFingerprint: SIGNED_IN,
  accountScope: 'personal',
  alternateModels: ['Opus'],
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  harness: 'claude-code',
  model: 'Fable',
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
  ...overrides,
});

/** A disposable home and store: the Fable window exhausted, the all-models window not. */
const createFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-routing-qualification-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const dbPath = path.join(root, 'state', 'usage.sqlite');
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  await writeDeclaration(home, declared());
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: NOW }));
  await Effect.runPromise(importExecutorObservations({ dbPath, observations: [observation()] }));
  const quota = normalizeClaudeAgentSdkQuotaObservation({
    machineId: machine.id,
    machineLabel: machine.label,
    observedAt: '2026-10-22T09:58:00.000Z',
    result: {
      rate_limits: {
        limits: [
          { group: 'session', kind: 'session', percent: 12, resets_at: '2026-10-22T13:00:00.000Z', scope: null },
          { group: 'weekly', kind: 'weekly_all', percent: 40, resets_at: '2026-10-25T05:00:00.000Z', scope: null },
        ],
        model_scoped: [{ display_name: 'Fable', resets_at: '2026-10-24T05:00:00.000Z', utilization: 100 }],
      },
      rate_limits_available: true,
      subscription_type: 'max',
    },
  });
  if (!quota) {
    throw new Error('fixture quota did not normalize');
  }
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [{ observation: quota, sourceEventKey: 'fixture-quota-1' }],
    }),
  );
  const service = createRoutingQualificationService({ dbPath, machine: () => machine, now: () => NOW, storage });
  return { dbPath, home, service };
};

describe('engine routing qualification (ADR 0057)', () => {
  test('decides the case of the day from the facts it re-reads: Opus runs, Fable is excluded by its own limit', async () => {
    const { service } = await createFixture();
    const output = await service.qualify(command, { source: executorsEntry(), startedAt: STARTED });
    const { qualification } = output;
    expect(output.kind).toBe('routing-qualification');
    expect(qualification.qualifiedAt).toBe(NOW.toISOString());
    expect(qualification.executors).toEqual({ outcome: 'success', refreshed: true });
    expect(qualification.recommendation).toEqual({ candidateId: OPUS_ID, kind: 'real', missing: null });
    expect(qualification.candidates.map((entry) => [entry.candidateId, entry.model, entry.eligible])).toEqual([
      [OPUS_ID, 'Opus', true],
      [PRIMARY_ID, 'Fable', false],
    ]);
    expect(qualification.candidates[0]?.identity).toMatchObject({ state: 'confirmed' });
    expect(qualification.candidates[1]?.exclusionReasons).toContain(
      'Quota window Fable · Weekly is exhausted or blocked.',
    );
    expect(qualification.reasons.join(' ')).toContain('Fable, Opus are models of one account (personal)');
    // Nothing in the decision restates report rows, windows or the declaration file.
    expect(JSON.stringify(qualification)).not.toContain('usedPercent');
  });

  test('a change of account observed after the declaration invalidates the route until it is re-declared', async () => {
    const { dbPath, home, service } = await createFixture();
    const other = 'fedcba9876543210';
    await Effect.runPromise(
      importExecutorObservations({
        dbPath,
        observations: [observation({ accountFingerprint: other, observedAt: '2026-10-22T10:00:03.000Z' })],
      }),
    );
    const invalidated = (await service.qualify(command, { source: executorsEntry(), startedAt: STARTED }))
      .qualification;
    expect(invalidated.recommendation.kind).toBe('none');
    expect(invalidated.candidates.every((entry) => entry.identity?.state === 'contradicted')).toBe(true);
    expect(invalidated.candidates[0]?.actions.join(' ')).toContain('Claude Code is signed in to another account');

    // The declaration is re-read on every qualification: pinning the new account requalifies it.
    await writeDeclaration(home, declared({ accountFingerprint: other, declaredAt: '2026-10-22T10:00:04.000Z' }));
    const requalified = (await service.qualify(command, { source: executorsEntry(), startedAt: STARTED }))
      .qualification;
    expect(requalified.recommendation).toEqual({ candidateId: OPUS_ID, kind: 'real', missing: null });
  });

  test('an unpinned declaration is conditional on the pin, named with the observed fingerprint', async () => {
    const { home, service } = await createFixture();
    await writeDeclaration(
      home,
      declared({ accountFingerprint: undefined, alternateModels: undefined, model: 'Opus' }),
    );
    const { qualification } = await service.qualify(command, { source: executorsEntry(), startedAt: STARTED });
    expect(qualification.recommendation).toEqual({
      candidateId: PRIMARY_ID,
      kind: 'conditional',
      missing: 'account identity pin (routing.executors[].accountFingerprint)',
    });
    expect(qualification.candidates[0]?.actions[0]).toContain(`"accountFingerprint": "${SIGNED_IN}"`);
  });

  test('says when the executor observation could not be refreshed for this qualification', () => {
    expect(executorRunOutcome({ source: null, startedAt: STARTED })).toEqual({ outcome: 'not-run', refreshed: false });
    expect(executorRunOutcome({ source: executorsEntry({ policy: 'disabled' }), startedAt: STARTED })).toEqual({
      outcome: 'disabled',
      refreshed: false,
    });
    expect(
      executorRunOutcome({ source: executorsEntry({ availability: 'not-detected' }), startedAt: STARTED }),
    ).toEqual({ outcome: 'not-detected', refreshed: false });
    expect(
      executorRunOutcome({
        source: executorsEntry({ lastFinishedAt: '2026-10-22T09:45:00.000Z' }),
        startedAt: STARTED,
      }),
    ).toEqual({ outcome: 'success', refreshed: false });
    expect(executorRunOutcome({ source: executorsEntry({ lastOutcome: 'timed-out' }), startedAt: STARTED })).toEqual({
      outcome: 'timed-out',
      refreshed: false,
    });
    expect(executorRunOutcome({ source: executorsEntry({ lastOutcome: 'warning' }), startedAt: STARTED })).toEqual({
      outcome: 'warning',
      refreshed: true,
    });
  });
});
