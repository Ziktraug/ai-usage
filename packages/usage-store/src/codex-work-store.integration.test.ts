import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { CodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import { Effect } from 'effect';
import { queryCodexWorkObservations, queryLocalMergeBundle, queryUsageStoreGeneration } from './reader';
import {
  exportLocalMergeBundle,
  importCodexWorkObservations,
  initializeUsageStore,
  updateUsageMachineLabel,
} from './writer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('initialized and upgraded disposable stores keep Codex questions outside portable data and generations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-work-boundary-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const legacy = new Database(dbPath);
  legacy.exec('DROP TABLE codex_work_observations');
  legacy.close();
  await Effect.runPromise(initializeUsageStore({ dbPath }));

  const machine = { id: 'codex-machine', label: 'Disposable Codex fixture' };
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
  const at = canonicalInstantFromDate(new Date('2026-10-22T10:00:00.000Z'));
  const privateQuestion = 'PRIVATE_CODEX_QUESTION_BOUNDARY_119';
  const observation: CodexWorkObservation = {
    format: 'codex-work-v1',
    sourceSessionId: 'codex-session',
    originator: 'Codex Desktop',
    source: 'vscode',
    threadSource: 'user',
    forkedFromId: null,
    lastEventAt: at,
    latestUserMessageAt: null,
    omittedRequests: 0,
    rejectedRecords: 0,
    requests: [
      {
        callId: 'request-1',
        tool: 'request_user_input_async',
        askedAt: at,
        acknowledgedAt: at,
        rejectedAt: null,
        questions: [{ id: null, text: privateQuestion, textTruncated: false, answeredAt: null }],
      },
    ],
  };
  const generation = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
  expect(
    await Effect.runPromise(
      importCodexWorkObservations({
        dbPath,
        machineId: machine.id,
        observedAt: at,
        observations: [observation],
      }),
    ),
  ).toEqual({ changed: 1, unchanged: 0, rejected: 0 });
  const localEvidence = await Effect.runPromise(
    queryCodexWorkObservations({
      dbPath,
      machineId: machine.id,
      sourceSessionIds: ['codex-session'],
    }),
  );
  expect(localEvidence.observations[0]?.requests[0]?.questions[0]?.text).toBe(privateQuestion);
  expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generation);
  const db = new Database(dbPath, { readonly: true });
  try {
    for (const payload of [
      db.query('SELECT row_json FROM usage_rows').all(),
      db.query('SELECT row_json, source_row_json, search_text FROM served_report_rows').all(),
      await Effect.runPromise(exportLocalMergeBundle({ dbPath, machine })),
      await Effect.runPromise(queryLocalMergeBundle({ dbPath })),
    ]) {
      expect(JSON.stringify(payload)).not.toContain(privateQuestion);
    }
  } finally {
    db.close();
  }
});
