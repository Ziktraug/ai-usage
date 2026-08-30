import type { ReplicationStatus, ReplicationStreamStatus } from '@ai-usage/web-contract/replication';
import type { SourcePresentationTone } from '../../../source-control-presentation-model';

export interface ReplicationStatusPresentation {
  readonly explanation: string;
  readonly label: string;
  readonly tone: SourcePresentationTone;
}

const diagnosticLabels: Readonly<Record<NonNullable<ReplicationStatus['lastDiagnostic']>['code'], string>> = {
  acknowledged: 'The server confirmed the latest replication batch.',
  blocked: 'Replication is blocked until its identity or policy conflict is repaired.',
  'configuration-invalid': 'The connected platform configuration is invalid.',
  'credential-missing': 'No Device credential is available.',
  'credential-unavailable': 'The Device credential could not be read safely.',
  'device-rejected': 'The connected platform rejected this Device.',
  'device-unreachable': 'The connected platform could not be reached.',
  idle: 'No replication event is ready to publish.',
  'retry-scheduled': 'A retry is scheduled after a temporary failure.',
  'setup-failed': 'The local replication stores could not be prepared safely.',
};

export const replicationDiagnosticLabel = (diagnostic: ReplicationStatus['lastDiagnostic']): string | undefined => {
  if (diagnostic === null) {
    return;
  }
  const suffix = diagnostic.problemCode === null ? '' : ` (${diagnostic.problemCode})`;
  return `${diagnosticLabels[diagnostic.code]}${suffix}`;
};

export const presentReplicationStatus = (status: ReplicationStatus): ReplicationStatusPresentation => {
  if (status.mode === 'local-only') {
    return {
      explanation: 'Selected facts stay on this Device; no connected platform origin is configured.',
      label: 'Local only',
      tone: 'info',
    };
  }
  const blocked = (status.memory?.blocked ?? 0) + (status.usage?.blocked ?? 0);
  if (blocked > 0 || status.lastDiagnostic?.code === 'blocked' || status.lastDiagnostic?.code === 'device-rejected') {
    return {
      explanation: 'Previously published facts remain available, but at least one new event needs operator attention.',
      label: 'Blocked',
      tone: 'danger',
    };
  }
  if (status.runtimeState === 'publishing') {
    return { explanation: 'This Device is publishing a bounded batch.', label: 'Publishing', tone: 'ok' };
  }
  if (status.runtimeState === 'connecting') {
    return { explanation: 'This Device is establishing its outbound connection.', label: 'Connecting', tone: 'info' };
  }
  if (status.runtimeState === 'disposed') {
    return { explanation: 'The outbound worker has stopped.', label: 'Stopped', tone: 'warning' };
  }
  const pending =
    (status.memory?.pending ?? 0) +
    (status.memory?.inFlight ?? 0) +
    (status.usage?.pending ?? 0) +
    (status.usage?.inFlight ?? 0);
  if (pending > 0) {
    return {
      explanation: 'Local collection remains available while queued facts wait for publication.',
      label: 'Waiting to publish',
      tone: 'warning',
    };
  }
  return { explanation: 'No local replication event is waiting.', label: 'Up to date', tone: 'ok' };
};

export const presentReplicationStream = (stream: ReplicationStreamStatus): ReplicationStatusPresentation => {
  if (stream.blocked > 0) {
    return {
      explanation: `${stream.blocked} event${stream.blocked === 1 ? '' : 's'} blocked.`,
      label: 'Blocked',
      tone: 'danger',
    };
  }
  if (stream.inFlight > 0) {
    return { explanation: 'A claimed batch is being published.', label: 'Publishing', tone: 'ok' };
  }
  if (stream.pending > 0) {
    return {
      explanation: `${stream.pending} event${stream.pending === 1 ? '' : 's'} queued.`,
      label: 'Queued',
      tone: 'warning',
    };
  }
  if (stream.lastAcknowledgedAt !== null) {
    return { explanation: 'Every queued event is published.', label: 'Published', tone: 'ok' };
  }
  return { explanation: 'No event has been published yet.', label: 'Waiting', tone: 'info' };
};
