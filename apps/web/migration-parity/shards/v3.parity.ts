import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'V3' as const;
const legacyWrapper = 'apps/web/src/server/skills.ts';
const skillsVerticalCommit = 'afbc97d311920be78631afdcef016bc164864ea6';
const skillsBoundaryCommit = 'e3e4328525c1f8506f3e174b4f06c8cdc6e6c400';
const skillsSchemaCommit = 'f7b3f4568dffbce796942ed6482b6dff5392ed7f';
const transportConvergenceCommit = '781901ad09051e457fea6a5db05173a19df1dae1';
const transportRetirementCommit = 'f6bde5a05faad45560c969449426ddc74c0de4da';
const lazyTransportCommit = 'b93b70c9597c4caa63c865b014d23333cf71e8ef';
const skillsClosureCommit = '9804135cf0d2125febf73a9e3f37242fc4b6d11b';
const cancellationCommit = '3dcf2bb647f0491b81a7ab1c6828c378f07ab4eb';
const e2eTransportCommit = '8b6164f5551dbaf088b3271ccc013d3c84f9f2e3';
const scopedFailureCommit = 'b0a6518d0905c7e0c34405607646393ec7391cfb';
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

interface SkillsTarget {
  method: 'GET' | 'POST';
  outputSchema: string;
  procedure: string;
  route: string;
}

const completeRecord = (record: ParityRecord, target: SkillsTarget): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    targetEvidence(
      skillsVerticalCommit,
      'source',
      `packages/web-contract/src/skills.ts#skillsContract.${target.procedure} (${target.method} ${target.route}, output ${target.outputSchema}); apps/web/src/lib/server/rpc/skills.ts#createSkillsRouter; apps/web/src/lib/rpc/skills-client.ts#createSkillsClient`,
    ),
    targetEvidence(
      skillsSchemaCommit,
      'test',
      'packages/web-contract/src/skills.test.ts; apps/web/src/lib/server/rpc/skills.test.ts; apps/web/src/lib/rpc/skills-client.test.ts',
    ),
    targetEvidence(
      transportConvergenceCommit,
      'source',
      'apps/web/src/lib/server/rpc/router.ts; apps/web/src/lib/server/rpc/handler.server.ts; apps/web/src/lib/rpc/client.ts; Solid callers consume the contract-first oRPC adapter.',
    ),
    targetEvidence(
      transportRetirementCommit,
      'source',
      'apps/web/src/server/skills.ts and every production createServerFn wrapper are retired after oRPC caller cutover.',
    ),
    targetEvidence(
      lazyTransportCommit,
      'source',
      'apps/web/src/lib/rpc/solid-client.ts lazy-loads the browser oRPC transport without crossing the server boundary.',
    ),
    targetEvidence(
      skillsClosureCommit,
      'source',
      'apps/web/src/web-query-options.ts keeps the Skills RPC transport outside the initial report closure.',
    ),
    targetEvidence(
      cancellationCommit,
      'test',
      'Skills context, capability, and browser adapter tests prove AbortSignal reaches awaited work and preserves exact cancellation identity.',
    ),
    targetEvidence(
      e2eTransportCommit,
      'test',
      'apps/web/e2e/rpc-test-transport.ts and migrated Skills/browser/demo/production suites exercise /rpc/** instead of _serverFn.',
    ),
    targetEvidence(
      scopedFailureCommit,
      'test',
      'apps/web/src/rpc-test-transport.test.ts scopes the expected Skills demo fixture failure to one exact RPC path, status, and marker header.',
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
      'V5 integrated contract/server/client tests and Web transport typecheck passed at this checkpoint.',
    ),
    targetEvidence(
      skillsBoundaryCommit,
      'review',
      'Original V3 reviewer /root/v0_impl ACCEPT recorded in plans/068-execution-state.md for d465e65/9545bb0/4e87ebe; integrated equivalents are afbc97d/e3e4328/f7b3f45. V5 convergence review accepted wrapper retirement.',
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
  ],
  status: 'complete',
});

const operation = (
  name: string,
  inputParser: string,
  target: SkillsTarget,
  descriptor: Omit<OperationDescriptor, 'inputParser' | 'outputParser'>,
) =>
  completeRecord(
    currentRecord(owner, {
      currentOwner: legacyWrapper,
      evidence: [
        { kind: 'source', reference: `${legacyWrapper} exported ${name}` },
        { kind: 'test', reference: 'apps/web/src/server/skills.server.test.ts; apps/web/e2e/skills.spec.ts' },
      ],
      id: `op:${name}`,
      kind: 'operation',
      operation: {
        ...descriptor,
        inputParser,
        outputParser: 'TanStack serializer over Skills application results; add a runtime output schema in V3',
      },
    }),
    target,
  );

const skillsErrors = ['ForbiddenDemo', 'InvalidInput', 'SkillsConflict', 'Unavailable'] as const;
const skillsTargets = {
  createTargetDirectory: {
    method: 'POST',
    outputSchema: 'skillManagementSnapshotSchema',
    procedure: 'createTargetDirectory',
    route: '/rpc/skills/targets',
  },
  knownProjectPaths: {
    method: 'GET',
    outputSchema: 'knownSkillProjectPathsSchema',
    procedure: 'knownProjectPaths',
    route: '/rpc/skills/known-paths',
  },
  managedMarkdown: {
    method: 'POST',
    outputSchema: 'skillMarkdownDocumentSchema',
    procedure: 'managedMarkdown',
    route: '/rpc/skills/markdown/read',
  },
  previewReconcileAll: {
    method: 'GET',
    outputSchema: 'skillReconcileResultSchema',
    procedure: 'previewReconcileAll',
    route: '/rpc/skills/reconcile/preview',
  },
  projectInventories: {
    method: 'GET',
    outputSchema: 'projectSkillInventoriesSchema',
    procedure: 'projectInventories',
    route: '/rpc/skills/inventories',
  },
  projectMarkdown: {
    method: 'GET',
    outputSchema: 'projectSkillMarkdownDocumentSchema',
    procedure: 'projectMarkdown',
    route: '/rpc/skills/project-markdown',
  },
  reconcileAll: {
    method: 'POST',
    outputSchema: 'skillReconcileResultSchema',
    procedure: 'reconcileAll',
    route: '/rpc/skills/reconcile',
  },
  reconcileOne: {
    method: 'POST',
    outputSchema: 'skillReconcileResultSchema',
    procedure: 'reconcileOne',
    route: '/rpc/skills/reconcile/:skillName',
  },
  refreshSnapshot: {
    method: 'POST',
    outputSchema: 'skillManagementSnapshotSchema',
    procedure: 'refreshSnapshot',
    route: '/rpc/skills/refresh',
  },
  saveConfig: {
    method: 'POST',
    outputSchema: 'skillManagementSnapshotSchema',
    procedure: 'saveConfig',
    route: '/rpc/skills/config',
  },
  saveManagedMarkdown: {
    method: 'POST',
    outputSchema: 'skillMarkdownSaveResultSchema',
    procedure: 'saveManagedMarkdown',
    route: '/rpc/skills/markdown',
  },
  snapshot: {
    method: 'GET',
    outputSchema: 'skillManagementSnapshotSchema',
    procedure: 'snapshot',
    route: '/rpc/skills',
  },
  toggleProjection: {
    method: 'POST',
    outputSchema: 'skillReconcileResultSchema',
    procedure: 'toggleProjection',
    route: '/rpc/skills/toggle',
  },
} as const satisfies Record<string, SkillsTarget>;

export default defineParityShard({
  owner,
  records: [
    operation('getSkillManagementSnapshot', 'none', skillsTargets.snapshot, {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readSnapshot',
      publicErrors: skillsErrors,
      target: 'skills.snapshot',
      transport: 'query',
    }),
    operation('refreshSkillManagementSnapshot', 'none', skillsTargets.refreshSnapshot, {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#refreshSnapshot',
      publicErrors: skillsErrors,
      target: 'skills.refreshSnapshot',
      transport: 'mutation',
    }),
    operation('getKnownSkillProjectPaths', 'none', skillsTargets.knownProjectPaths, {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readKnownProjectPaths',
      publicErrors: skillsErrors,
      target: 'skills.knownProjectPaths',
      transport: 'query',
    }),
    operation('saveSkillManagementConfig', 'parseSkillConfigInput', skillsTargets.saveConfig, {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#saveConfig',
      publicErrors: skillsErrors,
      target: 'skills.saveConfig',
      transport: 'mutation',
    }),
    operation('toggleManagedSkill', 'parseSkillToggleInputForClient', skillsTargets.toggleProjection, {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#toggleSkill',
      publicErrors: skillsErrors,
      target: 'skills.toggleProjection',
      transport: 'mutation',
    }),
    operation('reconcileManagedSkill', 'skillNameInputForClient', skillsTargets.reconcileOne, {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#reconcileSkill',
      publicErrors: skillsErrors,
      target: 'skills.reconcileOne',
      transport: 'mutation',
    }),
    operation('reconcileAllManagedSkills', 'none', skillsTargets.reconcileAll, {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#reconcileAll',
      publicErrors: skillsErrors,
      target: 'skills.reconcileAll',
      transport: 'mutation',
    }),
    operation('previewReconcileAllManagedSkills', 'none', skillsTargets.previewReconcileAll, {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#previewReconcileAll',
      publicErrors: skillsErrors,
      target: 'skills.previewReconcileAll (query only while side-effect-free)',
      transport: 'query',
    }),
    operation(
      'createManagedSkillTargetDirectory',
      'parseSkillTargetDirectoryInputForClient',
      skillsTargets.createTargetDirectory,
      {
        currentMethod: 'POST',
        implementationOwner: 'SkillsServerAdapter#createTargetDirectory',
        publicErrors: skillsErrors,
        target: 'skills.createTargetDirectory',
        transport: 'mutation',
      },
    ),
    operation('getSkillProjectInventories', 'none', skillsTargets.projectInventories, {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readProjectInventories',
      publicErrors: skillsErrors,
      target: 'skills.projectInventories',
      transport: 'query',
    }),
    operation('getProjectSkillMarkdown', 'parseProjectSkillMarkdownInput', skillsTargets.projectMarkdown, {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readProjectMarkdown',
      publicErrors: skillsErrors,
      target: 'skills.projectMarkdown',
      transport: 'query',
    }),
    operation('getManagedSkillMarkdown', 'skillNameInputForClient', skillsTargets.managedMarkdown, {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#readMarkdown',
      publicErrors: skillsErrors,
      target: 'skills.managedMarkdown',
      transport: 'query',
    }),
    operation('saveManagedSkillMarkdown', 'parseSkillMarkdownWriteInputForClient', skillsTargets.saveManagedMarkdown, {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#saveMarkdown',
      publicErrors: skillsErrors,
      target: 'skills.saveManagedMarkdown',
      transport: 'mutation',
    }),
  ],
});
