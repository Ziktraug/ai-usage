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
