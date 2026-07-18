import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  type SourcePolicyOverrides,
} from '@ai-usage/report-core/source-control';
import type { ScheduledSource } from '@ai-usage/report-data/source-adapters';
import type { ReportPublicationPort, SourcePolicyStore } from '@ai-usage/report-data/source-control';
import { Duration, Effect } from 'effect';

const policyChangePollInterval = Duration.millis(10);
const pausingStateObservationWindow = Duration.millis(250);

export interface SourceControlE2EFixture {
  policyStore: SourcePolicyStore;
  publication: ReportPublicationPort;
  sources: ReadonlyMap<CollectionSourceId, ScheduledSource>;
}

export const createSourceControlE2EFixture = (): SourceControlE2EFixture => {
  const policies: SourcePolicyOverrides = {};
  const policyStore: SourcePolicyStore = {
    load: Effect.sync(() => ({ ...policies })),
    setEnabled: (sourceId, enabled) =>
      Effect.sync(() => {
        policies[sourceId] = { enabled };
      }),
  };
  let publicationRevision = 0;
  const publication: ReportPublicationPort = {
    publish: Effect.sync(() => {
      publicationRevision++;
      return { changed: true, revision: `e2e-revision-${publicationRevision}` };
    }),
  };
  const sources = new Map<CollectionSourceId, ScheduledSource>();
  for (const definition of collectionSourceDefinitions) {
    let runCount = 0;
    sources.set(definition.id, {
      cadence: Duration.millis(definition.cadenceMs),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: definition.id,
      run: () =>
        Effect.gen(function* () {
          runCount++;
          if (definition.id === 'codex.sessions' && runCount > 1) {
            while (policies[definition.id]?.enabled !== false) {
              yield* Effect.sleep(policyChangePollInterval);
            }
            yield* Effect.sleep(pausingStateObservationWindow);
          }
          return {
            changed: runCount > 1,
            inputCount: runCount,
            outputCount: runCount,
            warnings: [],
          };
        }),
    });
  }
  return { policyStore, publication, sources };
};
