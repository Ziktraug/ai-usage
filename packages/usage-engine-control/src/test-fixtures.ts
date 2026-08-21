import { collectionSourceDefinitions } from '@ai-usage/report-core/source-control';
import { parseUsageEngineStatus, USAGE_ENGINE_PROTOCOL_VERSION, type UsageEngineStatus } from './contracts';

export const fixtureInstanceId = '11111111-1111-4111-8111-111111111111';
export const fixtureGeneratedAt = '2026-07-29T12:00:00.000Z';

export const fixtureSourceControl = (instanceId = fixtureInstanceId) => ({
  generatedAt: fixtureGeneratedAt,
  generation: 0,
  instanceId,
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
  queueDepth: 0,
  runningCount: 0,
  sources: collectionSourceDefinitions.map((definition) => ({
    availability: 'not-detected',
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'not-run',
    lifecycle: 'dormant',
    policy: definition.defaultEnabled ? 'enabled' : 'disabled',
    reason: {
      code: definition.defaultEnabled ? 'input-missing' : 'policy-disabled',
    },
    warnings: [],
  })),
});

export const fixtureStatus = (instanceId = fixtureInstanceId): UsageEngineStatus =>
  parseUsageEngineStatus({
    currentPublication: null,
    degradedReason: null,
    generatedAt: fixtureGeneratedAt,
    generation: 0,
    instanceId,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    readiness: 'ready',
    sourceControl: fixtureSourceControl(instanceId),
    storeSchemaVersion: 1,
  });
