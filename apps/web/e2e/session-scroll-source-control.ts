import {
  collectionSourceDefinitions,
  parseSourceControlCommandResponse,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import type { APIRequestContext } from '@playwright/test';
import { expect } from './browser-test';

const SOURCE_CONTROL_COMMAND_PATH = '/api/source-control/command';

const disableCollectionSource = async (
  request: APIRequestContext,
  requestOrigin: string,
  sourceId: (typeof collectionSourceDefinitions)[number]['id'],
): Promise<SourceControlView> => {
  const response = await request.post(SOURCE_CONTROL_COMMAND_PATH, {
    data: { command: 'set-enabled', enabled: false, sourceId },
    headers: { origin: requestOrigin },
  });
  const result = parseSourceControlCommandResponse(await response.json());
  if (!(response.ok() && result.ok)) {
    throw new Error('Could not disable the synthetic collection source');
  }
  return result.snapshot;
};

export const freezeSessionScrollCollectionSources = async (
  request: APIRequestContext,
  requestOrigin: string,
): Promise<string> => {
  for (const { id } of collectionSourceDefinitions) {
    await disableCollectionSource(request, requestOrigin, id);
  }

  const probeSource = collectionSourceDefinitions[0];
  if (!probeSource) {
    throw new Error('The production fixture must declare at least one collection source');
  }
  await expect
    .poll(
      async () => {
        const snapshot = await disableCollectionSource(request, requestOrigin, probeSource.id);
        const { publication } = snapshot;
        return {
          allSourcesDormant:
            snapshot.sources.length === collectionSourceDefinitions.length &&
            snapshot.sources.every(({ lifecycle, policy }) => lifecycle === 'dormant' && policy === 'disabled'),
          publicationSettled:
            !(publication.dirty || publication.pendingDemand || publication.queued || publication.running) &&
            publication.publishedGeneration >= publication.dirtyGeneration &&
            publication.acknowledgedRequestGeneration >= publication.requestedGeneration,
          queueDepth: snapshot.queueDepth,
          runningCount: snapshot.runningCount,
        };
      },
      {
        message: 'The scale fixture collection sources must become fully dormant before traversal',
        timeout: 60_000,
      },
    )
    .toEqual({
      allSourcesDormant: true,
      publicationSettled: true,
      queueDepth: 0,
      runningCount: 0,
    });

  const settledSnapshot = await disableCollectionSource(request, requestOrigin, probeSource.id);
  const revision = settledSnapshot.publication.revision;
  if (!revision) {
    throw new Error('The settled scale fixture must expose its publication revision');
  }
  return revision;
};
