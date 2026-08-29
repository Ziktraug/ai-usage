import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import { importSkillObservations } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { querySkillObservationDataset } from './skill-observation-read';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const GENEROUS_BOUNDS = {
  maximumBytes: 2 * 1024 * 1024,
  maximumObservations: 50_000,
  maximumSkills: 4096,
} as const;

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

const storeWith = async (skillCount: number): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan099-skill-observation-read-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(
    importSkillObservations({
      dbPath,
      machineId: 'machine-a',
      observations: Array.from({ length: skillCount }, (_, index) =>
        observation(`skill-${String(index).padStart(5, '0')}`, index),
      ),
    }),
  );
  return dbPath;
};

describe('bounded skill observation read', () => {
  test('answers a store holding exactly the cap without claiming a bound', async () => {
    const dbPath = await storeWith(GENEROUS_BOUNDS.maximumSkills);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    expect(dataset.skills).toHaveLength(GENEROUS_BOUNDS.maximumSkills);
    expect(dataset.lowerBound).toBe(false);
  });

  test('clamps one past the cap and says so instead of failing the whole read', async () => {
    const dbPath = await storeWith(GENEROUS_BOUNDS.maximumSkills + 1);

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS }));

    // Without the clamp this response would exceed what the contract accepts and the whole
    // procedure would fail — turning "you have a lot of history" into "observations are unavailable".
    expect(dataset.skills).toHaveLength(GENEROUS_BOUNDS.maximumSkills);
    expect(dataset.lowerBound).toBe(true);
  });

  test('clamps to the byte budget and reports that as a lower bound too', async () => {
    const dbPath = await storeWith(64);

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...GENEROUS_BOUNDS, maximumBytes: 2048 }),
    );

    expect(new TextEncoder().encode(JSON.stringify(dataset)).byteLength).toBeLessThanOrEqual(2048);
    expect(dataset.skills.length).toBeLessThan(64);
    expect(dataset.lowerBound).toBe(true);
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
});
