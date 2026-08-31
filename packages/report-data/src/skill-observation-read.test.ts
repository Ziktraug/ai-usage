import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { completeSkillObservationCollection, type SkillObservation } from '@ai-usage/report-core/skill-observation';
import {
  SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS,
  skillObservationHarnessInvocationIsComplete,
} from '@ai-usage/report-core/skill-observation-evidence';
import { importSkillObservations } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { querySkillObservationDataset } from './skill-observation-read';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A C0 control character, written as an escape so it survives every editor and diff viewer. */
const BELL = String.fromCodePoint(0x07);

const GENEROUS_BOUNDS = {
  maximumBytes: 2 * 1024 * 1024,
  maximumObservations: 50_000,
  maximumSkills: 4096,
} as const;
const EXPECTED_OBSERVABLE_HARNESSES = SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS;

const observation = (skillName: string, ordinal: number): SkillObservation => ({
  argsPresent: null,
  harnessKey: 'claude',
  observationKey: `observation-${ordinal}`,
  observedAt: '2026-08-01T09:00:00.000Z',
  projectPath: '/home/alex/Projects/report',
  resolvedPath: null,
  sessionId: 'session-1',
  skillName,
  success: null,
  tier: 'declared',
});

const storeHolding = async (observations: readonly SkillObservation[]): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan111-skill-observation-read-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  const harnessKeys = [...new Set(observations.map(({ harnessKey }) => harnessKey))];
  for (const harnessKey of harnessKeys) {
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness: completeSkillObservationCollection(), harnessKey },
        dbPath,
        machineId: 'machine-a',
        observations: observations.filter((candidate) => candidate.harnessKey === harnessKey),
      }),
    );
  }
  if (harnessKeys.length === 0) {
    await Effect.runPromise(importSkillObservations({ dbPath, machineId: 'machine-a', observations: [] }));
  }
  return dbPath;
};

const storeWith = async (skillCount: number): Promise<string> =>
  await storeHolding(
    Array.from({ length: skillCount }, (_, index) => observation(`skill-${String(index).padStart(5, '0')}`, index)),
  );

describe('bounded skill observation read', () => {
  test('carries one producer rejection through as that harness alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan111-skill-observation-scope-'));
    roots.push(root);
    const dbPath = path.join(root, 'usage.sqlite');
    for (const harnessKey of EXPECTED_OBSERVABLE_HARNESSES) {
      await Effect.runPromise(
        importSkillObservations({
          collection: {
            completeness:
              harnessKey === 'codex'
                ? { exposure: { rejected: 0, truncated: false }, invocation: { rejected: 1, truncated: false } }
                : completeSkillObservationCollection(),
            harnessKey,
          },
          dbPath,
          machineId: 'machine-a',
          observations: harnessKey === 'claude' ? [observation('improve', 1), observation('improve', 2)] : [],
        }),
      );
    }

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({
        dbPath,
        ...GENEROUS_BOUNDS,
        expectedProducerHarnessKeys: EXPECTED_OBSERVABLE_HARNESSES,
        machineId: 'machine-a',
      }),
    );

    expect(dataset.harnessIncompleteness.invocation).toEqual(['codex']);
    expect(dataset.harnessIncompleteness.invocationUnattributed).toBe(false);
    expect(skillObservationHarnessInvocationIsComplete(dataset, 'claude')).toBe(true);
    expect(skillObservationHarnessInvocationIsComplete(dataset, 'codex')).toBe(false);
    // The Claude Code count is exact even though the response as a whole cannot prove an absence.
    expect(dataset.skills[0]?.tallies).toEqual([
      {
        count: 2,
        harnessKey: 'claude',
        harnessLabel: 'Claude Code',
        lastObservedAt: '2026-08-01T09:00:00.000Z',
        tier: 'declared',
      },
    ]);
    expect(dataset.invocationLowerBound).toBe(true);
  });

  test('attributes a skill-count clamp to the harnesses whose rows it dropped', async () => {
    const dbPath = await storeWith(4);

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS, maximumSkills: 2 }),
    );

    expect(dataset.skills).toHaveLength(2);
    expect(dataset.harnessIncompleteness.invocation).toEqual(['claude']);
    expect(dataset.harnessIncompleteness.invocationUnattributed).toBe(false);
    expect(skillObservationHarnessInvocationIsComplete(dataset, 'opencode')).toBe(true);
  });

  test('requires every expected producer before an empty global read becomes complete', async () => {
    const dbPath = await storeHolding([]);
    const read = () =>
      Effect.runPromise(
        querySkillObservationDataset({
          dbPath,
          ...GENEROUS_BOUNDS,
          expectedProducerHarnessKeys: EXPECTED_OBSERVABLE_HARNESSES,
          machineId: 'machine-a',
        }),
      );

    expect(await read()).toMatchObject({
      invocationLowerBound: true,
      lowerBound: true,
      producerCompletenessMissing: true,
    });
    for (const harnessKey of EXPECTED_OBSERVABLE_HARNESSES) {
      await Effect.runPromise(
        importSkillObservations({
          collection: { completeness: completeSkillObservationCollection(), harnessKey },
          dbPath,
          machineId: 'machine-a',
          observations: [],
        }),
      );
      const dataset = await read();
      const allProducersCompleted = harnessKey === 'opencode';
      expect(dataset.producerCompletenessMissing).toBe(!allProducersCompleted);
      expect(dataset.invocationLowerBound).toBe(!allProducersCompleted);
    }
  });

  test('preserves the store-anchored producer proof deadline through folding', async () => {
    const dbPath = await storeHolding([]);
    for (const harnessKey of EXPECTED_OBSERVABLE_HARNESSES) {
      await Effect.runPromise(
        importSkillObservations({
          collection: { completeness: completeSkillObservationCollection(), harnessKey },
          dbPath,
          importedAt: new Date('2026-08-01T10:00:00.000Z'),
          machineId: 'machine-a',
          observations: [],
        }),
      );
    }

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({
        dbPath,
        ...GENEROUS_BOUNDS,
        expectedProducerHarnessKeys: EXPECTED_OBSERVABLE_HARNESSES,
        machineId: 'machine-a',
        minimumProducerCollectedAt: '2026-08-01T09:56:00.000Z',
      }),
    );

    expect(dataset.producerProofValidUntil).toBe('2026-08-01T10:01:00.000Z');
  });

  test('treats an empty store without producer state as pre-collection invocation evidence', async () => {
    const dbPath = await storeHolding([]);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills).toEqual([]);
    expect(dataset.invocationLowerBound).toBe(true);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.producerCompletenessMissing).toBe(true);
  });

  test('treats an explicit complete empty sweep as complete invocation evidence', async () => {
    const dbPath = await storeHolding([]);
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness: completeSkillObservationCollection(), harnessKey: 'claude' },
        dbPath,
        machineId: 'machine-a',
        observations: [],
      }),
    );

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills).toEqual([]);
    expect(dataset.invocationLowerBound).toBe(false);
    expect(dataset.lowerBound).toBe(false);
    expect(dataset.producerCompletenessMissing).toBe(false);
  });

  test('answers a store holding exactly the cap without claiming a bound', async () => {
    const dbPath = await storeWith(GENEROUS_BOUNDS.maximumSkills);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills).toHaveLength(GENEROUS_BOUNDS.maximumSkills);
    expect(dataset.lowerBound).toBe(false);
    expect(dataset.invocationLowerBound).toBe(false);
  });

  test('clamps one past the cap and says so instead of failing the whole read', async () => {
    const dbPath = await storeWith(GENEROUS_BOUNDS.maximumSkills + 1);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    // Without the clamp this response would exceed what the contract accepts and the whole
    // procedure would fail — turning "you have a lot of history" into "observations are unavailable".
    expect(dataset.skills).toHaveLength(GENEROUS_BOUNDS.maximumSkills);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(true);
  });

  test('keeps an exposure-only skill clamp out of the invocation bound', async () => {
    const dbPath = await storeHolding(
      Array.from({ length: 4 }, (_value, index) => ({
        ...observation(`catalogue-skill-${index}`, index),
        harnessKey: 'codex',
        tier: 'exposed' as const,
      })),
    );

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS, maximumSkills: 3 }),
    );

    expect(dataset.skills).toHaveLength(3);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(false);
  });

  test('clamps to the byte budget and reports that as a lower bound too', async () => {
    const dbPath = await storeWith(64);

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS, maximumBytes: 2048 }),
    );

    expect(new TextEncoder().encode(JSON.stringify(dataset)).byteLength).toBeLessThanOrEqual(2048);
    expect(dataset.skills.length).toBeLessThan(64);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(true);
  });

  test('reports the observation-row bound it reached', async () => {
    const dbPath = await storeWith(10);

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS, maximumObservations: 4 }),
    );

    expect(dataset.skills).toHaveLength(4);
    expect(dataset.lowerBound).toBe(true);
  });

  test('leaves a comfortable read unbounded and complete', async () => {
    const dbPath = await storeWith(3);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills.map(({ skillName }) => skillName)).toEqual(['skill-00000', 'skill-00001', 'skill-00002']);
    expect(dataset.lowerBound).toBe(false);
    expect(dataset.skipped).toBe(0);
  });

  test('counts an unrenderable stored name as skipped instead of poisoning the whole response', async () => {
    // The store is permissive about names on purpose — tightening it would retroactively invalidate
    // history on disk — so a control character can legitimately be sitting in a persisted row. The
    // response schema is not permissive, and shipping that row would make it refuse *everything*:
    // one weird row would take the entire observation surface down.
    const dbPath = await storeHolding([
      observation('good-skill', 0),
      observation(`bad${BELL}skill`, 1),
      observation('another-good-skill', 2),
    ]);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills.map(({ skillName }) => skillName)).toEqual(['another-good-skill', 'good-skill']);
    // Refused at the presentation edge, reported through the channel that already means exactly
    // this: rows the reader could not re-validate, counted and never folded into a tally.
    expect(dataset.skipped).toBe(1);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(true);
    expect(dataset.producerCompletenessMissing).toBe(false);
  });

  test('counts an unrenderable exposed row without weakening invocation absence', async () => {
    const dbPath = await storeHolding([
      {
        ...observation(`catalogue${BELL}skill`, 0),
        harnessKey: 'codex',
        tier: 'exposed',
      },
    ]);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills).toEqual([]);
    expect(dataset.skipped).toBe(1);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(false);
  });

  test('keeps persisted exposure refusals separate while declared and unknown loss hedge absence', async () => {
    const exposedDbPath = await storeHolding([
      { ...observation('catalogue-skill', 0), harnessKey: 'codex', tier: 'exposed' },
    ]);
    const declaredDbPath = await storeHolding([observation('invoked-skill', 0)]);
    for (const dbPath of [exposedDbPath, declaredDbPath]) {
      const db = new Database(dbPath, { create: false, readwrite: true });
      db.query("UPDATE skill_observations SET observed_at = 'not-a-timestamp'").run();
      db.close(true);
    }
    const unknownDbPath = await storeHolding([]);
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness: completeSkillObservationCollection(), harnessKey: 'codex' },
        dbPath: unknownDbPath,
        machineId: 'machine-a',
        observations: [{ ...observation('unknown-skill', 0), observedAt: 'invalid', tier: 'future' }],
      }),
    );

    const exposed = await Effect.runPromise(
      querySkillObservationDataset({ dbPath: exposedDbPath, ...GENEROUS_BOUNDS }),
    );
    const declared = await Effect.runPromise(
      querySkillObservationDataset({ dbPath: declaredDbPath, ...GENEROUS_BOUNDS }),
    );
    const unknown = await Effect.runPromise(
      querySkillObservationDataset({ dbPath: unknownDbPath, ...GENEROUS_BOUNDS }),
    );

    expect(exposed).toMatchObject({ invocationLowerBound: false, lowerBound: true, skipped: 1 });
    expect(declared).toMatchObject({ invocationLowerBound: true, lowerBound: true, skipped: 1 });
    expect(unknown).toMatchObject({ invocationLowerBound: true, lowerBound: true, skipped: 0 });
  });

  test('carries producer-side invocation loss into the absence bound', async () => {
    const dbPath = await storeHolding([]);
    const completeness = completeSkillObservationCollection();
    completeness.invocation.truncated = true;
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness, harnessKey: 'claude' },
        dbPath,
        machineId: 'machine-a',
        observations: [],
      }),
    );

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));
    expect(dataset.skills).toEqual([]);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(true);
    expect(dataset.producerCompletenessMissing).toBe(false);
  });

  test('carries producer-side rejected invocations into the absence bound', async () => {
    const dbPath = await storeHolding([]);
    const completeness = completeSkillObservationCollection();
    completeness.invocation.rejected = 2;
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness, harnessKey: 'claude' },
        dbPath,
        machineId: 'machine-a',
        observations: [],
      }),
    );

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));
    expect(dataset.skills).toEqual([]);
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(true);
    expect(dataset.producerCompletenessMissing).toBe(false);
  });

  test('does not weaken invocation absence for exposure-only producer loss', async () => {
    const dbPath = await storeHolding([]);
    const completeness = completeSkillObservationCollection();
    completeness.exposure.truncated = true;
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness, harnessKey: 'codex' },
        dbPath,
        machineId: 'machine-a',
        observations: [],
      }),
    );

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(false);
    expect(dataset.producerCompletenessMissing).toBe(false);
  });
});

/**
 * The ratio measured on the operator's real store: 78,442 exposure rows against 1,481 invocations,
 * with the exposure rows more recent. Under a pooled read budget this shape returned zero invocation
 * evidence and the surface reported skills with hundreds of real reads as "offered but never
 * invoked".
 */
describe('skill observation read, against an exposure-flooded store', () => {
  const EXPOSED_COUNT = 600;
  const INFERRED_COUNT = 20;
  const DECLARED_COUNT = 10;
  const at = (minute: number): string => new Date(Date.UTC(2026, 7, 1, 0, minute)).toISOString();

  const floodedStore = async (): Promise<string> =>
    await storeHolding([
      ...Array.from({ length: DECLARED_COUNT }, (_value, index) => ({
        ...observation('used-skill', index),
        harnessKey: 'claude',
        observationKey: `declared-${index}`,
        observedAt: at(index),
        tier: 'declared' as const,
      })),
      ...Array.from({ length: INFERRED_COUNT }, (_value, index) => ({
        ...observation('used-skill', index),
        harnessKey: 'codex',
        observationKey: `inferred-${index}`,
        observedAt: at(DECLARED_COUNT + index),
        tier: 'inferred' as const,
      })),
      ...Array.from({ length: EXPOSED_COUNT }, (_value, index) => ({
        ...observation(`catalogue-skill-${index % 190}`, index),
        harnessKey: 'codex',
        observationKey: `exposed-${index}`,
        observedAt: at(1000 + index),
        tier: 'exposed' as const,
      })),
    ]);

  const talliesFor = (dataset: Awaited<ReturnType<typeof read>>, skillName: string) =>
    dataset.skills.find((skill) => skill.skillName === skillName)?.tallies ?? [];

  const read = async (maximumObservations: number) =>
    await Effect.runPromise(
      querySkillObservationDataset({ dbPath: await floodedStore(), ...GENEROUS_BOUNDS, maximumObservations }),
    );

  test('carries every invocation through the fold even when the catalogue dwarfs the budget', async () => {
    const dataset = await read(100);

    // Not one invocation is lost, and the counts are the real ones rather than whatever fitted.
    expect(talliesFor(dataset, 'used-skill').map(({ count, tier }) => [tier, count])).toEqual([
      ['declared', DECLARED_COUNT],
      ['inferred', INFERRED_COUNT],
    ]);
    // The counts are still floors, because the catalogue was cut — but the evidence behind an
    // absence verdict is whole, and the two bounds say so separately.
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(false);
  });

  test('reports the invocation bound when the invocation tiers themselves do not fit', async () => {
    const dataset = await read(12);

    expect(dataset.invocationLowerBound).toBe(true);
    expect(dataset.lowerBound).toBe(true);
  });

  test('clamping the skill list marks the invocation evidence incomplete', async () => {
    const dbPath = await floodedStore();

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS, maximumSkills: 3 }),
    );

    expect(dataset.skills).toHaveLength(3);
    // The dropped skills are re-added by the downstream inventory join with no tallies at all, which
    // reads as "never observed". That is an absence claim this read cannot support, so it says so.
    expect(dataset.invocationLowerBound).toBe(true);
    expect(dataset.lowerBound).toBe(true);
  });
});
