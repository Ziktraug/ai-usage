import type {
  UsageEngineReplicationStatusOutput,
  UsageEngineReplicationStreamStatus,
} from '@ai-usage/usage-engine-control';

const optionalValue = (value: string | null): string => value ?? 'none';

const renderStream = (label: string, status: UsageEngineReplicationStreamStatus | null): string[] => {
  if (status === null) {
    return [`${label}: not configured`];
  }
  return [
    `${label} (${status.streamId}): pending=${status.pending} in-flight=${status.inFlight} blocked=${status.blocked} acknowledged=${status.acknowledged} ack-generation=${status.acknowledgedThroughGeneration}`,
    `  oldest-unacknowledged=${optionalValue(status.oldestUnacknowledgedAt)}`,
    `  next-retry=${optionalValue(status.nextRetryAt)}`,
    `  last-ack=${optionalValue(status.lastAcknowledgedAt)}`,
    `  last-error=${optionalValue(status.lastErrorCode)}`,
  ];
};

export const renderReplicationStatus = (status: UsageEngineReplicationStatusOutput, json: boolean): string => {
  if (json) {
    return JSON.stringify(status, null, 2);
  }
  const diagnostic = status.lastDiagnostic;
  const diagnosticText =
    diagnostic === null
      ? 'none'
      : [diagnostic.code, diagnostic.streamId, diagnostic.problemCode].filter((value) => value !== null).join(' · ');
  return [
    `Replication: ${status.mode}`,
    `Runtime: ${status.runtimeState}`,
    `Last diagnostic: ${diagnosticText}`,
    ...renderStream('Usage', status.usage),
    ...renderStream('Memory', status.memory),
  ].join('\n');
};
