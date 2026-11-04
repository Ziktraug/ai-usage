import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observeJiraIssues } from '@ai-usage/local-collectors/jira-issues';
import type { BoundedProcessOptions, BoundedProcessRunner } from '@ai-usage/local-machine/bounded-process';
import {
  importJiraIssueObservations,
  initializeUsageStore,
  queryJiraSyncState,
  recordJiraSyncState,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { prepareJiraSync } from './jira-sync';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const start = '2026-10-28T10:00:00.000Z';
const fixture = async (keys = ['DEMO-1', 'DEMO-2', 'DEMO-3']) => {
  const root = mkdtempSync(path.join(tmpdir(), 'jira-sync-'));
  roots.push(root);
  const input = {
    dbPath: path.join(root, 'store.sqlite'),
    machineId: 'machine-a',
    candidates: keys,
    completeCandidates: true,
    now: new Date('2026-10-28T10:02:00.000Z'),
  };
  await Effect.runPromise(initializeUsageStore(input));
  const observations = await Effect.runPromise(
    observeJiraIssues({
      keys,
      maxKeys: keys.length,
      machineId: input.machineId,
      now: () => new Date(start),
      run: (options) =>
        Effect.succeed({
          exitCode: 0,
          durationMs: 1,
          stdout: JSON.stringify({ key: options.args[3], fields: { status: { name: 'To Do' }, updated: start } }),
        }),
    }),
  );
  await Effect.runPromise(importJiraIssueObservations({ ...input, observations: observations.observations }));
  await Effect.runPromise(
    recordJiraSyncState({
      ...input,
      state: { checkedThrough: start, fullScanAt: start, knownKeys: keys, pendingKeys: [] },
    }),
  );
  return input;
};
const search =
  (keys: readonly string[], calls: BoundedProcessOptions[] = []): BoundedProcessRunner =>
  (options) => {
    calls.push(options);
    return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: JSON.stringify(keys.map((key) => ({ key }))) });
  };

test('unchanged tickets cost no detail reads; changed tickets survive a restart before details', async () => {
  const input = await fixture();
  const unchanged = await Effect.runPromise(prepareJiraSync({ ...input, run: search([]) }));
  expect(unchanged.keys).toEqual([]);
  const calls: BoundedProcessOptions[] = [];
  const changed = await Effect.runPromise(prepareJiraSync({ ...input, run: search(['DEMO-2'], calls) }));
  expect(changed.keys).toEqual(['DEMO-2']);
  expect(calls).toHaveLength(1);
  const restarted = await Effect.runPromise(
    prepareJiraSync({ ...input, run: () => Effect.die('a pending batch must not search again') }),
  );
  expect(restarted.keys).toEqual(['DEMO-2']);
  expect(await Effect.runPromise(queryJiraSyncState(input))).toMatchObject({
    checkedThrough: changed.state.checkedThrough,
    pendingKeys: changed.state.pendingKeys,
  });
});

test('partial grouped search retains the old cursor and persists changes already found', async () => {
  const input = await fixture(Array.from({ length: 48 }, (_, i) => `DEMO-${i + 1}`));
  let call = 0;
  const result = await Effect.runPromise(
    prepareJiraSync({
      ...input,
      run: () =>
        Effect.succeed(
          ++call === 1
            ? { durationMs: 1, exitCode: 0, stdout: '[{"key":"DEMO-1"}]' }
            : { durationMs: 1, exitCode: 1, stdout: '{"status":401}' },
        ),
    }),
  );
  expect(call).toBe(2);
  expect(result.keys).toEqual(['DEMO-1']);
  expect(result.state.checkedThrough).toBe(start);
  expect(result.warnings[0]?.code).toBe('jira-changes-unauthenticated');
});

test('periodic full verification and newly followed old tickets cannot be skipped by the cursor', async () => {
  const input = await fixture();
  await Effect.runPromise(
    recordJiraSyncState({
      ...input,
      state: { checkedThrough: start, fullScanAt: start, knownKeys: ['DEMO-1', 'DEMO-2'], pendingKeys: [] },
    }),
  );
  const added = await Effect.runPromise(prepareJiraSync({ ...input, run: search([]) }));
  expect(added.keys).toEqual(['DEMO-3']);
  await Effect.runPromise(recordJiraSyncState({ ...input, state: { ...added.state, pendingKeys: [] } }));
  const full = await Effect.runPromise(
    prepareJiraSync({
      ...input,
      now: new Date('2026-10-28T16:00:00.000Z'),
      run: () => Effect.die('full verification directly reads known keys'),
    }),
  );
  expect(full.keys).toEqual(input.candidates);
});

test('failed assignment discovery cannot discard a pending ticket or its known scope', async () => {
  const input = await fixture();
  await Effect.runPromise(
    recordJiraSyncState({
      ...input,
      state: {
        checkedThrough: input.now.toISOString(),
        fullScanAt: start,
        knownKeys: input.candidates,
        pendingKeys: ['DEMO-2'],
      },
    }),
  );
  const result = await Effect.runPromise(
    prepareJiraSync({ ...input, completeCandidates: false, candidates: [], run: search([]) }),
  );
  expect(new Set(result.state.knownKeys)).toEqual(new Set(input.candidates));
  expect(result.keys).toEqual(['DEMO-2']);
});

test('one permanently unreadable ticket cannot stop later incremental polls', async () => {
  const input = await fixture();
  const failed = await Effect.runPromise(
    observeJiraIssues({
      keys: ['DEMO-1'],
      machineId: input.machineId,
      now: () => new Date('2026-10-28T10:01:00.000Z'),
      run: () => Effect.succeed({ exitCode: 1, durationMs: 1, stdout: '{"status":404}' }),
    }),
  );
  await Effect.runPromise(importJiraIssueObservations({ ...input, observations: failed.observations }));
  await Effect.runPromise(
    recordJiraSyncState({
      ...input,
      state: { checkedThrough: start, fullScanAt: start, knownKeys: input.candidates, pendingKeys: ['DEMO-1'] },
    }),
  );
  const calls: BoundedProcessOptions[] = [];
  const result = await Effect.runPromise(prepareJiraSync({ ...input, run: search(['DEMO-2'], calls) }));
  expect(calls).toHaveLength(1);
  expect(result.keys).toEqual(['DEMO-2', 'DEMO-1']);
  expect(result.state.checkedThrough).toBe(input.now.toISOString());
});

test('repeated partial searches drain unattempted details before re-reading their earlier results', async () => {
  const input = await fixture(Array.from({ length: 48 }, (_, i) => `DEMO-${i + 1}`));
  await Effect.runPromise(
    recordJiraSyncState({
      ...input,
      state: {
        checkedThrough: start,
        fullScanAt: start,
        knownKeys: input.candidates,
        pendingKeys: input.candidates.slice(20, 40),
      },
    }),
  );
  let call = 0;
  const result = await Effect.runPromise(
    prepareJiraSync({
      ...input,
      run: (options) => {
        call++;
        if (call === 2) {
          return Effect.succeed({ durationMs: 1, exitCode: 1, stdout: '' });
        }
        const keys = options.args[4]!.split(')')[0]!.slice('key IN ('.length).split(',');
        return search(keys)(options);
      },
    }),
  );
  expect(result.keys).toEqual(input.candidates.slice(20, 40));
  expect(result.state.checkedThrough).toBe(start);
});
