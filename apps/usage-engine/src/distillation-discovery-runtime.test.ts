import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseDistillationDiscoveryPreview,
  parseDistillationProjectsPage,
} from '@ai-usage/platform-core/distillation-discovery';
import { createCheckoutId, createProjectId, instantNow } from '@ai-usage/platform-core/identity';
import { distillationObject } from '@ai-usage/platform-core/session-distillation';
import { executeAnalysesCommand, parseAnalysesCommand } from '../../cli/src/analyses';
import { createDistillationFixture } from './fixtures/distillation';

const fixtures: Awaited<ReturnType<typeof createDistillationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose();
  }
});
const setup = async () => {
  const fixture = await createDistillationFixture();
  fixtures.push(fixture);
  return fixture;
};

test('new agent discovers acknowledged checkout without source reads, prepares exact token and resumes jobs after restart', async () => {
  const f = await setup();
  const before = await readFile(f.sourceFile);
  const projects = parseDistillationProjectsPage(
    JSON.parse(await executeAnalysesCommand(parseAnalysesCommand(['projects']), f.client)),
  );
  expect(projects.items).toMatchObject([{ projectId: f.projectId, displayName: 'Synthetic ai-usage' }]);
  const preview = parseDistillationDiscoveryPreview(
    JSON.parse(
      await executeAnalysesCommand(
        parseAnalysesCommand(['discover', '--checkout', '/synthetic/ai-usage', '--limit', '1']),
        f.client,
      ),
    ),
  );
  expect(preview.selections).toEqual([f.selection]);
  expect(preview.candidates[0]).toMatchObject({
    eligible: true,
    label: 'Synthetic multi-attempt',
    status: { state: 'not-analyzed' },
  });
  expect(await readFile(f.sourceFile)).toEqual(before);
  expect(await f.kernel().distillation.jobs(f.projectId, 10, null)).toEqual({ items: [], nextCursor: null });
  const prepared = distillationObject(
    await f.client.distillation({
      kind: 'prepare-selection',
      selectionToken: preview.selectionToken,
      providerProcessingAuthorized: true,
      producerSessionId: null,
      revisionKey: null,
    }),
  );
  const jobs = prepared.jobs as { id: string }[];
  expect(jobs).toHaveLength(1);
  await f.restart();
  expect(await f.client.distillation({ kind: 'jobs', projectId: f.projectId, limit: 10, cursor: null })).toMatchObject({
    items: [{ id: jobs[0]!.id, state: 'queued' }],
  });
  expect(
    await f.client.distillation({
      kind: 'prepare-selection',
      selectionToken: preview.selectionToken,
      providerProcessingAuthorized: true,
      producerSessionId: null,
      revisionKey: null,
    }),
  ).toMatchObject({ jobs: [{ id: jobs[0]!.id }] });
}, 30_000);

test('preview rejects stale revisions, wrong subsets, arbitrary paths, basename and ambiguous project names', async () => {
  const f = await setup();
  const request = {
    kind: 'discover' as const,
    selector: { kind: 'project' as const, value: 'Synthetic ai-usage' },
    since: null,
    until: null,
    limit: 1,
  };
  const preview = parseDistillationDiscoveryPreview(await f.client.distillation(request));
  const prepare = {
    kind: 'prepare-selection' as const,
    selectionToken: preview.selectionToken,
    providerProcessingAuthorized: true as const,
    producerSessionId: null,
    revisionKey: null,
  };
  await expect(f.client.distillation({ ...prepare, chosenRowIds: ['not-selected'] })).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect((await f.kernel().distillation.jobs(f.projectId, 10, null)).items).toEqual([]);
  await expect(
    f.client.distillation({ ...request, selector: { kind: 'checkout', value: '/arbitrary/native/history' } }),
  ).rejects.toMatchObject({ code: 'mapping-required' });
  await expect(
    f.client.distillation({ ...request, selector: { kind: 'project', value: 'ai-usage' } }),
  ).rejects.toMatchObject({ code: 'mapping-required' });
  await f.publish('a-new-report-revision', 'portable-opaque');
  await expect(f.client.distillation(prepare)).rejects.toMatchObject({ code: 'selection-stale' });
  const kernel = f.kernel();
  const bootstrap = await kernel.getBootstrapIdentity();
  const projectId = createProjectId();
  const checkoutId = createCheckoutId();
  await kernel.createProject({
    kind: 'local',
    id: projectId,
    owningSpaceId: bootstrap.space.id,
    displayName: 'Synthetic ai-usage',
    repositoryId: null,
    repositorySubpath: null,
    status: 'active',
  });
  await kernel.upsertCheckout(bootstrap.space.id, {
    id: checkoutId,
    deviceId: bootstrap.device.id,
    projectId,
    repositoryId: null,
    localPath: '/other/ai-usage',
    lastObservedAt: instantNow(),
    observedRemote: null,
    status: 'available',
  });
  await kernel.acknowledgeProjectSourceMapping(
    { projectId, projectSourceId: 'synthetic-machine|/other/ai-usage', checkoutId, acknowledgedAt: instantNow() },
    bootstrap.space.id,
  );
  await expect(f.client.distillation(request)).rejects.toMatchObject({ code: 'mapping-required' });
}, 30_000);

test('CLI recall pins exact evidence identity and never substitutes changed or denied source text', async () => {
  const f = await setup();
  const prepared = distillationObject(
    await f.client.distillation({
      kind: 'prepare',
      projectId: f.projectId,
      selections: [f.selection],
      providerProcessingAuthorized: true,
      producerSessionId: null,
      revisionKey: null,
    }),
  );
  const jobId = String(distillationObject((prepared.jobs as unknown[])[0]).id);
  const lease = await f.kernel().distillation.claim(f.projectId, jobId);
  const event = lease.packet.events.find((item) => item.kind === 'tool-result')!;
  const saved = await f.kernel().distillation.submit({
    projectId: f.projectId,
    jobId,
    leaseId: lease.leaseId,
    packetDigest: lease.packet.packetDigest,
    extractorVersion: lease.extractorVersion,
    ...(lease.job.progress
      ? { snapshotDigest: lease.job.progress.snapshotDigest, segmentIndex: lease.job.progress.segmentIndex }
      : {}),
    content: {
      schemaVersion: 1,
      summary: {
        text: 'The revision cache test failed.',
        basis: 'observed',
        evidence: [{ eventId: event.id, quote: event.text.slice(0, 600) }],
      },
      episodes: [],
      abstention: null,
    },
  });
  const command = parseAnalysesCommand(['evidence', '--project', f.projectId, '--id', saved.id, '--event', event.id]);
  const proof = JSON.parse(await executeAnalysesCommand(command, f.client));
  expect(proof).toMatchObject({ status: 'available', events: [{ id: event.id }] });
  const historical = JSON.parse(
    await executeAnalysesCommand(parseAnalysesCommand(['get', '--project', f.projectId, '--id', saved.id]), f.client),
  );
  expect(historical.content.summary.evidence).toEqual(saved.content.summary.evidence);
  const original = await readFile(f.sourceFile);
  await writeFile(f.sourceFile, Buffer.concat([original, Buffer.from('\n')]));
  expect(JSON.parse(await executeAnalysesCommand(command, f.client))).toMatchObject({ status: 'changed', events: [] });
  await writeFile(f.sourceFile, original);
  const identity = await f.kernel().getBootstrapIdentity();
  const mapping = await f.kernel().findProjectSourceMapping(identity.space.id, f.projectSourceId);
  const other = createProjectId();
  await f.kernel().createProject({
    kind: 'local',
    id: other,
    owningSpaceId: identity.space.id,
    displayName: 'Revoked mapping destination',
    repositoryId: null,
    repositorySubpath: null,
    status: 'active',
  });
  await f.kernel().acknowledgeProjectSourceMapping({ ...mapping!, projectId: other }, identity.space.id);
  expect(JSON.parse(await executeAnalysesCommand(command, f.client))).toMatchObject({ status: 'denied', events: [] });
  expect(
    JSON.parse(
      await executeAnalysesCommand(parseAnalysesCommand(['get', '--project', f.projectId, '--id', saved.id]), f.client),
    ).content.summary.evidence,
  ).toEqual(saved.content.summary.evidence);
}, 30_000);
