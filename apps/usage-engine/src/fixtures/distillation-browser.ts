import { createHash } from 'node:crypto';
import {
  type DistillationEvidencePacket,
  distillationEvidenceDigestInput,
} from '@ai-usage/platform-core/distillation-evidence';
import { createCheckoutId, createProjectId, instantNow } from '@ai-usage/platform-core/identity';
import { createDistillationFixture } from './distillation';

// Explicitly launched only by the disposable Memory browser suite.
const fixture = await createDistillationFixture('long-session');
const seedLibrary = async () => {
  const kernel = fixture.kernel();
  const identity = await kernel.getBootstrapIdentity();
  const otherProjectId = createProjectId();
  await kernel.createProject({
    id: otherProjectId,
    displayName: 'Synthetic second project',
    kind: 'local',
    owningSpaceId: identity.space.id,
    repositoryId: null,
    repositorySubpath: null,
    status: 'active',
  });
  const checkoutId = createCheckoutId();
  await kernel.upsertCheckout(identity.space.id, {
    id: checkoutId,
    deviceId: identity.device.id,
    projectId: otherProjectId,
    repositoryId: null,
    localPath: '/synthetic/second',
    lastObservedAt: instantNow(),
    observedRemote: null,
    status: 'available',
  });
  await kernel.acknowledgeProjectSourceMapping(
    {
      projectId: otherProjectId,
      checkoutId,
      projectSourceId: 'synthetic-machine|/synthetic/second',
      acknowledgedAt: instantNow(),
    },
    identity.space.id,
  );
  const analyses: { id: string; projectId: string; summary: string }[] = [];
  for (let index = 0; index < 160; index += 1) {
    const projectId = index % 2 === 0 ? fixture.projectId : otherProjectId;
    const nativeSessionId = `browser-volume-${index}`;
    const summary = `Library account ${String(index).padStart(3, '0')}. A saved result for bounded navigation.`;
    const packet: DistillationEvidencePacket = {
      schemaVersion: 1,
      normalizationVersion: 1,
      redactionVersion: 1,
      packetDigest: '',
      source: {
        harnessKey: 'codex',
        machineId: 'synthetic-machine',
        nativeSessionId,
        projectId,
        reportAnchor: { revision: 'expired-browser-volume-anchor', rowId: nativeSessionId },
        sessionDate: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
        version: { digest: 'a'.repeat(64), bytes: 100, totalBytes: 100, modifiedAtMs: 1 },
      },
      events: [
        {
          id: 'result',
          line: 1,
          kind: 'tool-result',
          text: summary,
          timestamp: null,
          nativeTurnId: null,
          roundId: null,
          toolName: null,
          callId: null,
          truncated: false,
          redacted: false,
        },
      ],
      coverage: {
        scope: 'session-only',
        completion: 'completed',
        status: index % 7 === 0 ? 'partial' : 'complete',
        lines: 1,
        includedEvents: 1,
        exclusions: index % 7 === 0 ? [{ reason: 'unsupported-content', count: 1 }] : [],
        childDiscovery: 'not-performed',
        childrenNotAnalyzed: null,
      },
    };
    packet.packetDigest = createHash('sha256').update(distillationEvidenceDigestInput(packet)).digest('hex');
    const job = await kernel.distillation.prepare({
      packet,
      grant: {
        checkoutPath: '/synthetic/browser-volume',
        machineId: 'synthetic-machine',
        nativeSessionId,
        projectId,
        projectSourceId: 'synthetic-machine|/synthetic/browser-volume',
        selection: { revision: 'expired-browser-volume-anchor', rowId: nativeSessionId },
      },
      producerSessionId: null,
      revisionKey: null,
    });
    const lease = await kernel.distillation.claim(projectId, job.id);
    const analysis = await kernel.distillation.submit({
      projectId,
      jobId: job.id,
      leaseId: lease.leaseId,
      packetDigest: packet.packetDigest,
      content: {
        schemaVersion: 1,
        summary: { text: summary, basis: 'observed', evidence: [{ eventId: 'result', quote: summary }] },
        episodes: [],
        abstention: null,
      },
    });
    analyses.push({ id: analysis.id, projectId, summary });
  }
  process.stdout.write(`${JSON.stringify({ kind: 'synthetic-volume-ready', analyses, otherProjectId })}\n`);
};
process.stdout.write(
  `${JSON.stringify({ kind: 'synthetic-distillation-ready', homeDirectory: fixture.homeDirectory, stateDirectory: fixture.stateDirectory, databasePath: fixture.databasePath, projectId: fixture.projectId, selection: fixture.selection, sourceFile: fixture.sourceFile })}\n`,
);
process.on('SIGHUP', () => {
  fixture
    .restart()
    .then(() => process.stdout.write('synthetic-distillation-restarted\n'))
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
});
process.once('SIGUSR1', () => {
  seedLibrary().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
});
await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
await fixture.dispose();
