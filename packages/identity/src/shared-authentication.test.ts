import { describe, expect, test } from 'bun:test';
import type { DBAdapter, DBAdapterInstance } from '@better-auth/core/db/adapter';
import {
  createSchemaCheck,
  registerSchemaCheck,
  runtimeSchemaCheckFor,
  type SchemaFinding,
  schemaCheckFor,
} from '@better-auth/core/db/internal';
import type { IdentityServiceResult } from './index';
import { AuthenticationAdapterError, carrySchemaCheck } from './internal/adapter-schema-check';
import { createSharedAuthenticationService, type SharedAuthenticationIdentityStore } from './shared-authentication';

const baseUrl = 'https://platform.example.invalid';
const unavailable = <Value>(
  operation: 'audit-authentication' | 'link-authentication-identity' | 'unlink-authentication-identity',
): IdentityServiceResult<Value> => ({ error: { code: 'identity-unavailable', operation }, kind: 'error' });

const identityStore: SharedAuthenticationIdentityStore = {
  canUnlinkAuthenticationIdentity: () => Promise.resolve(false),
  hasRevokedAuthenticationIdentity: () => Promise.resolve({ kind: 'success', value: false }),
  recordAuthenticationEvent: () => Promise.resolve(unavailable('audit-authentication')),
  resolveAuthenticationIdentity: () => Promise.resolve(null),
  revokeAuthenticationIdentity: () => Promise.resolve(unavailable('unlink-authentication-identity')),
  synchronizeAuthenticationPrincipal: () => Promise.resolve(unavailable('link-authentication-identity')),
};

const unexpectedCall = (operation: string) => (): Promise<never> =>
  Promise.reject(new Error(`Unexpected adapter call: ${operation}.`));

const createStubAdapter = (id: string): DBAdapter => {
  const adapter: DBAdapter = {
    consumeOne: unexpectedCall('consumeOne'),
    count: unexpectedCall('count'),
    create: unexpectedCall('create'),
    delete: unexpectedCall('delete'),
    deleteMany: unexpectedCall('deleteMany'),
    findMany: unexpectedCall('findMany'),
    findOne: unexpectedCall('findOne'),
    id,
    incrementOne: unexpectedCall('incrementOne'),
    transaction: (run) => run(adapter),
    update: unexpectedCall('update'),
    updateMany: unexpectedCall('updateMany'),
  };
  return adapter;
};

/**
 * An adapter whose registered schema check reports `findings`, the way the
 * Drizzle adapter registers its own check on the instance it returns.
 */
const createCheckedDatabase =
  (findings: readonly SchemaFinding[], calls: string[]): DBAdapterInstance =>
  () => {
    const adapter = createStubAdapter('checked-stub');
    registerSchemaCheck(
      adapter,
      createSchemaCheck(() => {
        calls.push('schema-check');
        return [...findings];
      }, 'drizzle'),
      { runtimeEnabled: true },
    );
    return adapter;
  };

const createServiceWithDatabase = (database: DBAdapterInstance) =>
  createSharedAuthenticationService({
    baseUrl,
    bootstrapFirstOwner: false,
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
    database,
    identityStore,
    secrets: [{ value: 'a'.repeat(32), version: 1 }],
  });

const createService = (findings: readonly SchemaFinding[], calls: string[]) =>
  createServiceWithDatabase(createCheckedDatabase(findings, calls));

describe('shared authentication schema validation', () => {
  test('carries the adapter schema check through the identity wrappers and refuses requests on a mismatch', async () => {
    const calls: string[] = [];
    const service = createService(
      [{ column: 'issuer', kind: 'unexpected-required-column', table: 'authentication_provider_accounts' }],
      calls,
    );

    await expect(service.resolveSession(new Headers())).resolves.toEqual({ kind: 'unavailable' });
    // Better Auth refuses the route before dispatch; the typed mismatch
    // reaches the HTTP boundary instead of being answered as if served.
    await expect(
      service.handle(
        new Request(`${baseUrl}/api/auth/sign-out`, {
          headers: { 'content-type': 'application/json', origin: baseUrl },
          method: 'POST',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    expect(calls).toContain('schema-check');
  });

  test('serves requests when the adapter schema check reports no finding', async () => {
    const calls: string[] = [];
    const service = createService([], calls);

    await expect(service.resolveSession(new Headers())).resolves.toEqual({ kind: 'anonymous' });
    expect(calls).toEqual(['schema-check']);
  });

  test('refuses to build the service around an adapter that registers no schema check', () => {
    // Better Auth would skip validation with a log line this service disables;
    // the composition fails instead, before any request can be served.
    expect(() => createServiceWithDatabase(() => createStubAdapter('unchecked-stub'))).toThrow(
      expect.objectContaining({
        code: 'schema-check-missing',
        name: 'AuthenticationAdapterError',
        operation: 'compose-database-adapter',
      }),
    );
  });
});

describe('adapter schema-check carry', () => {
  test('registers the inner check on the wrapper with the runtime policy of the options', () => {
    const inner = createStubAdapter('inner');
    const check = createSchemaCheck(() => [], 'drizzle');
    registerSchemaCheck(inner, check, { runtimeEnabled: true });

    const enforced = carrySchemaCheck(inner, createStubAdapter('enforced'), {});
    expect(schemaCheckFor(enforced)).toBe(check);
    expect(runtimeSchemaCheckFor(enforced)).toBe(check);

    const disabled = carrySchemaCheck(inner, createStubAdapter('disabled'), {
      advanced: { database: { validateSchema: false } },
    });
    expect(schemaCheckFor(disabled)).toBe(check);
    expect(runtimeSchemaCheckFor(disabled)).toBeUndefined();
  });

  test('fails with a typed error when validation is on and the inner adapter has no check', () => {
    const wrap = () =>
      carrySchemaCheck(createStubAdapter('inner'), createStubAdapter('wrapped'), {
        advanced: { database: { validateSchema: true } },
      });

    expect(wrap).toThrow(AuthenticationAdapterError);
    expect(wrap).toThrow(
      expect.objectContaining({ code: 'schema-check-missing', operation: 'compose-database-adapter' }),
    );
  });

  test('passes an unchecked adapter through only when validation is explicitly disabled', () => {
    const wrapped = createStubAdapter('wrapped');

    expect(
      carrySchemaCheck(createStubAdapter('inner'), wrapped, { advanced: { database: { validateSchema: false } } }),
    ).toBe(wrapped);
    expect(schemaCheckFor(wrapped)).toBeUndefined();
  });
});
