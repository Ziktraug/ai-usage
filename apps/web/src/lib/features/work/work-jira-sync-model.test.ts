import { expect, test } from 'bun:test';
import type { SourceControlEntryView } from '@ai-usage/report-core/source-control';
import type { SourceControlClientState } from '../../../source-control-client';
import { presentJiraSync } from './work-jira-sync-model';

const at = '2026-10-28T12:00:00.000Z';
const state = (patch: Partial<SourceControlEntryView> = {}): SourceControlClientState => ({
  connection: 'live',
  commandError: null,
  pendingCommand: null,
  publication: null,
  snapshot: {
    generatedAt: at,
    generation: 1,
    instanceId: 'test',
    queueDepth: 0,
    runningCount: 0,
    publication: {
      acknowledgedRequestGeneration: 0,
      dirty: false,
      dirtyGeneration: 0,
      lastOutcome: 'not-run',
      pendingDemand: false,
      publishedGeneration: 0,
      queued: false,
      requestedGeneration: 0,
      rtkCompletedGeneration: 0,
      rtkRequiredGeneration: 0,
      running: false,
    },
    sources: [
      {
        id: 'jira.issues',
        label: 'Jira issues',
        cadenceMs: 120_000,
        availability: 'detected',
        policy: 'enabled',
        lifecycle: 'scheduled',
        lastOutcome: 'success',
        reason: { code: 'none' },
        warnings: [],
        lastFinishedAt: at,
        ...patch,
      },
    ],
  },
});
test('only a complete connected run is presented as checked', () => {
  expect(presentJiraSync(state())).toMatchObject({ label: 'Jira checked', checked: true, lastFinishedAt: at });
  expect(presentJiraSync({ ...state(), connection: 'disconnected' })).toMatchObject({
    label: 'Jira sync disconnected',
    checked: false,
  });
  expect(
    presentJiraSync(state({ warnings: [{ code: 'jira-changes-network' }], lastOutcome: 'warning' })),
  ).toMatchObject({ label: 'Jira sync incomplete', checked: false });
  expect(presentJiraSync(state({ policy: 'disabled' }))).toMatchObject({ label: 'Jira sync paused', checked: false });
});
test('a durable backlog remains visible between batches', () => {
  expect(
    presentJiraSync(
      state({
        warnings: [{ code: 'jira-sync-pending', message: '28 Jira tickets awaiting details.' }],
        lastOutcome: 'warning',
      }),
    ),
  ).toMatchObject({ label: 'Catching up Jira — 28 Jira tickets awaiting details.', checked: false });
  expect(presentJiraSync(state({ lifecycle: 'running' }))).toMatchObject({ label: 'Syncing Jira…', checked: false });
});

test('a retry backlog never hides a failed search', () => {
  expect(
    presentJiraSync(
      state({
        lastOutcome: 'warning',
        warnings: [
          { code: 'jira-sync-pending', message: '1 Jira ticket awaiting details.' },
          { code: 'jira-changes-network' },
        ],
      }),
    ),
  ).toMatchObject({ label: 'Jira sync incomplete — 1 Jira ticket awaiting details.', checked: false });
});
