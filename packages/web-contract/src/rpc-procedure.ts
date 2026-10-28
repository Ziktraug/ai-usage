import {
  type AnySchema,
  type ContractProcedure,
  type ErrorMap,
  type ErrorMapItem,
  type HTTPPath,
  oc,
} from '@orpc/contract';
import type { PublicErrorFamily } from './errors';

/**
 * How one Web RPC procedure travels, declared once on the procedure (ADR 0076, "Derive once").
 *
 * `rpcProcedure` writes the HTTP method to the contract route, the transport and size classes to the
 * contract metadata, and the application error families to the error map. The Web request policy,
 * its path table, the in-process SSR client and the browser's GET table are all derived from these
 * declarations (`rpc-procedure-table.ts`); none of them restates a procedure.
 */
export type RpcTransport = 'mutation' | 'query';
export type RpcRequestSize = 'bounded-rpc-json' | 'bounded-url' | 'none';
export type RpcResponseSize = 'bounded-json';
/** A procedure the isolated demo may serve, because it answers from synthetic data only. */
export type RpcDemoPolicy = 'synthetic-only';

export interface RpcProcedureMeta {
  /** Absent means the demo refuses the procedure; only synthetic data may be served there. */
  readonly demo?: RpcDemoPolicy;
  readonly requestSize: RpcRequestSize;
  readonly responseSize: RpcResponseSize;
  readonly transport: RpcTransport;
}

/** Application error families a procedure may answer with, keyed by public family only. */
export type RpcErrorMap = { readonly [Family in PublicErrorFamily]?: ErrorMapItem<AnySchema> };

/**
 * A GET carries its input in the URL and never changes state; a POST carries a bounded JSON body or
 * nothing. A mutation is always a POST, so CSRF protection (derived from the transport) always
 * applies to it.
 */
type RpcMethodDeclaration =
  | {
      readonly method: 'GET';
      readonly requestSize: Extract<RpcRequestSize, 'bounded-url' | 'none'>;
      readonly transport: 'query';
    }
  | {
      readonly method: 'POST';
      readonly requestSize: Extract<RpcRequestSize, 'bounded-rpc-json' | 'none'>;
      readonly transport: RpcTransport;
    };

/** Every field but `demo` is required: an incomplete declaration does not type-check. */
export type RpcProcedureDeclaration<TErrors extends RpcErrorMap> = RpcMethodDeclaration & {
  readonly demo?: RpcDemoPolicy;
  readonly errors: TErrors;
  /** The contract's descriptive HTTP path. RPC addresses a procedure by its router keys, never by this. */
  readonly path?: HTTPPath;
  readonly responseSize: RpcResponseSize;
};

/**
 * Rejects an empty error map and any family outside the public vocabulary: the call then needs a
 * second argument it cannot supply, and the compiler names the problem.
 */
type RpcErrorsCheck<TErrors> = [keyof TErrors] extends [never]
  ? [problem: 'declare at least one application error family']
  : [Exclude<keyof TErrors, PublicErrorFamily>] extends [never]
    ? []
    : [problem: 'declare public error families only'];

/** Starts a Web RPC procedure from its complete transport declaration; chain `.input()` and `.output()`. */
export const rpcProcedure = <const TErrors extends RpcErrorMap>(
  declaration: RpcProcedureDeclaration<TErrors>,
  ..._check: RpcErrorsCheck<TErrors>
) => {
  const { demo, errors, method, path, requestSize, responseSize, transport } = declaration;
  const meta: RpcProcedureMeta =
    demo === undefined ? { requestSize, responseSize, transport } : { demo, requestSize, responseSize, transport };
  return oc
    .$meta<RpcProcedureMeta>(meta)
    .route(path === undefined ? { method } : { method, path })
    .errors(errors);
};

/** A procedure declared with `rpcProcedure`. A bare `oc` procedure lacks the metadata and does not match. */
export type RpcContractProcedure = ContractProcedure<AnySchema, AnySchema, ErrorMap, RpcProcedureMeta>;

/** The shape every Web contract router satisfies, checked on the root contract. */
export interface RpcContractRouter {
  readonly [key: string]: RpcContractProcedure | RpcContractRouter;
}
