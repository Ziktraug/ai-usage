import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'V4' as const;
const legacyWrapper = 'apps/web/src/server/sync.ts';
const transportContractCommit = 'bcff1ea6dd125c2b51665ebdf63dc23a1384a664';
const abortContractCommit = '34e76eb5ac9b116395d0ccc715484caa3630760a';
const serverAdapterCommit = '632ce8afb9717c47f46b1de6d5976f570131c6eb';
const browserAdapterCommit = 'dcb8ecbd1d354111b28f952b9e533ebc96e13041';
const verticalCorrectionCommit = 'b59f26437779857ade7fe0aa5b350d81ab6fdcc2';
const transportConvergenceCommit = '781901ad09051e457fea6a5db05173a19df1dae1';
const transportRetirementCommit = 'f6bde5a05faad45560c969449426ddc74c0de4da';
const cancellationCommit = '3dcf2bb647f0491b81a7ab1c6828c378f07ab4eb';
const clientBoundsCommit = '0d4f20abdf800611ec8dd6a2276301edf1885163';
const abortCleanupCommit = '66bc4d0c36a67e8d8113952de5924643042ea9e1';
const e2eTransportCommit = '8b6164f5551dbaf088b3271ccc013d3c84f9f2e3';
const e2eFailureScopeCommit = 'b0a6518d0905c7e0c34405607646393ec7391cfb';
const nitroLoopbackCommit = '0a21f6235288a05ed93c0798c15ddc611cabbc0a';
const localHistoryCancellationCommit = 'bed49d915754b1b571ff5fe9df88d9fb99f52a82';
const loopbackCleanupCommit = '067b4bbb65e7e15f76baabb4ca3950c872a6c438';
const v5Checkpoint = 'c87054f511f7eae79450e9f2a21693f2ea748727';
const transportTypecheckCommit = '04bc076d27cca03ab4a2d825c1030738af7ed66f';

const targetEvidence = (commit: string, kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});

const completeRecord = (record: ParityRecord, evidence: readonly ParityEvidence[]): ParityRecord => ({
  ...record,
  evidence: [...record.evidence, ...evidence],
  status: 'complete',
});

const operation = (name: string, descriptor: OperationDescriptor, evidence: readonly ParityEvidence[]) =>
  completeRecord(
    currentRecord(owner, {
      currentOwner: legacyWrapper,
      evidence: [
        { kind: 'source', reference: `${legacyWrapper} exported ${name}` },
        {
          kind: 'test',
          reference: 'apps/web/src/server/sync.server.test.ts; apps/web/src/server/manual-merge-upload.server.test.ts',
        },
      ],
      id: `op:${name}`,
      kind: 'operation',
      operation: descriptor,
    }),
    evidence,
  );

export default defineParityShard({
  owner,
  records: [
    operation(
      'getSyncFleet',
      {
        currentMethod: 'GET',
        implementationOwner: 'apps/web/src/server/sync-data.server.ts#getSyncFleetForServer',
        inputParser: 'none',
        outputParser: 'packages/web-contract/src/sync.ts#syncFleetOutputSchema',
        publicErrors: ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'],
        target: 'sync.fleet',
        transport: 'query',
      },
      [
        targetEvidence(
          transportContractCommit,
          'source',
          'packages/web-contract/src/sync.ts#syncContract.fleet (GET /rpc/sync/fleet) and syncFleetOutputSchema',
        ),
        targetEvidence(
          serverAdapterCommit,
          'source',
          'apps/web/src/lib/server/rpc/sync.ts#createSyncRpcRouter adapts apps/web/src/server/sync-data.server.ts#getSyncFleetForServer without copying read logic.',
        ),
        targetEvidence(
          browserAdapterCommit,
          'test',
          'packages/web-contract/src/sync.test.ts; apps/web/src/lib/server/rpc/sync.test.ts; apps/web/src/lib/rpc/sync-client.test.ts; apps/web/src/lib/rpc/sync-solid-client.test.ts',
        ),
        targetEvidence(
          transportConvergenceCommit,
          'source',
          'apps/web/src/lib/server/rpc/router.ts; apps/web/src/lib/server/rpc/handler.server.ts; apps/web/src/lib/rpc/client.ts expose fleet through the integrated contract-first /rpc transport.',
        ),
        targetEvidence(
          transportRetirementCommit,
          'source',
          'apps/web/src/server/sync.ts and every production createServerFn wrapper are retired; JSON Sync calls use oRPC while manual bytes remain explicit HTTP.',
        ),
        targetEvidence(
          cancellationCommit,
          'test',
          'Sync read-model and transport tests prove request cancellation reaches live work without changing public errors.',
        ),
        targetEvidence(
          nitroLoopbackCommit,
          'test',
          'apps/web/src/lib/server/rpc/nitro-loopback.browser.ts proves real Nitro RPC validation, trust, CSRF, size, concurrency, and response policy.',
        ),
        targetEvidence(
          loopbackCleanupCommit,
          'test',
          'The Nitro loopback fixture proves deterministic listener, resource, temporary-path, and process cleanup.',
        ),
        targetEvidence(
          transportTypecheckCommit,
          'command',
          'bun test packages/web-contract/src/sync.test.ts apps/web/src/lib/server/rpc/sync.test.ts apps/web/src/lib/rpc/sync-client.test.ts apps/web/src/lib/rpc/sync-solid-client.test.ts; bun run test:web-rpc-loopback; bun tools/check-web-migration-parity.ts',
        ),
        targetEvidence(
          verticalCorrectionCommit,
          'review',
          'Original V4 reviewer /root/v0_impl returned REWORK for 84624be..108292a; integrated corrections 34e76eb/b59f264 closed abort ownership, policy, validation, and client seams before convergence.',
        ),
        targetEvidence(
          e2eFailureScopeCommit,
          'review',
          `Independent V5 transport review ACCEPTed ${e2eTransportCommit}..${e2eFailureScopeCommit} on parity/spec and code-quality/seams.`,
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
      ],
    ),
    operation(
      'exportManualMergeBundle',
      {
        currentMethod: 'POST',
        implementationOwner: 'apps/web/src/server/sync-data.server.ts#exportManualMergeBundleForServer',
        inputParser: 'no request body; trusted-local and CSRF policy before handler acquisition',
        outputParser: 'bounded attachment headers plus canonical portable-usage JSON body',
        publicErrors: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
        target: 'explicit download route with optional bounded oRPC metadata',
        transport: 'file',
      },
      [
        targetEvidence(
          abortContractCommit,
          'source',
          'packages/web-contract/src/sync.ts#manualMergeDownloadTransport freezes POST /api/manual-merge/download, request-signal abort, CSRF, local trust, and attachment response semantics.',
        ),
        targetEvidence(
          serverAdapterCommit,
          'source',
          'apps/web/src/lib/server/rpc/sync.ts#createManualMergeDownloadHandler and apps/web/server/routes/api/manual-merge-download.post.ts adapt exportManualMergeBundleForServer as an explicit file route; file bytes never enter oRPC.',
        ),
        targetEvidence(
          verticalCorrectionCommit,
          'test',
          'apps/web/src/lib/server/rpc/sync.test.ts; apps/web/src/lib/server/rpc/handler.server.test.ts; apps/web/src/lib/rpc/sync-client.test.ts; apps/web/src/server/manual-merge-upload.server.test.ts',
        ),
        targetEvidence(
          clientBoundsCommit,
          'test',
          'apps/web/src/lib/rpc/sync-client.test.ts proves Content-Length, streamed byte, filename, content type, abort, and reader cleanup bounds before browser download.',
        ),
        targetEvidence(
          e2eTransportCommit,
          'command',
          'Playwright/E2E transport fixtures use /api/manual-merge/download and /api/manual-merge/upload explicitly while JSON operations use /rpc/**; no _serverFn or /sync bypass remains.',
        ),
        targetEvidence(
          nitroLoopbackCommit,
          'test',
          'Real Nitro loopback proves the same global request policy, request/response bounds, concurrent isolation, and cleanup used by the explicit route adapters.',
        ),
        targetEvidence(
          transportTypecheckCommit,
          'command',
          'bun test packages/web-contract/src/sync.test.ts apps/web/src/lib/server/rpc/sync.test.ts apps/web/src/lib/rpc/sync-client.test.ts apps/web/src/server/manual-merge-upload.server.test.ts; bun run test:web-rpc-loopback; bun tools/check-web-migration-parity.ts',
        ),
        targetEvidence(
          abortCleanupCommit,
          'review',
          'V5 bounds reviewer /root/v5_bounds_review ACCEPTed exact abort identity, bounded streamed consumption, nonblocking reader cancellation, and manual-download cleanup.',
        ),
        targetEvidence(
          e2eFailureScopeCommit,
          'review',
          `Independent V5 transport review ACCEPTed ${e2eTransportCommit}..${e2eFailureScopeCommit} on parity/spec and code-quality/seams.`,
        ),
        targetEvidence(
          v5Checkpoint,
          'review',
          `Independent V5 loopback review ACCEPTed ${nitroLoopbackCommit}..${v5Checkpoint}, including cleanup ${loopbackCleanupCommit}.`,
        ),
      ],
    ),
  ],
});
