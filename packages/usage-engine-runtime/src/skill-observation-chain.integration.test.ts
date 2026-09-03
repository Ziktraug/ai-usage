import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSelectedHarnessResults } from '@ai-usage/local-collectors/collectors';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { FIXTURE_SKILL_NAMES, seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { querySkillObservationDataset } from '@ai-usage/report-data/skill-observation-read';
import { importSkillObservations } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';

/**
 * The whole chain, end to end, in one test: a seeded synthetic home, the real collectors, the real
 * store import, and the same bounded read the web read model runs.
 *
 * Every link of this was already covered on its own — collection in `local-collectors`, persistence
 * in `usage-store`, the read in `report-data`, the surface in Playwright. What none of them could
 * show is that a tier survives *all* of them: an extractor that stopped emitting `exposed`, an
 * import that dropped it, or a fold that merged it would leave every one of those suites green.
 * This is the test that fails when the fact family loses a tier somewhere between the transcript
 * and the answer.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const READ_BOUNDS = {
  maximumBytes: 2 * 1024 * 1024,
  maximumObservations: 20_000,
  maximumSkills: 4096,
} as const;

describe('skill observation chain', () => {
  test('carries all three tiers, and Cursor as not observable, from a seeded home to the read model', async () => {
    const home = await temporaryDirectory('plan111-chain-home-');
    const storeRoot = await temporaryDirectory('plan111-chain-store-');
    const dbPath = join(storeRoot, 'usage.sqlite');
    await seedHarnessHome(home, { harnesses: ['claude', 'codex', 'cursor', 'opencode'], skillSignals: true });

    const collected = await Effect.runPromise(
      collectSelectedHarnessResults({ harness: null, includeCursor: true }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    for (const harness of collected.harnesses) {
      if (harness.observationCompleteness === null) {
        continue;
      }
      await Effect.runPromise(
        importSkillObservations({
          collection: {
            completeness: harness.observationCompleteness,
            harnessKey: harness.harness,
          },
          dbPath,
          machineId: 'machine-chain',
          observations: harness.observations,
        }),
      );
    }

    const dataset = await Effect.runPromise(querySkillObservationDataset({ dbPath, ...READ_BOUNDS }));

    const tallies = dataset.skills.flatMap((skill) =>
      skill.tallies.map((tally) => `${skill.skillName} ${tally.harnessKey} ${tally.tier}`),
    );
    // Claude Code declares, OpenCode declares, and Codex contributes both of its streams. All three
    // tiers reach the read intact, each still attached to the harness that produced it.
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.claudeDeclared} claude declared`);
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.claudeUnresolved} claude declared`);
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.openCodeDeclared} opencode declared`);
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.codexExposed} codex exposed`);
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.codexExposed} codex inferred`);
    expect(new Set(dataset.skills.flatMap((skill) => skill.tallies.map(({ tier }) => tier)))).toEqual(
      new Set(['declared', 'inferred', 'exposed']),
    );

    // The harness that cannot observe arrives marked, not merely absent, and contributes no count
    // anywhere — the difference between "observed nothing" and "cannot observe" survives the chain.
    expect(dataset.harnesses).toContainEqual({
      harnessKey: 'cursor',
      label: 'Cursor',
      observability: 'not-observable',
    });
    expect(dataset.skills.flatMap((skill) => skill.tallies).some(({ harnessKey }) => harnessKey === 'cursor')).toBe(
      false,
    );

    // A bundled skill resolves to nothing and is still here: unresolvable is a state, not a drop.
    expect(
      dataset.skills.find(({ skillName }) => skillName === FIXTURE_SKILL_NAMES.claudeUnresolved)?.resolvedPaths,
    ).toEqual([]);
    expect(dataset.lowerBound).toBe(false);
    expect(dataset.invocationLowerBound).toBe(false);
    expect(dataset.skipped).toBe(0);

    // The argument text the fixture plants in the transcript never reaches the read.
    expect(JSON.stringify(dataset)).not.toContain('PRIVATE_DETAIL_PROMPT_SENTINEL');
  });

  test('an exposure flood cannot push collected invocations out of the read', async () => {
    const home = await temporaryDirectory('plan111-chain-flood-home-');
    const storeRoot = await temporaryDirectory('plan111-chain-flood-store-');
    const dbPath = join(storeRoot, 'usage.sqlite');
    await seedHarnessHome(home, { harnesses: ['claude', 'codex', 'opencode'], skillSignals: true });

    const collected = await Effect.runPromise(
      collectSelectedHarnessResults({ harness: null, includeCursor: false }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    // Every real invocation the collectors found, plus a catalogue flood that is strictly more
    // recent — the shape of an actual store, where Codex writes one exposure row per catalogue entry
    // per session and outnumbers invocations by roughly 66:1.
    const flood = Array.from({ length: 400 }, (_value, index) => ({
      argsPresent: null,
      harnessKey: 'codex',
      observationKey: `flood-${index}`,
      observedAt: new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString(),
      projectPath: null,
      resolvedPath: null,
      sessionId: 'flood-session',
      skillName: `catalogue-skill-${index % 190}`,
      success: null,
      tier: 'exposed' as const,
    }));
    for (const harness of collected.harnesses) {
      if (harness.observationCompleteness === null) {
        continue;
      }
      await Effect.runPromise(
        importSkillObservations({
          collection: {
            completeness: harness.observationCompleteness,
            harnessKey: harness.harness,
          },
          dbPath,
          machineId: 'machine-chain',
          observations: harness.harness === 'codex' ? [...harness.observations, ...flood] : harness.observations,
        }),
      );
    }

    const dataset = await Effect.runPromise(
      querySkillObservationDataset({ dbPath, ...READ_BOUNDS, maximumObservations: 40 }),
    );
    const tallies = dataset.skills.flatMap((skill) =>
      skill.tallies.map((tally) => `${skill.skillName} ${tally.harnessKey} ${tally.tier}`),
    );

    // Under a pooled budget of 40 against 400 newer exposure rows, not one of these would survive.
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.claudeDeclared} claude declared`);
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.openCodeDeclared} opencode declared`);
    expect(tallies).toContain(`${FIXTURE_SKILL_NAMES.codexExposed} codex inferred`);
    // The catalogue was cut and says so; the evidence the verdicts rest on was not.
    expect(dataset.lowerBound).toBe(true);
    expect(dataset.invocationLowerBound).toBe(false);
  });
});
