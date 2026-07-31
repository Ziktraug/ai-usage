import { expect, test } from 'bun:test';
import { serializeUsageMergeBundle, USAGE_MERGE_BUNDLE_VERSION } from '@ai-usage/report-core/merge-bundle';
import { getSourceControlE2EClient } from './e2e/source-control-fixture.server';
import { getSyncE2EUsageReadModel, resetSyncE2EFixture, stageSyncE2EHandoff } from './e2e/sync-fixture.server';
import { executeUsageEngineCommandToCompletion } from './usage-engine-command.server';

test('previews and confirms distinct in-memory handoffs without filesystem state', async () => {
  resetSyncE2EFixture();
  const text = serializeUsageMergeBundle({
    generatedAt: '2026-07-30T12:00:00.000Z',
    machine: { id: 'peer-e2e', label: 'Peer E2E' },
    rows: [],
    version: USAGE_MERGE_BUNDLE_VERSION,
    warnings: [],
  });
  const bytes = new TextEncoder().encode(text);
  const control = getSourceControlE2EClient();
  const previewHandoff = await stageSyncE2EHandoff(bytes);
  const preview = await executeUsageEngineCommandToCompletion(control, {
    command: 'preview-merge',
    input: previewHandoff.input,
  });

  expect(preview).toMatchObject({ command: 'preview-merge', output: { kind: 'merge-preview' }, state: 'succeeded' });
  if (preview.state !== 'succeeded' || preview.command !== 'preview-merge') {
    throw new Error('Expected an E2E merge preview completion.');
  }

  const confirmHandoff = await stageSyncE2EHandoff(bytes);
  expect(confirmHandoff.input.handoffId).not.toBe(previewHandoff.input.handoffId);
  const confirmation = await executeUsageEngineCommandToCompletion(control, {
    command: 'confirm-merge',
    confirmationToken: preview.output.confirmationToken,
    documentDigest: preview.output.documentDigest,
    input: confirmHandoff.input,
  });

  expect(confirmation).toMatchObject({
    command: 'confirm-merge',
    output: { kind: 'none' },
    state: 'succeeded',
  });
  expect(await getSyncE2EUsageReadModel().readSyncFleet()).toMatchObject({
    machines: [expect.objectContaining({ id: 'peer-e2e' })],
  });
});
