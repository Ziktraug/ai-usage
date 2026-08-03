import {
  type CollectionSourceGroup,
  collectionSourceDefinitions,
  type SourceControlEntryView,
  type SourcePublicationView,
} from '@ai-usage/report-core/source-control';
import type { SourceControlClientState } from '../../../source-control-client';
import { presentSourceState } from './presentation';

// Keep the catalogue order stable even when engine snapshots arrive out of order.
export const orderedSources = (state: SourceControlClientState): readonly SourceControlEntryView[] => {
  const byId = new Map(state.snapshot?.sources.map((source) => [source.id, source] as const) ?? []);
  return collectionSourceDefinitions.flatMap((definition) => {
    const source = byId.get(definition.id);
    return source ? [source] : [];
  });
};

export const healthySources = (sources: readonly SourceControlEntryView[]): readonly SourceControlEntryView[] =>
  sources.filter((source) => presentSourceState(source).tone === 'ok');

export const deviationSources = (sources: readonly SourceControlEntryView[]): readonly SourceControlEntryView[] =>
  sources.filter((source) => presentSourceState(source).tone !== 'ok');

export const sourceGroup = (sourceId: SourceControlEntryView['id']): CollectionSourceGroup | undefined =>
  collectionSourceDefinitions.find((definition) => definition.id === sourceId)?.group;

export const sourcesInGroup = (
  sources: readonly SourceControlEntryView[],
  group: CollectionSourceGroup,
): readonly SourceControlEntryView[] => sources.filter((source) => sourceGroup(source.id) === group);

export const sourceCanRun = (source: SourceControlEntryView): boolean =>
  source.policy === 'enabled' &&
  source.availability === 'detected' &&
  !['queued', 'running', 'pausing'].includes(source.lifecycle);

export const sourceMutationDisabledReason = (pending: boolean, available: boolean): string | undefined => {
  if (!available) {
    return 'The usage engine is not available for source commands.';
  }
  if (pending) {
    return 'Another source command is pending.';
  }
  return;
};

export const sourceRunDisabledReason = (
  source: SourceControlEntryView,
  pending: boolean,
  available: boolean,
): string | undefined => {
  const mutationReason = sourceMutationDisabledReason(pending, available);
  if (mutationReason) {
    return mutationReason;
  }
  if (source.policy === 'disabled') {
    return 'Enable this source before running it.';
  }
  if (source.availability !== 'detected') {
    return 'Detect a supported input before running this source.';
  }
  if (!sourceCanRun(source)) {
    return 'This source is already queued or running.';
  }
  return;
};

export const publicationStatus = (publication: SourcePublicationView): string => {
  if (publication.running) {
    return 'Publishing stored data now.';
  }
  if (publication.queued) {
    return 'Publication is queued.';
  }
  return publication.pendingDemand
    ? 'Publication demand is waiting for its dependency.'
    : 'Publication demand is fully acknowledged.';
};

export const conciseSourceStatus = (state: SourceControlClientState): string => {
  if (state.commandError) {
    return state.commandError;
  }
  if (state.connection === 'disconnected') {
    return 'Connection interrupted; reconnecting.';
  }
  if (state.connection === 'protocol-mismatch') {
    return 'The usage engine protocol is incompatible.';
  }
  return state.publication ? 'Report published.' : '';
};

export const compactRevision = (revision: string): string =>
  revision.length <= 24 ? revision : `${revision.slice(0, 12)}…${revision.slice(-8)}`;
