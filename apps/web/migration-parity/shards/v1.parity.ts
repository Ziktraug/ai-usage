import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'V1' as const;
const wrapper = 'apps/web/src/server/report-payload.ts';
const currentOutput = 'TanStack serializer over the existing returned wire shape; add a runtime output schema in V1';
const reportImplementationCommit = '0435f859274dd1b130cd764fe4d2dca28a475d8e';
const reportValidationCommit = 'aa2a158b27048a0a376d2e038bb4f33cab49e5fd';
const reportSanitizationCommit = '1c0756086df55e328354228f2a733c8bc9756106';
const reportReviewCheckpoint = '1c0756086df55e328354228f2a733c8bc9756106';
const rpcTransportCommit = '781901ad09051e457fea6a5db05173a19df1dae1';
const wrapperRetirementCommit = 'f6bde5a05faad45560c969449426ddc74c0de4da';
const lazyTransportCommit = 'b93b70c9597c4caa63c865b014d23333cf71e8ef';
const reportClosureCommit = '9804135cf0d2125febf73a9e3f37242fc4b6d11b';
const cancellationCommit = '3dcf2bb647f0491b81a7ab1c6828c378f07ab4eb';
const clientBoundsCommit = '0d4f20abdf800611ec8dd6a2276301edf1885163';
const clientCleanupCommit = '66bc4d0c36a67e8d8113952de5924643042ea9e1';
const e2eTransportCommit = '8b6164f5551dbaf088b3271ccc013d3c84f9f2e3';
const scopedFailureCommit = 'b0a6518d0905c7e0c34405607646393ec7391cfb';
const nitroLoopbackCommit = '0a21f6235288a05ed93c0798c15ddc611cabbc0a';
const localHistoryCancellationCommit = 'bed49d915754b1b571ff5fe9df88d9fb99f52a82';
const loopbackCleanupCommit = '067b4bbb65e7e15f76baabb4ca3950c872a6c438';
const v5Checkpoint = 'c87054f511f7eae79450e9f2a21693f2ea748727';
const targetEvidence = (commit: string, kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});
const reportTargetEvidence = [
  targetEvidence(
    reportImplementationCommit,
    'source',
    'packages/web-contract/src/report.ts; apps/web/src/lib/server/rpc/report.ts; apps/web/src/lib/rpc/report-client.ts define the report contract, server adapter, and browser adapter.',
  ),
  targetEvidence(
    reportValidationCommit,
    'test',
    'packages/web-contract/src/report.test.ts; apps/web/src/lib/server/rpc/report.test.ts; apps/web/src/lib/rpc/report-client.test.ts prove exact runtime schemas and closed public errors.',
  ),
  targetEvidence(
    reportSanitizationCommit,
    'test',
    'apps/web/src/lib/server/rpc/report.test.ts proves report error reasons and messages remain bounded and sanitized.',
  ),
  targetEvidence(
    reportReviewCheckpoint,
    'review',
    '/root/v_vertical_audit independently ACCEPTed V1 on parity/spec and code-quality/seams.',
  ),
  targetEvidence(
    rpcTransportCommit,
    'source',
    'apps/web/server/routes/rpc.ts; apps/web/src/lib/server/rpc/handler.server.ts; apps/web/src/lib/server/rpc/context.server.ts; apps/web/src/lib/rpc/client.ts expose the integrated /rpc transport.',
  ),
  targetEvidence(
    wrapperRetirementCommit,
    'source',
    'Solid report, campaign, quota, and Session callers use injected RPC adapters; apps/web/src/server/report-payload.ts and warmup glue are removed.',
  ),
  targetEvidence(
    lazyTransportCommit,
    'source',
    'apps/web/src/lib/rpc/solid-client.ts lazy-loads the browser RPC transport without crossing the server boundary.',
  ),
  targetEvidence(
    reportClosureCommit,
    'source',
    'apps/web/src/web-query-options.ts keeps optional Skills RPC code outside the report entry closure.',
  ),
  targetEvidence(
    cancellationCommit,
    'test',
    'Report, revision, quota, served-report, and read-model tests prove AbortSignal reaches live work and cleanup.',
  ),
  targetEvidence(
    e2eTransportCommit,
    'test',
    'apps/web/e2e/rpc-test-transport.ts and migrated browser/demo/production/scale suites exercise /rpc paths instead of _serverFn.',
  ),
  targetEvidence(
    scopedFailureCommit,
    'test',
    'apps/web/src/rpc-test-transport.test.ts and E2E helpers scope expected failures to exact RPC paths, statuses, and headers.',
  ),
  targetEvidence(
    nitroLoopbackCommit,
    'test',
    'apps/web/src/lib/server/rpc/nitro-loopback.browser.ts proves real Nitro RPC validation, trust, CSRF, size, concurrency, and response policy.',
  ),
  targetEvidence(
    loopbackCleanupCommit,
    'test',
    'The Nitro loopback fixture proves deterministic resource and child-process cleanup.',
  ),
  targetEvidence(
    v5Checkpoint,
    'command',
    'bun run --cwd apps/web test:rpc-loopback passed with synthetic fixture roots at the accepted V5 checkpoint.',
  ),
  targetEvidence(
    clientCleanupCommit,
    'review',
    `Independent V5 client-bounds review ACCEPTed ${clientBoundsCommit}..${clientCleanupCommit} on parity/spec and code-quality/seams.`,
  ),
  targetEvidence(
    scopedFailureCommit,
    'review',
    `Independent V5 transport review ACCEPTed ${e2eTransportCommit}..${scopedFailureCommit} on parity/spec and code-quality/seams.`,
  ),
  targetEvidence(
    localHistoryCancellationCommit,
    'review',
    `Independent V5 abort review ACCEPTed ${cancellationCommit}..${localHistoryCancellationCommit} on parity/spec and code-quality/seams.`,
  ),
  targetEvidence(
    v5Checkpoint,
    'review',
    `Independent V5 loopback review ACCEPTed ${nitroLoopbackCommit}..${v5Checkpoint}, including cleanup ${loopbackCleanupCommit}.`,
  ),
] as const;
const operation = (
  name: string,
  inputParser: string,
  descriptor: Omit<OperationDescriptor, 'inputParser' | 'outputParser'>,
  currentOwner = wrapper,
): ParityRecord => {
  const baselineRecord = currentRecord(owner, {
    currentOwner,
    evidence: [
      { kind: 'source', reference: `${currentOwner} exports ${name}` },
      { kind: 'test', reference: 'apps/web/src/server/report-payload.server.test.ts and existing client tests' },
    ],
    id: `op:${name}`,
    kind: 'operation',
    operation: { ...descriptor, inputParser, outputParser: currentOutput },
  });
  return {
    ...baselineRecord,
    evidence: [...baselineRecord.evidence, ...reportTargetEvidence],
    status: 'complete',
  };
};

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
