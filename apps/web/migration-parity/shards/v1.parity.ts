import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor } from '../schema';

const owner = 'V1' as const;
const wrapper = 'apps/web/src/server/report-payload.ts';
const currentOutput = 'TanStack serializer over the existing returned wire shape; add a runtime output schema in V1';
const operation = (
  name: string,
  inputParser: string,
  descriptor: Omit<OperationDescriptor, 'inputParser' | 'outputParser'>,
  currentOwner = wrapper,
) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [
      { kind: 'source', reference: `${currentOwner} exports ${name}` },
      { kind: 'test', reference: 'apps/web/src/server/report-payload.server.test.ts and existing client tests' },
    ],
    id: `op:${name}`,
    kind: 'operation',
    operation: { ...descriptor, inputParser, outputParser: currentOutput },
  });

export default defineParityShard({
  owner,
  records: [
    operation('getReportRevisionManifest', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'apps/web/src/server/report-payload.server.ts#getReportRevisionManifestForServer',
      publicErrors: ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'],
      target: 'report.revisionManifest',
      transport: 'query',
    }),
    operation('getReportRevisionBootstrap', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'apps/web/src/server/report-payload.server.ts#getReportRevisionBootstrapForServer',
      publicErrors: ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'],
      target: 'report.revisionBootstrap',
      transport: 'query',
    }),
    operation('getFocusedReportSupport', 'parseFocusedRevisionRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/revision-query-runner.server.ts#runRevisionQueryForServer(support)',
      publicErrors: ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'],
      target: 'report.focusedSupport',
      transport: 'query',
    }),
    operation('getFocusedReportOverview', 'parseFocusedOverviewRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/revision-query-runner.server.ts#runRevisionQueryForServer(overview)',
      publicErrors: ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'],
      target: 'report.focusedOverview',
      transport: 'query',
    }),
    operation('getFocusedReportBreakdown', 'parseFocusedBreakdownRequest', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/revision-query-runner.server.ts#runRevisionQueryForServer(breakdown)',
      publicErrors: ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'],
      target: 'report.focusedBreakdown',
      transport: 'query',
    }),
    operation('getCampaignLabelOverrides', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'apps/web/src/server/campaign-labels.server.ts#getCampaignLabelOverridesForServer',
      publicErrors: ['ForbiddenDemo', 'Unavailable'],
      target: 'campaign.labelOverrides',
      transport: 'query',
    }),
    operation('setCampaignLabelOverride', 'parseCampaignLabelOverrideMutation', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/campaign-labels.server.ts#setCampaignLabelOverrideFromRequestForServer',
      publicErrors: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Conflict'],
      target: 'campaign.setLabelOverride',
      transport: 'mutation',
    }),
    operation('saveProjectGroups', 'parseWebUsageEngineCommand(replace-project-groups-by-reference)', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/report-payload.server.ts#saveProjectGroupsFromRequestForServer',
      publicErrors: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'EngineUnavailable', 'Conflict'],
      target: 'projectGroup.save',
      transport: 'mutation',
    }),
    operation('getReportPerfEnabled', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'apps/web/src/server/report-payload.server.ts#reportPerfEnabled',
      publicErrors: ['ForbiddenDemo'],
      target: 'runtime.reportPerfEnabled or request context',
      transport: 'query',
    }),
    operation(
      'getProviderQuotaHistory',
      'parseProviderQuotaHistoryRequest',
      {
        currentMethod: 'POST',
        implementationOwner:
          'apps/web/src/server/provider-quota-resolver.server.ts#resolveProviderQuotaHistoryForServer',
        publicErrors: ['ForbiddenDemo', 'InvalidInput', 'Unavailable'],
        target: 'quota.history',
        transport: 'query',
      },
      'apps/web/src/server/provider-quota.ts',
    ),
  ],
});
