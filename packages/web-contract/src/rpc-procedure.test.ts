import { describe, expect, test } from 'bun:test';
import { isContractProcedure, oc } from '@orpc/contract';
import { string } from 'valibot';
import { webContract } from './contract';
import { publicErrorMap } from './errors';
import { type RpcContractRouter, type RpcProcedureMeta, rpcProcedure } from './rpc-procedure';
import { RpcProcedureDeclarationError, rpcGetPathsFor, rpcProcedureTable } from './rpc-procedure-table';
import { emptyInputSchema } from './schema-conventions';

const unavailable = { Unavailable: publicErrorMap.Unavailable } as const;
const getQuery = {
  errors: unavailable,
  method: 'GET',
  requestSize: 'none',
  responseSize: 'bounded-json',
  transport: 'query',
} as const;
const queryMeta: RpcProcedureMeta = { requestSize: 'none', responseSize: 'bounded-json', transport: 'query' };

const leafPaths = (node: unknown, path: readonly string[] = []): readonly string[] => {
  if (isContractProcedure(node)) {
    return [path.join('.')];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, [...path, key]));
};

describe('rpcProcedure', () => {
  test('writes the method to the route, the transport and sizes to the metadata, and the families to the error map', () => {
    const procedure = rpcProcedure({ ...getQuery, demo: 'synthetic-only', path: '/example' })
      .input(emptyInputSchema)
      .output(string());

    expect(procedure['~orpc'].route).toEqual({ method: 'GET', path: '/example' });
    expect(procedure['~orpc'].meta).toEqual({
      demo: 'synthetic-only',
      requestSize: 'none',
      responseSize: 'bounded-json',
      transport: 'query',
    });
    expect(Object.keys(procedure['~orpc'].errorMap)).toEqual(['Unavailable']);
  });

  test('refuses an incomplete or contradictory declaration at compile time', () => {
    // `tsc -p packages/web-contract` fails if any of these lines type-checks.
    const refused = [
      // @ts-expect-error -- the request size class is missing.
      rpcProcedure({ errors: unavailable, method: 'GET', responseSize: 'bounded-json', transport: 'query' }),
      // @ts-expect-error -- the response size class is missing.
      rpcProcedure({ errors: unavailable, method: 'GET', requestSize: 'none', transport: 'query' }),
      // @ts-expect-error -- the transport is missing.
      rpcProcedure({ errors: unavailable, method: 'POST', requestSize: 'none', responseSize: 'bounded-json' }),
      // @ts-expect-error -- the method is missing.
      rpcProcedure({ errors: unavailable, requestSize: 'none', responseSize: 'bounded-json', transport: 'query' }),
      // @ts-expect-error -- the error families are missing.
      rpcProcedure({ method: 'GET', requestSize: 'none', responseSize: 'bounded-json', transport: 'query' }),
      // @ts-expect-error -- at least one application error family is declared.
      rpcProcedure({ ...getQuery, errors: {} }),
      // @ts-expect-error -- only public error families cross the boundary.
      rpcProcedure({ ...getQuery, errors: { ...unavailable, NotFound: {} } }),
      // @ts-expect-error -- a GET never mutates.
      rpcProcedure({ ...getQuery, transport: 'mutation' }),
      // @ts-expect-error -- a GET carries no JSON body.
      rpcProcedure({ ...getQuery, requestSize: 'bounded-rpc-json' }),
      // @ts-expect-error -- a POST input is a bounded JSON body, never the URL.
      rpcProcedure({ ...getQuery, method: 'POST', requestSize: 'bounded-url' }),
    ];
    const bareRouter: RpcContractRouter = {
      // @ts-expect-error -- a bare oRPC procedure has no transport declaration, so the contract shape refuses it.
      bare: oc.route({ method: 'GET' }).input(emptyInputSchema).output(string()),
    };

    expect(refused).toHaveLength(10);
    // A value forced past the compiler is still refused before any request: the table derivation throws.
    expect(() => rpcProcedureTable(bareRouter)).toThrow(RpcProcedureDeclarationError);
  });
});

describe('rpcProcedureTable', () => {
  test('derives every Web contract procedure, in router order', () => {
    const table = rpcProcedureTable(webContract);

    expect(table.map(({ path }) => path.join('.'))).toEqual([...leafPaths(webContract)]);
    expect(table.find(({ path }) => path.join('.') === 'workThreads.command')).toEqual({
      demo: 'synthetic-only',
      errorFamilies: ['Forbidden', 'InvalidInput', 'Unavailable'],
      method: 'POST',
      path: ['workThreads', 'command'],
      requestSize: 'bounded-rpc-json',
      responseSize: 'bounded-json',
      transport: 'mutation',
    });
    expect(table.find(({ path }) => path.join('.') === 'report.revisionManifest')).toMatchObject({
      demo: 'forbidden',
      method: 'GET',
      requestSize: 'none',
      transport: 'query',
    });
  });

  test('refuses declarations that bypass rpcProcedure, naming the procedure', () => {
    const withoutMethod: RpcContractRouter = {
      read: oc.$meta<RpcProcedureMeta>(queryMeta).errors(unavailable).input(emptyInputSchema).output(string()),
    };
    const getMutation: RpcContractRouter = {
      write: oc
        .$meta<RpcProcedureMeta>({ ...queryMeta, transport: 'mutation' })
        .route({ method: 'GET' })
        .errors(unavailable)
        .input(emptyInputSchema)
        .output(string()),
    };
    const withoutErrors: RpcContractRouter = {
      read: oc.$meta<RpcProcedureMeta>(queryMeta).route({ method: 'GET' }).input(emptyInputSchema).output(string()),
    };
    const privateFamily: RpcContractRouter = {
      read: oc
        .$meta<RpcProcedureMeta>(queryMeta)
        .route({ method: 'GET' })
        .errors({ NOT_FOUND: {} })
        .input(emptyInputSchema)
        .output(string()),
    };

    expect(() => rpcProcedureTable({ nested: withoutMethod })).toThrow(
      'The Web RPC procedure nested.read must declare GET or POST with rpcProcedure.',
    );
    expect(() => rpcProcedureTable(getMutation)).toThrow('The Web RPC procedure write cannot combine GET, mutation');
    expect(() => rpcProcedureTable(withoutErrors)).toThrow('must declare at least one error family, all public');
    expect(() => rpcProcedureTable(privateFamily)).toThrow('must declare at least one error family, all public');
  });

  test('lists the GET paths the browser needs, sorted', () => {
    expect(rpcGetPathsFor(webContract)).toContain('report/revisionManifest');
    expect(rpcGetPathsFor(webContract)).not.toContain('report/focusedOverview');
    expect([...rpcGetPathsFor(webContract)]).toEqual(
      [...rpcGetPathsFor(webContract)].sort((left, right) => left.localeCompare(right)),
    );
  });
});
