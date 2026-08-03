import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'V2' as const;
const wrapper = 'apps/web/src/server/report-payload.ts';
const sessionContractCommit = '8301bff30945876270e15c45bf972cac07075faa';
const sessionServerCommit = '105297a888cdb785fe282092585c943175843d2b';
const sessionClientCommit = 'b820561884c7e3d88a18d8ac4bb763f38dde3333';
const sessionMessageCommit = '7bece8332a935bfa7959b4c1fedd1dfc853b6802';
const sessionErrorCommit = '5c57503d315311cf839dfe9dc7f709b902bb59b3';
const sessionReviewCheckpoint = '5c57503d315311cf839dfe9dc7f709b902bb59b3';
const rpcTransportCommit = '781901ad09051e457fea6a5db05173a19df1dae1';
const wrapperRetirementCommit = 'f6bde5a05faad45560c969449426ddc74c0de4da';
const lazyTransportCommit = 'b93b70c9597c4caa63c865b014d23333cf71e8ef';
const cancellationCommit = '3dcf2bb647f0491b81a7ab1c6828c378f07ab4eb';
const clientBoundsCommit = '0d4f20abdf800611ec8dd6a2276301edf1885163';
const clientCleanupCommit = '66bc4d0c36a67e8d8113952de5924643042ea9e1';
const localHistoryCancellationCommit = 'bed49d915754b1b571ff5fe9df88d9fb99f52a82';
const e2eTransportCommit = '8b6164f5551dbaf088b3271ccc013d3c84f9f2e3';
const scopedFailureCommit = 'b0a6518d0905c7e0c34405607646393ec7391cfb';
const nitroLoopbackCommit = '0a21f6235288a05ed93c0798c15ddc611cabbc0a';
const loopbackCleanupCommit = '067b4bbb65e7e15f76baabb4ca3950c872a6c438';
const v5Checkpoint = 'c87054f511f7eae79450e9f2a21693f2ea748727';
const targetEvidence = (commit: string, kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});
const sessionTargetEvidence = [
  targetEvidence(
    sessionContractCommit,
    'source',
    'packages/web-contract/src/session.ts defines exact Session routes, input/output schemas, and closed public error families.',
  ),
  targetEvidence(
    sessionContractCommit,
    'test',
    'packages/web-contract/src/session.test.ts proves exact Session methods, paths, schemas, errors, and byte bounds.',
  ),
  targetEvidence(
    sessionServerCommit,
    'source',
    'apps/web/src/lib/server/rpc/session.ts adapts the Session contract to the existing exact-revision and local-read services.',
  ),
  targetEvidence(
    sessionServerCommit,
    'test',
    'apps/web/src/lib/server/rpc/session.test.ts proves operation mapping, validation, errors, cancellation, and no private leakage.',
  ),
  targetEvidence(
    sessionClientCommit,
    'source',
    'apps/web/src/lib/rpc/session-client.ts provides the injected browser adapter for all five Session operations.',
  ),
  targetEvidence(
    sessionClientCommit,
    'test',
    'apps/web/src/lib/rpc/session-client.test.ts proves exact requests, response validation, revision identity, and AbortSignal forwarding.',
  ),
  targetEvidence(
    sessionMessageCommit,
    'test',
    'packages/web-contract/src/session.test.ts preserves the frozen Session protocol messages.',
  ),
  targetEvidence(
    sessionErrorCommit,
    'test',
    'apps/web/src/lib/server/rpc/session.test.ts preserves exact Session protocol errors without leaking private causes.',
  ),
  targetEvidence(
    sessionReviewCheckpoint,
    'review',
    '/root/v0_impl independently ACCEPTed the focused V2 rework on parity/spec and code-quality/seams.',
  ),
  targetEvidence(
    rpcTransportCommit,
    'source',
    'apps/web/server/routes/rpc.ts; apps/web/src/lib/server/rpc/handler.server.ts; apps/web/src/lib/server/rpc/context.server.ts; apps/web/src/lib/rpc/client.ts expose the integrated /rpc transport.',
  ),
  targetEvidence(
    wrapperRetirementCommit,
    'source',
    'Solid Session callers use injected RPC adapters; apps/web/src/server/report-payload.ts and _serverFn warmup glue are removed.',
  ),
  targetEvidence(
    lazyTransportCommit,
    'source',
    'apps/web/src/lib/rpc/solid-client.ts lazy-loads the browser RPC transport without crossing the server boundary.',
  ),
  targetEvidence(
    cancellationCommit,
    'test',
    'Revision-query, Session detail/VCS, served-report, and read-model tests prove AbortSignal reaches live work and cleanup.',
  ),
  targetEvidence(
    localHistoryCancellationCommit,
    'test',
    'apps/web/src/server/session-detail.server.test.ts and packages/local-machine/src/session-detail.test.ts prove local history reads are interruptible.',
  ),
  targetEvidence(
    e2eTransportCommit,
    'test',
    'Migrated browser/demo/production/scale suites exercise Session traffic through /rpc paths instead of _serverFn.',
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
    'V5 integrated RPC contract/server/client tests, parity check, typecheck, lint, Svelte build, and serialized Nitro loopback gate passed.',
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
): ParityRecord => {
  const baselineRecord = currentRecord(owner, {
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
  return {
    ...baselineRecord,
    evidence: [...baselineRecord.evidence, ...sessionTargetEvidence],
    status: 'complete',
  };
};

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
