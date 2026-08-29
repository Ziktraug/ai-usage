import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { querySkillObservations, queryUsageStoreGeneration, type UsageStoreError } from './reader';
import { importSkillObservations, retainSkillObservations } from './writer';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-a';
const ARGUMENT_COLUMN_PATTERN = /arg(ument)?s$/u;

const observation = (overrides: Partial<SkillObservation> = {}): SkillObservation => ({
  argsPresent: false,
  harnessKey: 'claude',
  observationKey: 'toolu_01',
  observedAt: '2026-08-01T09:00:00.000Z',
  projectPath: '/home/alex/Projects/report',
  resolvedPath: '/home/alex/.claude/skills/improve',
  sessionId: 'session-1',
  skillName: 'improve',
  success: true,
  tier: 'declared',
  ...overrides,
});

const createStore = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), `usage-store-${name}-`));
  temporaryRoots.push(root);
  return path.join(root, 'usage-store.sqlite');
};

describe('skill observation store', () => {
  test('round-trips an observation whose resolved path is null', async () => {
    const dbPath = await createStore('skill-null-path');
    const bundled = observation({
      observationKey: 'toolu_bundled',
      resolvedPath: null,
      skillName: 'artifact-design',
    });

    const imported = await Effect.runPromise(
      importSkillObservations({ dbPath, machineId: MACHINE, observations: [bundled] }),
    );
    const read = await Effect.runPromise(querySkillObservations({ dbPath }));

    expect(imported).toEqual({ inserted: 1, rejected: 0, unchanged: 0, updated: 0 });
    expect(read.skipped).toBe(0);
    expect(read.truncated).toBe(false);
    // The read path re-validates every persisted row, so a null resolved path
    // has to survive validation, not merely survive the write.
    expect(read.observations.map(({ observation: value }) => value)).toEqual([bundled]);
    expect(read.observations[0]?.machineId).toBe(MACHINE);
  });

  test('keeps declared, inferred, and exposed observations of one skill apart', async () => {
    const dbPath = await createStore('skill-tiers');
    await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [
          observation({ harnessKey: 'claude', observationKey: 'a', tier: 'declared' }),
          observation({ argsPresent: null, harnessKey: 'codex', observationKey: 'b', success: null, tier: 'inferred' }),
          observation({ argsPresent: null, harnessKey: 'codex', observationKey: 'c', success: null, tier: 'exposed' }),
        ],
      }),
    );

    const all = await Effect.runPromise(querySkillObservations({ dbPath, skillName: 'improve' }));
    const declared = await Effect.runPromise(querySkillObservations({ dbPath, tier: 'declared' }));
    const inferred = await Effect.runPromise(querySkillObservations({ dbPath, tier: 'inferred' }));
    const exposed = await Effect.runPromise(querySkillObservations({ dbPath, tier: 'exposed' }));

    expect(all.observations).toHaveLength(3);
    expect(declared.observations).toHaveLength(1);
    expect(inferred.observations).toHaveLength(1);
    expect(exposed.observations).toHaveLength(1);
    expect(all.observations.map(({ observation: value }) => value.tier).sort()).toEqual([
      'declared',
      'exposed',
      'inferred',
    ]);
  });

  test('re-importing an unchanged observation does not multiply the count', async () => {
    const dbPath = await createStore('skill-idempotent');
    const first = await Effect.runPromise(
      importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation()] }),
    );
    const second = await Effect.runPromise(
      importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation()] }),
    );
    const read = await Effect.runPromise(querySkillObservations({ dbPath }));

    expect(first).toEqual({ inserted: 1, rejected: 0, unchanged: 0, updated: 0 });
    expect(second).toEqual({ inserted: 0, rejected: 0, unchanged: 1, updated: 0 });
    expect(read.observations).toHaveLength(1);
  });

  test('the same observation key in two harnesses is two observations', async () => {
    const dbPath = await createStore('skill-harness-scope');
    await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [
          observation({ harnessKey: 'claude', observationKey: 'shared' }),
          observation({ argsPresent: null, harnessKey: 'opencode', observationKey: 'shared' }),
        ],
      }),
    );

    const read = await Effect.runPromise(querySkillObservations({ dbPath }));
    expect(read.observations.map(({ observation: value }) => value.harnessKey).sort()).toEqual(['claude', 'opencode']);
  });

  test('counts a malformed observation as rejected instead of dropping it silently', async () => {
    const dbPath = await createStore('skill-rejected');
    const result = await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [observation(), { harnessKey: 'claude', skillName: 'improve' }, { tier: 'nonsense' }],
      }),
    );

    expect(result).toEqual({ inserted: 1, rejected: 2, unchanged: 0, updated: 0 });
  });

  test('the table holds exactly the expected columns, so no argument column can be added', async () => {
    const dbPath = await createStore('skill-no-args');
    await Effect.runPromise(
      importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation({ argsPresent: true })] }),
    );

    const store = new Database(dbPath, { create: false, readonly: true });
    const columns = store.query('PRAGMA table_info(skill_observations)').all() as { name: string }[];
    store.close(true);

    // Asserted as an exact set rather than an absence check: `args_text` or
    // `input_args` would slip past a test that only proves one name is missing.
    // Widening this list is a deliberate act, and adding a column that holds
    // argument prose would violate ADR 0022.
    expect(columns.map(({ name }) => name).sort()).toEqual([
      'args_present',
      'first_observed_at',
      'harness_key',
      'id',
      'last_observed_at',
      'machine_id',
      'observation_key',
      'observed_at',
      'project_path',
      'resolved_path',
      'session_id',
      'skill_name',
      'success',
      'tier',
    ]);
    expect(columns.some(({ name }) => ARGUMENT_COLUMN_PATTERN.test(name))).toBe(false);
  });

  test('a changed extraction under the same identity is reported as an update and bumps the generation', async () => {
    const dbPath = await createStore('skill-updated');
    await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [observation({ resolvedPath: '/home/alex/.claude/skills/old' })],
      }),
    );
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    // The same harness call, re-read by a collector that now resolves the path
    // correctly. The row is rewritten, so saying "unchanged" would be false.
    const corrected = await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [observation({ resolvedPath: '/home/alex/.claude/skills/new' })],
      }),
    );
    const read = await Effect.runPromise(querySkillObservations({ dbPath }));

    expect(corrected).toEqual({ inserted: 0, rejected: 0, unchanged: 0, updated: 1 });
    expect(read.observations).toHaveLength(1);
    expect(read.observations[0]?.observation.resolvedPath).toBe('/home/alex/.claude/skills/new');
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBeGreaterThan(generationBefore);
  });

  test('every semantic field is compared, so no durable rewrite reports as unchanged', async () => {
    const variants = [
      observation({ skillName: 'other-skill' }),
      observation({ observedAt: '2026-08-02T09:00:00.000Z' }),
      observation({ projectPath: '/home/alex/Projects/other' }),
      observation({ resolvedPath: null }),
      observation({ argsPresent: true }),
      observation({ success: false }),
    ];

    for (const [index, variant] of variants.entries()) {
      const dbPath = await createStore(`skill-field-${index}`);
      await Effect.runPromise(importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation()] }));
      const result = await Effect.runPromise(
        importSkillObservations({ dbPath, machineId: MACHINE, observations: [variant] }),
      );
      expect(result.updated).toBe(1);
      expect(result.unchanged).toBe(0);
    }
  });

  test('an unchanged re-import does not advance the store generation', async () => {
    const dbPath = await createStore('skill-generation');
    await Effect.runPromise(importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation()] }));

    const generationAfterInsert = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    const repeat = await Effect.runPromise(
      importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation()] }),
    );
    const generationAfterRepeat = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    // The collectors re-import the same observations on every sweep. Bumping the
    // generation for an unchanged repeat would invalidate the served report once
    // per collection cycle for no reason.
    expect(repeat).toEqual({ inserted: 0, rejected: 0, unchanged: 1, updated: 0 });
    expect(generationAfterRepeat).toBe(generationAfterInsert);

    const added = await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [observation({ observationKey: 'toolu_02' })],
      }),
    );
    expect(added.inserted).toBe(1);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBeGreaterThan(generationAfterRepeat);
  });

  test('rejects a read budget outside its bounds', async () => {
    const dbPath = await createStore('skill-budget');
    await Effect.runPromise(importSkillObservations({ dbPath, machineId: MACHINE, observations: [observation()] }));

    const result = await Effect.runPromise(Effect.either(querySkillObservations({ dbPath, maximumObservations: 0 })));

    expect(result._tag).toBe('Left');
    expect((result as { left: UsageStoreError }).left.reason).toBe('invalid-input');
  });

  test('retention deletes whole observations older than the window and keeps the rest', async () => {
    const dbPath = await createStore('skill-retention');
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    await Effect.runPromise(
      importSkillObservations({
        dbPath,
        machineId: MACHINE,
        observations: [
          observation({ observationKey: 'old', observedAt: '2024-01-01T00:00:00.000Z' }),
          observation({ observationKey: 'recent', observedAt: '2026-07-31T00:00:00.000Z' }),
        ],
      }),
    );

    const retained = await Effect.runPromise(
      retainSkillObservations({ dbPath, now, retentionMs: 30 * 24 * 60 * 60 * 1000 }),
    );
    const read = await Effect.runPromise(querySkillObservations({ dbPath }));

    expect(retained.deleted).toBe(1);
    expect(read.observations.map(({ observation: value }) => value.observationKey)).toEqual(['recent']);
  });
});

/**
 * The ratio these tests use is the one measured on the operator's real store: 78,442 `exposed` rows
 * against 1,481 invocations, because Codex writes one exposure row per catalogue entry per session.
 * Every earlier fixture was small and balanced, which is exactly why a pooled read budget looked
 * correct for months.
 */
describe('skill observation read budgets, at the ratio a real store has', () => {
  const EXPOSED_COUNT = 600;
  const INFERRED_COUNT = 20;
  const DECLARED_COUNT = 10;

  const at = (minute: number): string => new Date(Date.UTC(2026, 7, 1, 0, minute)).toISOString();

  /**
   * Exposure is strictly *more recent* than every invocation, so a recency-ordered pooled read
   * cannot see a single invocation once the budget is smaller than the exposure count. That is the
   * real store's shape: months of invocation history sitting behind three weeks of catalogue rows.
   */
  const floodedStore = async (name: string): Promise<string> => {
    const dbPath = await createStore(name);
    const invocations = [
      ...Array.from({ length: DECLARED_COUNT }, (_value, index) =>
        observation({
          harnessKey: 'claude',
          observationKey: `declared-${index}`,
          observedAt: at(index),
          skillName: `used-skill-${index % 5}`,
          tier: 'declared',
        }),
      ),
      ...Array.from({ length: INFERRED_COUNT }, (_value, index) =>
        observation({
          harnessKey: 'codex',
          observationKey: `inferred-${index}`,
          observedAt: at(DECLARED_COUNT + index),
          skillName: `used-skill-${index % 5}`,
          tier: 'inferred',
        }),
      ),
    ];
    const exposures = Array.from({ length: EXPOSED_COUNT }, (_value, index) =>
      observation({
        harnessKey: 'codex',
        observationKey: `exposed-${index}`,
        observedAt: at(1000 + index),
        skillName: `catalogue-skill-${index % 190}`,
        tier: 'exposed',
      }),
    );
    await Effect.runPromise(
      importSkillObservations({ dbPath, machineId: MACHINE, observations: [...invocations, ...exposures] }),
    );
    return dbPath;
  };

  const tierCounts = (read: { observations: { observation: SkillObservation }[] }): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const { observation: value } of read.observations) {
      counts[value.tier] = (counts[value.tier] ?? 0) + 1;
    }
    return counts;
  };

  test('reads every invocation first, and spends only what is left on the exposure catalogue', async () => {
    const dbPath = await floodedStore('skill-tier-budget');

    const read = await Effect.runPromise(querySkillObservations({ dbPath, maximumObservations: 100 }));

    // The whole point: a budget far below the exposure count still returns every invocation.
    expect(tierCounts(read)).toEqual({ declared: DECLARED_COUNT, exposed: 70, inferred: INFERRED_COUNT });
    expect(read.observations).toHaveLength(100);
    // Something was left behind, and the response says *which* group. Under a pooled read this
    // budget would have returned 100 exposure rows and no invocation at all.
    expect(read.truncated).toBe(true);
    expect(read.invocationTruncated).toBe(false);
  });

  test('reports the invocation bound when the invocation tiers outgrow the budget themselves', async () => {
    const dbPath = await floodedStore('skill-tier-budget-invocation');

    const read = await Effect.runPromise(querySkillObservations({ dbPath, maximumObservations: 12 }));

    // Now the scarce evidence is itself short, which is the one case an absence claim must not be
    // made on. No exposure row is read at all: the invocation tiers spend the entire budget.
    expect(tierCounts(read)).toEqual({ inferred: 12 });
    expect(read.invocationTruncated).toBe(true);
    expect(read.truncated).toBe(true);
  });

  test('spends nothing on exposure when invocations exactly fill the budget, and still reports it', async () => {
    const dbPath = await floodedStore('skill-tier-budget-exact');

    const read = await Effect.runPromise(
      querySkillObservations({ dbPath, maximumObservations: DECLARED_COUNT + INFERRED_COUNT }),
    );

    // The invocation read fits exactly, so it is *not* truncated — but exposure got a budget of
    // zero, and rows it could not return still exist. A zero-budget page is an existence probe, so
    // the pooled bound is still honest.
    expect(tierCounts(read)).toEqual({ declared: DECLARED_COUNT, inferred: INFERRED_COUNT });
    expect(read.invocationTruncated).toBe(false);
    expect(read.truncated).toBe(true);
  });

  test('returns a complete read as complete when the budget covers everything', async () => {
    const dbPath = await floodedStore('skill-tier-budget-complete');

    const read = await Effect.runPromise(querySkillObservations({ dbPath, maximumObservations: 5000 }));

    expect(read.observations).toHaveLength(EXPOSED_COUNT + INFERRED_COUNT + DECLARED_COUNT);
    expect(read.truncated).toBe(false);
    expect(read.invocationTruncated).toBe(false);
  });

  test('keeps the read in recency order across the two tier pages', async () => {
    const dbPath = await floodedStore('skill-tier-budget-order');

    const read = await Effect.runPromise(querySkillObservations({ dbPath, maximumObservations: 100 }));
    const observedAt = read.observations.map(({ observation: value }) => value.observedAt);

    // Selecting per tier group must not change the order this read documents, only which rows it
    // selects. Callers that assume "most recent first" keep that guarantee.
    expect(observedAt).toEqual([...observedAt].sort().reverse());
  });

  test('a caller that names one tier gets that tier, and only invocation tiers set the invocation bound', async () => {
    const dbPath = await floodedStore('skill-tier-budget-filtered');

    const exposed = await Effect.runPromise(
      querySkillObservations({ dbPath, maximumObservations: 5, tier: 'exposed' }),
    );
    const inferred = await Effect.runPromise(
      querySkillObservations({ dbPath, maximumObservations: 5, tier: 'inferred' }),
    );

    expect(tierCounts(exposed)).toEqual({ exposed: 5 });
    expect(exposed.truncated).toBe(true);
    // A short read of the catalogue is not a short read of the evidence.
    expect(exposed.invocationTruncated).toBe(false);

    expect(tierCounts(inferred)).toEqual({ inferred: 5 });
    expect(inferred.truncated).toBe(true);
    expect(inferred.invocationTruncated).toBe(true);
  });
});
