import { webContract } from '@ai-usage/web-contract';
import type { PublicErrorFamily } from '@ai-usage/web-contract/errors';
import { type RpcProcedureEntry, rpcProcedureTable } from '@ai-usage/web-contract/rpc-procedure-table';

export const publicHttpMethods = ['GET', 'POST'] as const;
export const demoPolicies = ['forbidden', 'synthetic-only'] as const;
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

type RpcTransport = 'mutation' | 'query';
type ExplicitTransport = 'command' | 'file' | 'sse' | 'upload';

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

/** The policy of one contract procedure, derived from its `rpcProcedure` declaration. */
export interface RpcProcedureRequestPolicy extends SharedRequestPolicy {
  /** The RPC path below `/rpc`, built from the router keys: `/report/revisionManifest`. */
  readonly path: string;
  readonly source: 'rpc-procedure';
  readonly transport: RpcTransport;
}

/** A hand-written policy for an HTTP endpoint outside oRPC: events, commands and file transfer. */
export interface ExplicitHttpRequestPolicy extends SharedRequestPolicy {
  readonly source: 'explicit-http';
  readonly transport: ExplicitTransport;
}

export type RequestPolicy = ExplicitHttpRequestPolicy | RpcProcedureRequestPolicy;

const rpcProcedurePolicyFor = (procedure: RpcProcedureEntry): RpcProcedureRequestPolicy => ({
  applicationErrorFamilies: procedure.errorFamilies,
  // Only a mutation changes state, so only a mutation needs same-origin proof beyond trusted-local.
  csrf: procedure.transport === 'mutation' ? 'required' : 'not-required',
  demo: procedure.demo,
  id: `rpc:${procedure.path.join('.')}`,
  method: procedure.method,
  path: `/${procedure.path.join('/')}`,
  requestSize: procedure.requestSize,
  responseSize: procedure.responseSize,
  source: 'rpc-procedure',
  target: procedure.path.join('.'),
  transport: procedure.transport,
  trustedLocal: 'required',
});

/**
 * One policy per Web contract procedure, derived from the contract (ADR 0076): a procedure is never
 * restated here, so a new one is enforced the moment it is declared.
 */
export const rpcProcedureRequestPolicies: readonly RpcProcedureRequestPolicy[] =
  rpcProcedureTable(webContract).map(rpcProcedurePolicyFor);

/**
 * The endpoints oRPC does not carry keep hand-written policies (ADR 0076): the source-control event
 * stream and command, and the manual-merge upload and download with their byte bounds.
 */
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
  {
    applicationErrorFamilies: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
    csrf: 'required',
    demo: 'forbidden',
    id: 'http:manual-merge-download',
    method: 'POST',
    requestSize: 'none',
    responseSize: 'portable-usage-json',
    source: 'explicit-http',
    target: '/api/manual-merge/download',
    transport: 'file',
    trustedLocal: 'required',
  },
] as const satisfies readonly ExplicitHttpRequestPolicy[];

export const requestPolicyMatrix: readonly RequestPolicy[] = [
  ...rpcProcedureRequestPolicies,
  ...explicitHttpRequestPolicies,
];

const localTrustErrors = [
  'MissingHost',
  'UntrustedHost',
  'CrossOriginRequest',
  'UntrustedForwardedProtocol',
  'InvalidOrigin',
] as const;

export const observableErrorFamiliesFor = (policy: RequestPolicy): readonly string[] => {
  const families = new Set<string>(['MethodNotAllowed', ...policy.applicationErrorFamilies]);
  if (policy.demo === 'forbidden') {
    families.add('ForbiddenDemo');
  }
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
