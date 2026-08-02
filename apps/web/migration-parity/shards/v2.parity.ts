import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor } from '../schema';

const owner = 'V2' as const;
const wrapper = 'apps/web/src/server/report-payload.ts';
const operation = (
  name: string,
  inputParser: string,
  descriptor: Omit<OperationDescriptor, 'inputParser' | 'outputParser'>,
) =>
  currentRecord(owner, {
    currentOwner: wrapper,
    evidence: [
      { kind: 'source', reference: `${wrapper} exports ${name}` },
      {
        kind: 'test',
        reference: 'apps/web/src/session-query-client.test.ts; apps/web/src/focused-report-client.test.ts',
      },
    ],
    id: `op:${name}`,
    kind: 'operation',
    operation: {
      ...descriptor,
      inputParser,
      outputParser: 'TanStack serializer over the exact-revision wire shape; add a runtime output schema in V2',
    },
  });

export default defineParityShard({
  owner,
  records: [
    operation('getReportSessionPage', 'parseSessionQueryRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/revision-query-runner.server.ts#runRevisionQueryForServer(sessions)',
      publicErrors: ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'],
      target: 'session.page',
      transport: 'query',
    }),
    operation('getReportSessionCampaignChildren', 'parseSessionCampaignChildrenRequest', {
      currentMethod: 'POST',
      implementationOwner:
        'apps/web/src/server/revision-query-runner.server.ts#runRevisionQueryForServer(campaign-children)',
      publicErrors: ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'],
      target: 'session.campaignChildren',
      transport: 'query',
    }),
    operation('getReportSessionNeighbors', 'parseSessionNeighborRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/revision-query-runner.server.ts#runRevisionQueryForServer(neighbors)',
      publicErrors: ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'],
      target: 'session.neighbors',
      transport: 'query',
    }),
    operation('getReportSessionDetail', 'parseSessionDetailRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/session-detail.server.ts#getLocalSessionDetailForServer',
      publicErrors: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
      target: 'session.detail',
      transport: 'query',
    }),
    operation('resolveReportSessionVcs', 'parseSessionVcsResolveRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/session-vcs.server.ts#resolveSessionVcsForServer',
      publicErrors: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
      target: 'session.vcs',
      transport: 'query',
    }),
  ],
});
