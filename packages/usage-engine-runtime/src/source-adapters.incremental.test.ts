import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HARNESS_ADAPTERS, type HarnessAdapter } from '@ai-usage/local-collectors/collectors';
import { LocalHistoryError } from '@ai-usage/local-machine/errors';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { HARNESS_METADATA } from '@ai-usage/report-core/harness-metadata';
import {
  completeSkillObservationCollection,
  parseSkillObservation,
  type SkillObservation,
} from '@ai-usage/report-core/skill-observation';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { usageStorePath } from '@ai-usage/usage-store/testing';
import { importLocalRows, retireLocalRows, updateUsageMachineLabel } from '@ai-usage/usage-store/writer';
import { Console, Effect } from 'effect';
import {
  createScheduledSourceRegistry,
  createSessionSource,
  type ScheduledSource,
  type SourceRunContext,
} from './source-adapters';
import { isolatedSourceOptions } from './source-test-fixtures';

const machine = { id: 'machine-a', label: 'Machine A' };

const context: SourceRunContext = { reportProgress: () => Effect.void };

const sessionRow = (sourceSessionId: string, tokensIn = 10, startMinute = 0) => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date(Date.UTC(2026, 6, 16, 9, startMinute)),
    durationMs: 60_000,
    endDate: new Date(Date.UTC(2026, 6, 16, 9, startMinute + 1)),
    harness: 'OpenCode',
    model: 'claude-sonnet-4-6',
    name: `Session ${sourceSessionId}`,
    project: 'fixture',
    provider: 'Anthropic',
    tokens: { in: tokensIn, out: 5, cr: 0, cw: 0 },
  }),
  source: { harnessKey: 'opencode', sourcePath: '/work/fixture', sourceSessionId },
});

type FixtureRow = ReturnType<typeof sessionRow>;

interface FixtureCollection {
  retiredSourceSessionIds?: readonly string[];
  rows: FixtureRow[];
}

/** Everything the store holds about usage rows and its generations, as raw column values. */
const dumpStore = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      enrichments: db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%enrichment%' ORDER BY name")
        .all()
        .flatMap((table) => {
          const name = (table as { name: string }).name;
          return db.query(`SELECT * FROM ${name} ORDER BY 1, 2`).all();
        }),
      generations: db.query('SELECT key, value FROM usage_store_metadata ORDER BY key').all(),
      rows: db
        .query(`
          SELECT row_key, content_hash, row_json, status, source_authority, active_date, machine_label,
                 fleet_metadata_valid, first_seen_at, last_seen_at, updated_at
          FROM usage_rows ORDER BY row_key
        `)
        .all(),
    };
  } finally {
    db.close();
  }
};

const generationOf = (dbPath: string, key: string): number => {
  const record = dumpStore(dbPath).generations.find((entry) => (entry as { key: string }).key === key);
  return (record as { value: number } | undefined)?.value ?? -1;
};

/** A session source over a scripted collector and clock, with the perf lines of each pass. */
interface FixtureState {
  collection: FixtureCollection;
  fail: boolean;
  now: Date;
  /** Called each time the source reads the clock; the first reading of a pass precedes its import. */
  onNow?: (() => void) | undefined;
}

const createFixtureSource = (home: string, state: FixtureState, sourceMachine = machine) => {
  const adapter: HarnessAdapter = {
    collect: Effect.sync(() => state.collection.rows),
    collectResult: Effect.suspend(() =>
      state.fail
        ? Effect.fail(new LocalHistoryError({ cause: new Error('fixture'), operation: 'fixture', path: home }))
        : Effect.succeed({ ...state.collection, warnings: [] }),
    ),
    metadata: HARNESS_METADATA.opencode,
  };
  return createSessionSource({
    adapter: () => Effect.succeed(adapter),
    dbPath: usageStorePath(home),
    detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
    id: 'opencode.sessions',
    label: 'OpenCode sessions',
    machine: sourceMachine,
    now: () => {
      state.onNow?.();
      return state.now;
    },
    storage: createLocalHistoryStorage(home),
  });
};

/** Runs one pass and returns the `rows=` and `leftInStore=` figures of its row import. */
const runCounting = async (source: ScheduledSource, signal?: AbortSignal) => {
  const lines: string[] = [];
  const capture: Console.Console = {
    ...globalThis.console,
    error: (...values: unknown[]) => {
      lines.push(values.map(String).join(' '));
    },
  };
  const exit = await Effect.runPromiseExit(
    source.run(signal ? { ...context, signal } : context).pipe(Effect.provideService(Console.Console, capture)),
  );
  const importLine = lines.find((line) => line.includes('.importLocalRows ')) ?? '';
  const field = (name: string) => Number(new RegExp(` ${name}=(\\d+)`).exec(importLine)?.[1] ?? Number.NaN);
  return { exit, imported: field('rows'), leftInStore: field('leftInStore') };
};

describe('session sources import what changed', () => {
  let homes: string[] = [];
  let previousPerfFlag: string | undefined;
  const makeHome = () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-source-incremental-'));
    homes.push(home);
    return home;
  };

  beforeEach(() => {
    previousPerfFlag = process.env.AI_USAGE_PERF;
    process.env.AI_USAGE_PERF = '1';
  });

  afterEach(() => {
    if (previousPerfFlag === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previousPerfFlag;
    }
    for (const home of homes) {
      rmSync(home, { force: true, recursive: true });
    }
    homes = [];
  });

  test('imports no row and moves no generation when the inputs did not change, and one row when one did', async () => {
    const home = makeHome();
    const dbPath = usageStorePath(home);
    const state = {
      collection: { rows: [sessionRow('one'), sessionRow('two'), sessionRow('three')] },
      fail: false,
      now: new Date('2026-07-16T10:00:00.000Z'),
    };
    const source = createFixtureSource(home, state);

    const first = await runCounting(source);
    expect(first).toMatchObject({ imported: 3, leftInStore: 0 });
    const afterFirst = dumpStore(dbPath);

    state.now = new Date('2026-07-16T10:01:00.000Z');
    const unchanged = await runCounting(source);
    expect(unchanged).toMatchObject({ imported: 0, leftInStore: 3 });
    expect(unchanged.exit).toMatchObject({ _tag: 'Success', value: { changed: false, inputCount: 3, outputCount: 3 } });
    expect(dumpStore(dbPath)).toEqual(afterFirst);

    const generationBeforeChange = generationOf(dbPath, 'generation');
    state.collection = { rows: [sessionRow('one'), sessionRow('two', 99), sessionRow('three')] };
    state.now = new Date('2026-07-16T10:02:00.000Z');
    const changed = await runCounting(source);
    expect(changed).toMatchObject({ imported: 1, leftInStore: 2 });
    expect(changed.exit).toMatchObject({ _tag: 'Success', value: { changed: true } });
    expect(generationOf(dbPath, 'generation')).toBe(generationBeforeChange + 1);
    const afterChange = dumpStore(dbPath);
    expect(afterChange.rows.filter((row) => (row as { updated_at: string }).updated_at.includes('10:02'))).toHaveLength(
      1,
    );
  });

  test('leaves the store exactly as a source without memory does, pass after pass', async () => {
    // `resident` keeps one source for the whole sequence; `fresh` gets a new source for every pass,
    // which collects and imports everything each time: the full re-collection.
    // Each side has its own machine object, as an engine does: the live relabel below mutates it.
    const resident = {
      home: makeHome(),
      machine: { ...machine },
      state: { collection: { rows: [] as FixtureRow[] }, fail: false, now: new Date(0) },
    };
    const fresh = {
      home: makeHome(),
      machine: { ...machine },
      state: { collection: { rows: [] as FixtureRow[] }, fail: false, now: new Date(0) },
    };
    const residentSource = createFixtureSource(resident.home, resident.state, resident.machine);
    const base = [sessionRow('one'), sessionRow('two'), sessionRow('three')];
    const steps: {
      at: string;
      collection?: FixtureCollection;
      fail?: boolean;
      /** A relabel by a writer the sources do not know about: their machine object keeps its label. */
      relabel?: string;
      /** A relabel as the engine does it: the store is rewritten and the sources' machine object too. */
      relabelLive?: string;
    }[] = [
      { at: '10:00', collection: { rows: base } },
      { at: '10:01' },
      { at: '10:02', collection: { rows: [base[0], sessionRow('two', 50), base[2]] as FixtureRow[] } },
      {
        at: '10:03',
        collection: { rows: [base[0], sessionRow('two', 50), base[2], sessionRow('four')] as FixtureRow[] },
      },
      // A session is retired, then the collector emits it again unchanged.
      {
        at: '10:04',
        collection: {
          retiredSourceSessionIds: ['three'],
          rows: [base[0], sessionRow('two', 50), sessionRow('four')] as FixtureRow[],
        },
      },
      {
        at: '10:05',
        collection: { rows: [base[0], sessionRow('two', 50), base[2], sessionRow('four')] as FixtureRow[] },
      },
      // A failed pass, then the same inputs again.
      { at: '10:06', fail: true },
      { at: '10:07' },
      // One session id is emitted once, then twice with different content, then once again.
      {
        at: '10:08',
        collection: {
          rows: [base[0], sessionRow('two', 50), base[2], sessionRow('four'), sessionRow('four', 77)] as FixtureRow[],
        },
      },
      {
        at: '10:09',
        collection: { rows: [base[0], sessionRow('two', 50), base[2], sessionRow('four')] as FixtureRow[] },
      },
      { at: '10:10' },
      // A session stops being emitted across the hourly freshness heartbeat and comes back after it.
      { at: '10:59', collection: { rows: [base[0], sessionRow('two', 50), base[2]] as FixtureRow[] } },
      { at: '11:00' },
      {
        at: '11:01',
        collection: { rows: [base[0], sessionRow('two', 50), base[2], sessionRow('four')] as FixtureRow[] },
      },
      // The engine relabels the machine: stored rows and the sources' machine object move together.
      { at: '11:02', relabelLive: 'Live name' },
      { at: '11:03' },
      // Someone else rewrites the stored rows of this harness between two passes.
      { at: '11:04', relabel: 'Renamed machine' },
      { at: '11:05' },
      {
        at: '12:30',
        collection: {
          rows: [sessionRow('one', 11), sessionRow('two', 50), base[2], sessionRow('four')] as FixtureRow[],
        },
      },
      { at: '12:31' },
    ];

    for (const step of steps) {
      const now = new Date(`2026-07-16T${step.at}:00.000Z`);
      for (const side of [resident, fresh]) {
        side.state.now = now;
        side.state.fail = step.fail === true;
        if (step.collection) {
          side.state.collection = step.collection;
        }
        const label = step.relabel ?? step.relabelLive;
        if (label) {
          await Effect.runPromise(
            updateUsageMachineLabel({
              dbPath: usageStorePath(side.home),
              machine: { id: machine.id, label },
              updatedAt: now,
            }),
          );
        }
        if (step.relabelLive) {
          side.machine.label = step.relabelLive;
        }
      }
      const residentPass = await runCounting(residentSource);
      const freshPass = await runCounting(createFixtureSource(fresh.home, fresh.state, fresh.machine));

      expect(residentPass.exit._tag).toBe(step.fail ? 'Failure' : 'Success');
      expect(freshPass.exit._tag).toBe(residentPass.exit._tag);
      if (residentPass.exit._tag === 'Success' && freshPass.exit._tag === 'Success') {
        expect({ at: step.at, result: residentPass.exit.value }).toEqual({ at: step.at, result: freshPass.exit.value });
      }
      expect({ at: step.at, store: dumpStore(usageStorePath(resident.home)) }).toEqual({
        at: step.at,
        store: dumpStore(usageStorePath(fresh.home)),
      });
    }

    // The sequence did exercise the incremental path, not only complete passes.
    expect((await runCounting(residentSource)).leftInStore).toBe(4);
  });

  test('imports every row again after a failed pass, an hour boundary, or a rewrite by another writer', async () => {
    const home = makeHome();
    const dbPath = usageStorePath(home);
    const rows = [sessionRow('one'), sessionRow('two')];
    const state = { collection: { rows } as FixtureCollection, fail: false, now: new Date('2026-07-16T10:00:00.000Z') };
    const source = createFixtureSource(home, state);
    await runCounting(source);
    expect(await runCounting(source)).toMatchObject({ imported: 0, leftInStore: 2 });

    // A pass that fails leaves nothing to build on.
    state.fail = true;
    expect((await runCounting(source)).exit._tag).toBe('Failure');
    state.fail = false;
    expect(await runCounting(source)).toMatchObject({ imported: 2, leftInStore: 0 });
    expect(await runCounting(source)).toMatchObject({ imported: 0, leftInStore: 2 });

    // The first pass of a new clock hour owes every row its freshness heartbeat.
    state.now = new Date('2026-07-16T11:00:30.000Z');
    expect(await runCounting(source)).toMatchObject({ imported: 2, leftInStore: 0 });
    expect(dumpStore(dbPath).rows.map((row) => (row as { last_seen_at: string }).last_seen_at)).toEqual([
      '2026-07-16T11:00:30.000Z',
      '2026-07-16T11:00:30.000Z',
    ]);
    expect(await runCounting(source)).toMatchObject({ imported: 0, leftInStore: 2 });

    // A retirement recorded by another writer changes what the store holds for this harness.
    await Effect.runPromise(
      retireLocalRows({
        dbPath,
        harnessKey: 'opencode',
        machine,
        retiredAt: new Date('2026-07-16T11:01:00.000Z'),
        sourceSessionIds: ['two'],
      }),
    );
    state.now = new Date('2026-07-16T11:02:00.000Z');
    expect(await runCounting(source)).toMatchObject({ imported: 2, leftInStore: 0 });
    expect(dumpStore(dbPath).rows.map((row) => (row as { status: string }).status)).toEqual(['active', 'active']);

    // So does an import of the same harness's rows by another writer.
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: new Date('2026-07-16T11:03:00.000Z'),
        machine,
        rows: [sessionRow('one', 77)],
      }),
    );
    state.now = new Date('2026-07-16T11:04:00.000Z');
    expect(await runCounting(source)).toMatchObject({ imported: 2, leftInStore: 0 });
  });

  test('imports every row again after a pass that failed once its import had committed', async () => {
    const resident = {
      home: makeHome(),
      state: { collection: { rows: [] }, fail: false, now: new Date(0) } as FixtureState,
    };
    const fresh = {
      home: makeHome(),
      state: { collection: { rows: [] }, fail: false, now: new Date(0) } as FixtureState,
    };
    const residentSource = createFixtureSource(resident.home, resident.state);
    const pass = async (at: string, collection: FixtureCollection, abortAfterImport = false) => {
      const outcomes: Awaited<ReturnType<typeof runCounting>>[] = [];
      for (const side of [resident, fresh]) {
        side.state.now = new Date(`2026-07-16T${at}:00.000Z`);
        side.state.collection = collection;
        const controller = new AbortController();
        // The clock is first read for the import timestamp; the next check of the signal follows the import.
        side.state.onNow = abortAfterImport ? () => controller.abort() : undefined;
        const source = side === resident ? residentSource : createFixtureSource(fresh.home, fresh.state);
        outcomes.push(await runCounting(source, controller.signal));
      }
      expect({ at, store: dumpStore(usageStorePath(resident.home)) }).toEqual({
        at,
        store: dumpStore(usageStorePath(fresh.home)),
      });
      return outcomes[0] ?? Promise.reject(new Error('no pass ran'));
    };
    const rows = [sessionRow('one'), sessionRow('two'), sessionRow('three')];

    await pass('10:00', { rows });
    expect(await pass('10:01', { rows })).toMatchObject({ imported: 0, leftInStore: 3 });

    // Interrupted between the import and the retirement: the changed row is in the store.
    const changed = [sessionRow('one'), sessionRow('two', 99), sessionRow('three')];
    const interrupted = await pass('10:02', { rows: changed }, true);
    expect(interrupted.exit._tag).toBe('Failure');
    expect(interrupted.imported).toBe(1);
    expect(await pass('10:03', { rows: changed })).toMatchObject({ imported: 3, leftInStore: 0 });
    expect(await pass('10:04', { rows: changed })).toMatchObject({ imported: 0, leftInStore: 3 });

    // The retirement itself fails (the store refuses an empty session id) after the import.
    const changedAgain = [sessionRow('one', 55), sessionRow('two', 99), sessionRow('three')];
    const refused = await pass('10:05', { retiredSourceSessionIds: [''], rows: changedAgain });
    expect(refused.exit._tag).toBe('Failure');
    expect(refused.imported).toBe(1);
    expect(await pass('10:06', { rows: changedAgain })).toMatchObject({ imported: 3, leftInStore: 0 });
    expect(await pass('10:07', { rows: changedAgain })).toMatchObject({ imported: 0, leftInStore: 3 });
  });

  test('imports rows without a session id, and rows sharing one, on every pass', async () => {
    const home = makeHome();
    const anonymous = { ...sessionRow('ignored'), source: { harnessKey: 'opencode', sourceSessionId: null } };
    const state = {
      collection: {
        rows: [sessionRow('one'), sessionRow('dup', 1), sessionRow('dup', 2), anonymous],
      } as FixtureCollection,
      fail: false,
      now: new Date('2026-07-16T10:00:00.000Z'),
    };
    const source = createFixtureSource(home, state);
    await runCounting(source);

    expect(await runCounting(source)).toMatchObject({ imported: 3, leftInStore: 1 });
  });
});

describe('incremental collectors behind a session source', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'engine-source-incremental-collector-'));
  });

  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
  });

  const observation = (sessionId: string, skillName: string): SkillObservation => {
    const parsed = parseSkillObservation({
      argsPresent: null,
      harnessKey: 'codex',
      observationKey: `catalogue:${skillName}`,
      observedAt: '2026-07-16T09:00:00.000Z',
      projectPath: null,
      resolvedPath: null,
      sessionId,
      skillName,
      success: null,
      tier: 'exposed',
    });
    if (!parsed) {
      throw new Error('Fixture observation is invalid');
    }
    return parsed;
  };

  test('asks for a complete pass first and after a failure, and records observations returned for changed inputs only', async () => {
    const requests: boolean[] = [];
    const script: { fail?: boolean; observations: SkillObservation[]; scope?: 'changed' }[] = [];
    const adapter: HarnessAdapter = {
      collect: Effect.succeed([]),
      createIncrementalCollector: () => (request) =>
        Effect.suspend(() => {
          requests.push(request.complete);
          const step = script.shift();
          if (!step || step.fail) {
            return Effect.fail(
              new LocalHistoryError({ cause: new Error('fixture'), operation: 'fixture', path: home }),
            );
          }
          return Effect.succeed({
            observationCompleteness: completeSkillObservationCollection(),
            ...(step.scope ? { observationScope: step.scope } : {}),
            observations: step.observations,
            rows: [],
            warnings: [],
          });
        }),
      metadata: HARNESS_METADATA.codex,
    };
    const dbPath = usageStorePath(home);
    const source = createSessionSource({
      adapter: () => Effect.succeed(adapter),
      dbPath,
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'codex.sessions',
      label: 'Codex sessions',
      machine,
      now: () => new Date('2026-07-16T10:00:00.000Z'),
      storage: createLocalHistoryStorage(home),
    });
    const storedSkills = () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (
          db.query('SELECT skill_name FROM skill_observations ORDER BY skill_name').all() as { skill_name: string }[]
        ).map((row) => row.skill_name);
      } finally {
        db.close();
      }
    };

    script.push(
      { observations: [observation('s1', 'alpha'), observation('s2', 'beta')] },
      { observations: [observation('s2', 'gamma')], scope: 'changed' },
      { observations: [], scope: 'changed' },
      { fail: true, observations: [] },
      { observations: [observation('s1', 'alpha'), observation('s2', 'beta'), observation('s2', 'gamma')] },
    );
    const first = await Effect.runPromise(source.run(context));
    const second = await Effect.runPromise(source.run(context));
    const third = await Effect.runPromise(source.run(context));
    const failed = await Effect.runPromiseExit(source.run(context));
    const recovered = await Effect.runPromise(source.run(context));

    expect(requests).toEqual([true, false, false, false, true]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    // Nothing returned and nothing stored: the earlier observations stay, and the pass is quiet.
    expect(third.changed).toBe(false);
    expect(failed._tag).toBe('Failure');
    expect(recovered.changed).toBe(false);
    expect(storedSkills()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

/** The skill tables as stored, without the wall-clock columns of each import. */
const dumpSkills = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      observations: db
        .query(`
          SELECT harness_key, skill_name, tier, machine_id, session_id, observation_key, observed_at,
                 project_path, resolved_path, args_present, success
          FROM skill_observations ORDER BY harness_key, session_id, tier, observation_key
        `)
        .all(),
      state: db
        .query(`
          SELECT machine_id, harness_key, invocation_truncated, invocation_rejected, exposure_truncated,
                 exposure_rejected
          FROM skill_observation_collection_state ORDER BY machine_id, harness_key
        `)
        .all(),
    };
  } finally {
    db.close();
  }
};

describe('store-side observation rejections under an incremental collector', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'engine-source-incremental-rejection-'));
  });

  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
  });

  test('keeps the stored completeness of a full pass by collecting in full while the store rejects an observation', async () => {
    const valid = parseSkillObservation({
      argsPresent: null,
      harnessKey: 'codex',
      observationKey: 'catalogue:alpha',
      observedAt: '2026-07-16T09:00:00.000Z',
      projectPath: null,
      resolvedPath: null,
      sessionId: 's1',
      skillName: 'alpha',
      success: null,
      tier: 'exposed',
    });
    if (!valid) {
      throw new Error('Fixture observation is invalid');
    }
    // The collector hands over an observation the store refuses: a collector defect, counted.
    const refused = { ...valid, observationKey: 'catalogue:beta', skillName: '' } as SkillObservation;
    const requests: boolean[] = [];
    let pass = 0;
    const adapter: HarnessAdapter = {
      collect: Effect.succeed([]),
      createIncrementalCollector: () => (request) =>
        Effect.sync(() => {
          requests.push(request.complete);
          pass++;
          const base = { observationCompleteness: completeSkillObservationCollection(), rows: [], warnings: [] };
          if (pass === 1) {
            return { ...base, observations: [valid] };
          }
          // From the second pass on a second rollout exists, carrying the refused observation.
          if (request.complete) {
            return { ...base, observations: [valid, refused] };
          }
          return { ...base, observationScope: 'changed' as const, observations: pass === 2 ? [refused] : [] };
        }),
      metadata: HARNESS_METADATA.codex,
    };
    const dbPath = usageStorePath(home);
    const source = createSessionSource({
      adapter: () => Effect.succeed(adapter),
      dbPath,
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'codex.sessions',
      label: 'Codex sessions',
      machine,
      now: () => new Date('2026-07-16T10:00:00.000Z'),
      storage: createLocalHistoryStorage(home),
    });

    await Effect.runPromise(source.run(context));
    const second = await Effect.runPromise(source.run(context));
    const afterSecond = dumpSkills(dbPath).state;
    const third = await Effect.runPromise(source.run(context));
    const fourth = await Effect.runPromise(source.run(context));

    // A full pass counts one refused observation every time; so must the stored state, on every pass.
    expect(afterSecond).toEqual([expect.objectContaining({ exposure_rejected: 1, invocation_rejected: 0 })]);
    expect(second.changed).toBe(true);
    expect(requests).toEqual([true, false, true, true]);
    expect(dumpSkills(dbPath).state).toEqual(afterSecond);
    expect(third.changed).toBe(false);
    expect(fourth.changed).toBe(false);
  });
});

describe('the Codex collector behind a session source', () => {
  let homes: string[] = [];
  let stamp = 1_800_000_000;
  const makeHome = () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-source-incremental-codex-'));
    mkdirSync(path.join(home, '.codex', 'sessions', '2026'), { recursive: true });
    homes.push(home);
    return home;
  };

  afterEach(() => {
    for (const home of homes) {
      rmSync(home, { force: true, recursive: true });
    }
    homes = [];
  });

  const rollout = (input: { id: string; minute: number; skill: string; total: number }) => {
    const at = (second: number) =>
      `2026-01-01T00:${String(input.minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
    return [
      { timestamp: at(0), type: 'session_meta', payload: { id: input.id, cwd: `/work/${input.id}` } },
      {
        timestamp: at(1),
        type: 'response_item',
        payload: {
          type: 'message',
          id: `msg-${input.id}`,
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: `### Available skills\n- ${input.skill}: A skill. (file: /home/alex/.agents/skills/${input.skill}/SKILL.md)`,
            },
          ],
        },
      },
      { timestamp: at(2), type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${input.id}` } },
      { timestamp: at(3), type: 'turn_context', payload: { model: 'gpt-5.2', turn_id: `turn-${input.id}` } },
      {
        timestamp: at(4),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              total_tokens: input.total,
              input_tokens: input.total - 10,
              cached_input_tokens: 0,
              output_tokens: 10,
            },
          },
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
      .concat('\n');
  };

  const codexSource = (home: string, now: () => Date) =>
    createSessionSource({
      adapter: () => Effect.succeed(HARNESS_ADAPTERS.codex),
      dbPath: usageStorePath(home),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'codex.sessions',
      label: 'Codex sessions',
      machine,
      now,
      storage: createLocalHistoryStorage(home),
    });

  test('stores the rows and skill observations a source rebuilt for every pass stores', async () => {
    const resident = makeHome();
    const fresh = makeHome();
    let now = new Date(0);
    const residentSource = codexSource(resident, () => now);
    const write = (name: string, content: string | null) => {
      stamp += 10;
      for (const home of [resident, fresh]) {
        const filePath = path.join(home, '.codex', 'sessions', '2026', name);
        if (content === null) {
          rmSync(filePath);
        } else {
          writeFileSync(filePath, content);
          utimesSync(filePath, stamp, stamp);
        }
      }
    };
    const steps: { at: string; change: () => void }[] = [
      {
        at: '10:00',
        change: () => {
          // Two rollouts of one session id exposing the same skill, and an unrelated session.
          write('rollout-a-first.jsonl', rollout({ id: 'shared', minute: 1, skill: 'alpha', total: 900 }));
          write('rollout-b-resumed.jsonl', rollout({ id: 'shared', minute: 5, skill: 'alpha', total: 100 }));
          write('rollout-c-other.jsonl', rollout({ id: 'other', minute: 3, skill: 'beta', total: 50 }));
        },
      },
      { at: '10:01', change: () => undefined },
      {
        at: '10:02',
        change: () => write('rollout-c-other.jsonl', rollout({ id: 'other', minute: 3, skill: 'gamma', total: 80 })),
      },
      {
        at: '10:03',
        change: () => write('rollout-d-new.jsonl', rollout({ id: 'new', minute: 7, skill: 'beta', total: 10 })),
      },
      // The earlier copy of the shared session goes: the later copy's observation becomes the stored one.
      { at: '10:04', change: () => write('rollout-a-first.jsonl', null) },
      {
        at: '10:05',
        change: () =>
          write('rollout-b-resumed.jsonl', rollout({ id: 'shared', minute: 5, skill: 'delta', total: 300 })),
      },
      { at: '11:00', change: () => undefined },
    ];
    for (const step of steps) {
      now = new Date(`2026-07-16T${step.at}:00.000Z`);
      step.change();
      const residentResult = await Effect.runPromise(residentSource.run(context));
      const freshResult = await Effect.runPromise(codexSource(fresh, () => now).run(context));

      expect({ at: step.at, result: residentResult }).toEqual({ at: step.at, result: freshResult });
      expect({ at: step.at, skills: dumpSkills(usageStorePath(resident)) }).toEqual({
        at: step.at,
        skills: dumpSkills(usageStorePath(fresh)),
      });
      expect({ at: step.at, store: dumpStore(usageStorePath(resident)) }).toEqual({
        at: step.at,
        store: dumpStore(usageStorePath(fresh)),
      });
    }

    const stored = dumpSkills(usageStorePath(resident)).observations as { observed_at: string; skill_name: string }[];
    expect(stored.find((observation) => observation.skill_name === 'alpha')?.observed_at).toBe(
      '2026-01-01T00:05:01.000Z',
    );
  });
});

describe('rtk.savings reads what changed', () => {
  let homes: string[] = [];
  let previousPerfFlag: string | undefined;
  const makeHome = () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-source-rtk-incremental-'));
    homes.push(home);
    return home;
  };

  beforeEach(() => {
    previousPerfFlag = process.env.AI_USAGE_PERF;
    process.env.AI_USAGE_PERF = '1';
  });

  afterEach(() => {
    if (previousPerfFlag === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previousPerfFlag;
    }
    for (const home of homes) {
      rmSync(home, { force: true, recursive: true });
    }
    homes = [];
  });

  const writeRtkHistory = (home: string, commands: readonly [string, string, number][]) => {
    const rtkPath = path.join(home, '.local', 'share', 'rtk', 'history.db');
    mkdirSync(path.dirname(rtkPath), { recursive: true });
    rmSync(rtkPath, { force: true });
    const db = new Database(rtkPath);
    db.exec(
      'CREATE TABLE commands (timestamp TEXT, project_path TEXT, input_tokens INTEGER, output_tokens INTEGER, saved_tokens INTEGER)',
    );
    for (const [timestamp, projectPath, saved] of commands) {
      db.query('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(timestamp, projectPath, 4, 2, saved);
    }
    db.close();
  };

  const rtkSource = async (home: string) => {
    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({ ...isolatedSourceOptions, machine }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    const source = registry.get('rtk.savings');
    if (!source) {
      throw new Error('rtk.savings is not registered');
    }
    return source;
  };

  /** Runs one pass and returns how many stored rows it read out of how many it enriched. */
  const runRtk = async (source: ScheduledSource) => {
    const lines: string[] = [];
    const capture: Console.Console = {
      ...globalThis.console,
      error: (...values: unknown[]) => {
        lines.push(values.map(String).join(' '));
      },
    };
    const result = await Effect.runPromise(source.run(context).pipe(Effect.provideService(Console.Console, capture)));
    const line = lines.find((entry) => entry.includes('.queryEnrichableUsageRows ')) ?? '';
    const field = (name: string) => Number(new RegExp(` ${name}=(\\d+)`).exec(line)?.[1] ?? Number.NaN);
    return { read: field('read'), result, rows: field('rows') };
  };

  const importRows = (home: string, rows: FixtureRow[], at: string) =>
    Effect.runPromise(importLocalRows({ dbPath: usageStorePath(home), importedAt: new Date(at), machine, rows }));

  test('reads only the rows whose content changed and stores what a source without memory stores', async () => {
    const resident = makeHome();
    const fresh = makeHome();
    const residentSource = await rtkSource(resident);
    // Three sessions in one project at 09:00, 09:10 and 09:20; commands fall into two of them.
    const initial = [sessionRow('one', 10, 0), sessionRow('two', 10, 10), sessionRow('three', 10, 20)];
    const commands: [string, string, number][] = [
      ['2026-07-16T09:00:30.000Z', '/work/fixture', 9],
      ['2026-07-16T09:10:30.000Z', '/work/fixture', 5],
    ];
    const steps: { at: string; commands?: [string, string, number][]; rows?: FixtureRow[]; retire?: string }[] = [
      { at: '2026-07-16T10:00:00.000Z', commands, rows: initial },
      { at: '2026-07-16T10:01:00.000Z' },
      // One session's content changes; its window does not.
      { at: '2026-07-16T10:02:00.000Z', rows: [sessionRow('two', 99, 10)] },
      // A session moves onto the first command's minute: the narrowest window still wins, in store order.
      { at: '2026-07-16T10:03:00.000Z', rows: [sessionRow('three', 10, 0)] },
      // A new RTK command, and a session retired.
      { at: '2026-07-16T10:04:00.000Z', commands: [...commands, ['2026-07-16T09:00:40.000Z', '/work/fixture', 3]] },
      { at: '2026-07-16T10:05:00.000Z', retire: 'one' },
      { at: '2026-07-16T10:06:00.000Z', rows: [sessionRow('four', 10, 0)] },
    ];
    const reads: number[] = [];
    for (const step of steps) {
      for (const home of [resident, fresh]) {
        if (step.commands) {
          writeRtkHistory(home, step.commands);
        }
        if (step.rows) {
          await importRows(home, step.rows, step.at);
        }
        if (step.retire) {
          await Effect.runPromise(
            retireLocalRows({
              dbPath: usageStorePath(home),
              harnessKey: 'opencode',
              machine,
              retiredAt: new Date(step.at),
              sourceSessionIds: [step.retire],
            }),
          );
        }
      }
      const residentPass = await runRtk(residentSource);
      const freshPass = await runRtk(await rtkSource(fresh));
      reads.push(residentPass.read);

      expect({ at: step.at, result: residentPass.result }).toEqual({ at: step.at, result: freshPass.result });
      expect(freshPass.read).toBe(freshPass.rows);
      const residentStore = dumpStore(usageStorePath(resident));
      const freshStore = dumpStore(usageStorePath(fresh));
      // Contribution timestamps come from the wall clock of each run; everything else must match.
      const withoutClock = (rows: unknown[]) =>
        rows.map((row) => Object.fromEntries(Object.entries(row as object).filter(([key]) => !key.endsWith('_at'))));
      expect({ at: step.at, enrichments: withoutClock(residentStore.enrichments), rows: residentStore.rows }).toEqual({
        at: step.at,
        enrichments: withoutClock(freshStore.enrichments),
        rows: freshStore.rows,
      });
    }

    // All three rows on the first run, then exactly the rows written since the previous run.
    expect(reads).toEqual([3, 0, 1, 1, 0, 0, 1]);
    expect(dumpStore(usageStorePath(resident)).enrichments.length).toBeGreaterThan(0);
  });
});
