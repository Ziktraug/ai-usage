import type { PublicErrorFamily } from '@ai-usage/web-contract/errors';

export const publicHttpMethods = ['GET', 'POST'] as const;
export const demoPolicies = ['forbidden'] as const;
export const trustedLocalPolicies = ['required'] as const;
export const csrfPolicies = ['not-required', 'required'] as const;
export const requestSizeClasses = [
  'none',
  'bounded-url',
  'bounded-rpc-json',
  'source-control-command-json-4kib',
  'portable-usage-json',
  'portable-usage-upload',
] as const;
export const responseSizeClasses = ['bounded-json', 'bounded-sse-events', 'portable-usage-json'] as const;

export type PublicHttpMethod = (typeof publicHttpMethods)[number];
export type DemoPolicy = (typeof demoPolicies)[number];
export type TrustedLocalPolicy = (typeof trustedLocalPolicies)[number];
export type CsrfPolicy = (typeof csrfPolicies)[number];
export type RequestSizeClass = (typeof requestSizeClasses)[number];
export type ResponseSizeClass = (typeof responseSizeClasses)[number];

export const requestBoundaryErrorFamilies = [
  'CrossOriginRequest',
  'CsrfRejected',
  'ForbiddenDemo',
  'InvalidOrigin',
  'MethodNotAllowed',
  'MissingHost',
  'RequestTooLarge',
  'ResponseTooLarge',
  'UntrustedForwardedProtocol',
  'UntrustedHost',
] as const;

export type RequestBoundaryErrorFamily = (typeof requestBoundaryErrorFamilies)[number];

type OperationTransport = 'file' | 'mutation' | 'query';
type ExplicitTransport = 'command' | 'sse' | 'upload';

interface SharedRequestPolicy {
  readonly applicationErrorFamilies: readonly PublicErrorFamily[];
  readonly csrf: CsrfPolicy;
  readonly demo: DemoPolicy;
  readonly id: string;
  readonly method: PublicHttpMethod;
  readonly requestSize: RequestSizeClass;
  readonly responseSize: ResponseSizeClass;
  readonly target: string;
  readonly trustedLocal: TrustedLocalPolicy;
}

export interface OperationRequestPolicy extends SharedRequestPolicy {
  readonly operation: string;
  readonly source: 'operation';
  readonly transport: OperationTransport;
}

export interface ExplicitHttpRequestPolicy extends SharedRequestPolicy {
  readonly source: 'explicit-http';
  readonly transport: ExplicitTransport;
}

export type RequestPolicy = ExplicitHttpRequestPolicy | OperationRequestPolicy;

type OperationPolicyInput = Omit<OperationRequestPolicy, 'csrf' | 'demo' | 'id' | 'source' | 'trustedLocal'>;

const defineOperationPolicy = (input: OperationPolicyInput): OperationRequestPolicy => ({
  ...input,
  csrf: input.transport === 'mutation' || input.transport === 'file' ? 'required' : 'not-required',
  demo: 'forbidden',
  id: `operation:${input.operation}`,
  source: 'operation',
  trustedLocal: 'required',
});

const reportReadErrors = ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'] as const;
const exactReportErrors = ['ForbiddenDemo', 'InvalidInput', 'RevisionExpired', 'IncompatibleStore'] as const;
const skillsErrors = ['ForbiddenDemo', 'InvalidInput', 'SkillsConflict', 'Unavailable'] as const;

export const operationRequestPolicies = [
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Unavailable'],
    method: 'GET',
    operation: 'getMemoryProposalReviews',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'memory.proposalReviews',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'searchMemory',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'memory.search',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'applyMemoryProposalReviewAction',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'memory.applyProposalReviewAction',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Unavailable'],
    method: 'GET',
    operation: 'getProjectResolutionReviews',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'projects.resolutionReviews',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'applyProjectResolutionAction',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'projects.applyResolutionAction',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Unavailable'],
    method: 'GET',
    operation: 'getReplicationStatus',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'replication.status',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: reportReadErrors,
    method: 'GET',
    operation: 'getReportRevisionManifest',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'report.revisionManifest',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: reportReadErrors,
    method: 'GET',
    operation: 'getReportRevisionBootstrap',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'report.revisionBootstrap',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: exactReportErrors,
    method: 'POST',
    operation: 'getFocusedReportSupport',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'report.focusedSupport',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: exactReportErrors,
    method: 'POST',
    operation: 'getFocusedReportOverview',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'report.focusedOverview',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: exactReportErrors,
    method: 'POST',
    operation: 'getFocusedReportBreakdown',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'report.focusedBreakdown',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Unavailable'],
    method: 'GET',
    operation: 'getCampaignLabelOverrides',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'campaign.labelOverrides',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Conflict'],
    method: 'POST',
    operation: 'setCampaignLabelOverride',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'campaign.setLabelOverride',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'EngineUnavailable', 'Conflict'],
    method: 'POST',
    operation: 'saveProjectGroups',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'projectGroup.save',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo'],
    method: 'GET',
    operation: 'getReportPerfEnabled',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'runtime.reportPerfEnabled or request context',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'getProviderQuotaHistory',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'quota.history',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: exactReportErrors,
    method: 'POST',
    operation: 'getReportSessionPage',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'session.page',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: exactReportErrors,
    method: 'POST',
    operation: 'getReportSessionCampaignChildren',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'session.campaignChildren',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: exactReportErrors,
    method: 'POST',
    operation: 'getReportSessionNeighbors',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'session.neighbors',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'getReportSessionDetail',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'session.detail',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'resolveReportSessionVcs',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'session.vcs',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'GET',
    operation: 'getSkillManagementSnapshot',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'skills.snapshot',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'refreshSkillManagementSnapshot',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'skills.refreshSnapshot',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'GET',
    operation: 'getKnownSkillProjectPaths',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'skills.knownProjectPaths',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'saveSkillManagementConfig',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'skills.saveConfig',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'toggleManagedSkill',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'skills.toggleProjection',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'reconcileManagedSkill',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'skills.reconcileOne',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'reconcileAllManagedSkills',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'skills.reconcileAll',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'GET',
    operation: 'previewReconcileAllManagedSkills',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'skills.previewReconcileAll (query only while side-effect-free)',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'createManagedSkillTargetDirectory',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'skills.createTargetDirectory',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'saveManagedSkillMarkdown',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'skills.saveManagedMarkdown',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'GET',
    operation: 'getSkillProjectInventories',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'skills.projectInventories',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'GET',
    operation: 'getProjectSkillMarkdown',
    requestSize: 'bounded-url',
    responseSize: 'bounded-json',
    target: 'skills.projectMarkdown',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: skillsErrors,
    method: 'POST',
    operation: 'getManagedSkillMarkdown',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'skills.managedMarkdown',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: reportReadErrors,
    method: 'GET',
    operation: 'getSyncFleet',
    requestSize: 'none',
    responseSize: 'bounded-json',
    target: 'sync.fleet',
    transport: 'query',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'EngineUnavailable'],
    method: 'POST',
    operation: 'setMachineLabel',
    requestSize: 'bounded-rpc-json',
    responseSize: 'bounded-json',
    target: 'sync.setMachineLabel',
    transport: 'mutation',
  }),
  defineOperationPolicy({
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    method: 'POST',
    operation: 'exportManualMergeBundle',
    requestSize: 'none',
    responseSize: 'portable-usage-json',
    target: 'explicit download route with optional bounded oRPC metadata',
    transport: 'file',
  }),
] as const satisfies readonly OperationRequestPolicy[];

export const explicitHttpRequestPolicies = [
  {
    applicationErrorFamilies: ['ForbiddenDemo', 'Unavailable', 'IncompatibleStore'],
    csrf: 'not-required',
    demo: 'forbidden',
    id: 'http:source-control-events',
    method: 'GET',
    requestSize: 'none',
    responseSize: 'bounded-sse-events',
    source: 'explicit-http',
    target: '/api/source-control',
    transport: 'sse',
    trustedLocal: 'required',
  },
  {
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'EngineUnavailable', 'Conflict'],
    csrf: 'required',
    demo: 'forbidden',
    id: 'http:source-control-command',
    method: 'POST',
    requestSize: 'source-control-command-json-4kib',
    responseSize: 'bounded-json',
    source: 'explicit-http',
    target: '/api/source-control/command',
    transport: 'command',
    trustedLocal: 'required',
  },
  {
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'EngineUnavailable', 'Conflict'],
    csrf: 'required',
    demo: 'forbidden',
    id: 'http:manual-merge-upload',
    method: 'POST',
    requestSize: 'portable-usage-upload',
    responseSize: 'bounded-json',
    source: 'explicit-http',
    target: '/api/manual-merge/upload',
    transport: 'upload',
    trustedLocal: 'required',
  },
] as const satisfies readonly ExplicitHttpRequestPolicy[];

export const requestPolicyMatrix = [...operationRequestPolicies, ...explicitHttpRequestPolicies] as const;

const localTrustErrors = [
  'MissingHost',
  'UntrustedHost',
  'CrossOriginRequest',
  'UntrustedForwardedProtocol',
  'InvalidOrigin',
] as const;

export const observableErrorFamiliesFor = (policy: RequestPolicy): readonly string[] => {
  const families = new Set<string>(['MethodNotAllowed', 'ForbiddenDemo', ...policy.applicationErrorFamilies]);
  if (policy.trustedLocal === 'required') {
    for (const family of localTrustErrors) {
      families.add(family);
    }
  }
  if (policy.csrf === 'required') {
    families.add('CsrfRejected');
  }
  if (policy.requestSize !== 'none') {
    families.add('RequestTooLarge');
  }
  families.add('ResponseTooLarge');
  return [...families].sort((left, right) => left.localeCompare(right));
};
