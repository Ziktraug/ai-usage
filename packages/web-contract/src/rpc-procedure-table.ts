import { isContractProcedure } from '@orpc/contract';
import { isPublicErrorFamily, type PublicErrorFamily } from './errors';
import type { RpcContractRouter, RpcRequestSize, RpcResponseSize, RpcTransport } from './rpc-procedure';

/**
 * One contract procedure as the Web boundary enforces it, read from its `rpcProcedure` declaration.
 * Server and generator only: the browser receives the generated GET table, never this walk.
 */
export interface RpcProcedureEntry {
  readonly demo: 'forbidden' | 'synthetic-only';
  readonly errorFamilies: readonly PublicErrorFamily[];
  readonly method: 'GET' | 'POST';
  /** The router keys, which are also the RPC URL segments: `['report', 'revisionManifest']`. */
  readonly path: readonly string[];
  readonly requestSize: RpcRequestSize;
  readonly responseSize: RpcResponseSize;
  readonly transport: RpcTransport;
}

/** A contract leaf whose declaration cannot be enforced; raised when the table is derived, never per request. */
export class RpcProcedureDeclarationError extends Error {
  readonly path: string;

  constructor(path: readonly string[], problem: string) {
    super(`The Web RPC procedure ${path.join('.') || '<root>'} ${problem}.`);
    this.name = 'RpcProcedureDeclarationError';
    this.path = path.join('.');
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const isRequestSize = (value: unknown): value is RpcRequestSize =>
  value === 'bounded-rpc-json' || value === 'bounded-url' || value === 'none';

interface ProcedureDefinition {
  readonly errorMap: unknown;
  readonly meta: unknown;
  readonly route: unknown;
}

const entryFor = (path: readonly string[], definition: ProcedureDefinition): RpcProcedureEntry => {
  const { errorMap, meta, route } = definition;
  const method = isRecord(route) ? route.method : undefined;
  if (method !== 'GET' && method !== 'POST') {
    throw new RpcProcedureDeclarationError(path, 'must declare GET or POST with rpcProcedure');
  }
  if (!isRecord(meta)) {
    throw new RpcProcedureDeclarationError(path, 'has no rpcProcedure metadata');
  }
  const { demo, requestSize, responseSize, transport } = meta;
  if (transport !== 'query' && transport !== 'mutation') {
    throw new RpcProcedureDeclarationError(path, 'must declare a query or mutation transport');
  }
  if (!isRequestSize(requestSize) || responseSize !== 'bounded-json') {
    throw new RpcProcedureDeclarationError(path, 'must declare its request and response size classes');
  }
  const allowedRequestSizes: readonly RpcRequestSize[] =
    method === 'GET' ? ['bounded-url', 'none'] : ['bounded-rpc-json', 'none'];
  if ((method === 'GET' && transport === 'mutation') || !allowedRequestSizes.includes(requestSize)) {
    throw new RpcProcedureDeclarationError(path, `cannot combine ${method}, ${transport} and ${requestSize}`);
  }
  if (demo !== undefined && demo !== 'synthetic-only') {
    throw new RpcProcedureDeclarationError(path, 'declares an unknown demo policy');
  }
  const families = Object.keys(isRecord(errorMap) ? errorMap : {});
  if (families.length === 0 || !families.every(isPublicErrorFamily)) {
    throw new RpcProcedureDeclarationError(path, 'must declare at least one error family, all public');
  }
  return {
    demo: demo ?? 'forbidden',
    errorFamilies: families.filter(isPublicErrorFamily),
    method,
    path,
    requestSize,
    responseSize,
    transport,
  };
};

/** Every procedure of `router`, in router order. Throws on the first incomplete declaration. */
export const rpcProcedureTable = (router: RpcContractRouter): readonly RpcProcedureEntry[] => {
  const entries: RpcProcedureEntry[] = [];
  const visit = (node: unknown, path: readonly string[]): void => {
    if (isContractProcedure(node)) {
      entries.push(entryFor(path, node['~orpc']));
      return;
    }
    if (!isRecord(node)) {
      throw new RpcProcedureDeclarationError(path, 'is neither a procedure nor a router');
    }
    for (const [key, child] of Object.entries(node)) {
      visit(child, [...path, key]);
    }
  };
  visit(router, []);
  return entries;
};

/** The paths, joined with `/`, of the procedures the browser must call with GET; sorted. */
export const rpcGetPathsFor = (router: RpcContractRouter): readonly string[] =>
  rpcProcedureTable(router)
    .filter(({ method }) => method === 'GET')
    .map(({ path }) => path.join('/'))
    .sort((left, right) => left.localeCompare(right));
