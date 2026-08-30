import type { IdentityServiceResult, SharedAuthenticationPrincipal } from '@ai-usage/identity';
import type {
  SharedAuthenticationIdentityStore,
  SynchronizeAuthenticationPrincipalInput,
} from '@ai-usage/identity/better-auth';
import {
  createAuthenticationIdentityId,
  createPersonId,
  createSpaceId,
  parseAuthenticationIdentityId,
  parseIdentityText,
  parseInstant,
  parsePersonId,
} from '@ai-usage/platform-core/identity';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { PlatformAuthenticationStore } from '../authentication';
import { betterAuthSchema } from './schema-definition';

const BOOTSTRAP_LOCK_NAMESPACE = 1_095_325_523;
const BOOTSTRAP_LOCK_ID = 1_843_065_441;
const githubProvider = 'github' as const;

interface AuthenticationPrincipalRow extends QueryResultRow {
  readonly id: unknown;
  readonly name: unknown;
}

interface ProviderAccountRow extends QueryResultRow {
  readonly account_id: unknown;
  readonly id: unknown;
}

interface IdentityRow extends QueryResultRow {
  readonly id: unknown;
  readonly person_id: unknown;
  readonly provider_subject: unknown;
  readonly revoked_at: unknown;
}

interface ResolvedIdentityRow extends QueryResultRow {
  readonly id: unknown;
  readonly person_id: unknown;
  readonly provider: unknown;
}

interface PersonRow extends QueryResultRow {
  readonly personal_space_id: unknown;
  readonly status: unknown;
}

interface CountRow extends QueryResultRow {
  readonly count: unknown;
}

const identityFailure = <Value>(
  operation:
    | 'audit-authentication'
    | 'bootstrap-first-owner'
    | 'link-authentication-identity'
    | 'unlink-authentication-identity',
  code: 'identity-conflict' | 'identity-denied' | 'identity-invalid-input' | 'identity-unavailable',
): IdentityServiceResult<Value> => ({ error: { code, operation }, kind: 'error' });

const principal = (identityId: unknown, personId: unknown): SharedAuthenticationPrincipal => {
  const parsedPersonId = parsePersonId(personId);
  return {
    authenticationIdentityId: parseAuthenticationIdentityId(identityId),
    authorizationPrincipal: { kind: 'person', personId: parsedPersonId },
    personId: parsedPersonId,
    provider: githubProvider,
  };
};

const withTransaction = async <Value>(pool: Pool, run: (client: PoolClient) => Promise<Value>): Promise<Value> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const recordIdentityEvent = async (
  client: PoolClient,
  input: {
    readonly eventType: string;
    readonly identityId: string;
    readonly personId: string;
    readonly recordedAt: string;
  },
): Promise<void> => {
  const person = await client.query<PersonRow>('SELECT personal_space_id, status FROM people WHERE id = $1', [
    input.personId,
  ]);
  const row = person.rows[0];
  if (row?.status !== 'active') {
    throw new Error('Authentication Person is unavailable.');
  }
  await client.query(
    `INSERT INTO identity_events
       (id, space_id, event_type, subject_type, subject_id, recorded_at, details)
     VALUES ($1, $2, $3, 'authentication-identity', $4, $5, '{}'::JSONB)`,
    [crypto.randomUUID(), row.personal_space_id, input.eventType, input.identityId, input.recordedAt],
  );
};

const loadProviderAccounts = async (client: PoolClient, authenticationPrincipalId: string) => {
  const result = await client.query<ProviderAccountRow>(
    `SELECT id, account_id
     FROM authentication_provider_accounts
     WHERE user_id = $1 AND provider_id = 'github' AND issuer = 'local:oauth:github'
     ORDER BY created_at ASC, id ASC`,
    [authenticationPrincipalId],
  );
  return result.rows.map((row) => {
    if (typeof row.id !== 'string' || typeof row.account_id !== 'string') {
      throw new Error('Authentication provider account is invalid.');
    }
    return { accountId: row.id, providerSubject: parseIdentityText(row.account_id, 'providerSubject') };
  });
};

const loadIdentities = async (
  client: PoolClient,
  authenticationPrincipalId: string,
): Promise<readonly IdentityRow[]> => {
  const result = await client.query<IdentityRow>(
    `SELECT id, person_id, provider_subject, revoked_at
     FROM authentication_identities
     WHERE authentication_principal_id = $1 AND provider = 'github'
     ORDER BY linked_at ASC, id ASC`,
    [authenticationPrincipalId],
  );
  return result.rows;
};

const createIdentity = async (
  client: PoolClient,
  input: {
    readonly accountId: string;
    readonly authenticationPrincipalId: string;
    readonly linkedAt: string;
    readonly personId: string;
    readonly providerSubject: string;
  },
) => {
  const identityId = createAuthenticationIdentityId();
  await client.query(
    `INSERT INTO authentication_identities
       (id, person_id, authentication_principal_id, authentication_provider_account_id,
        provider, provider_subject, linked_at)
     VALUES ($1, $2, $3, $4, 'github', $5, $6)`,
    [
      identityId,
      input.personId,
      input.authenticationPrincipalId,
      input.accountId,
      input.providerSubject,
      input.linkedAt,
    ],
  );
  return identityId;
};

const synchronizeInTransaction = async (
  client: PoolClient,
  input: SynchronizeAuthenticationPrincipalInput,
): Promise<IdentityServiceResult<SharedAuthenticationPrincipal>> => {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOTSTRAP_LOCK_NAMESPACE, BOOTSTRAP_LOCK_ID]);
  const principalResult = await client.query<AuthenticationPrincipalRow>(
    'SELECT id, name FROM authentication_principals WHERE id = $1',
    [input.authenticationPrincipalId],
  );
  const authenticationPrincipal = principalResult.rows[0];
  if (!(authenticationPrincipal && typeof authenticationPrincipal.id === 'string')) {
    return identityFailure('link-authentication-identity', 'identity-denied');
  }
  const accounts = await loadProviderAccounts(client, input.authenticationPrincipalId);
  if (accounts.length === 0) {
    return identityFailure('link-authentication-identity', 'identity-denied');
  }
  const identities = await loadIdentities(client, input.authenticationPrincipalId);
  const revokedProviderSubjects = new Set(
    identities
      .filter((identity) => identity.revoked_at !== null)
      .map((identity) => parseIdentityText(identity.provider_subject, 'providerSubject')),
  );
  if (accounts.some((account) => revokedProviderSubjects.has(account.providerSubject))) {
    return identityFailure('link-authentication-identity', 'identity-denied');
  }
  const activeIdentities = identities.filter((identity) => identity.revoked_at === null);
  const personIds = new Set(activeIdentities.map((identity) => parsePersonId(identity.person_id)));
  if (personIds.size > 1) {
    return identityFailure('link-authentication-identity', 'identity-conflict');
  }

  const existingPersonId = [...personIds][0];
  if (existingPersonId) {
    const identityBySubject = new Map(
      activeIdentities.map((identity) => [parseIdentityText(identity.provider_subject, 'providerSubject'), identity]),
    );
    const preferredProviderSubject =
      input.preferredProviderSubject === undefined
        ? undefined
        : parseIdentityText(input.preferredProviderSubject, 'providerSubject');
    let selectedIdentity =
      preferredProviderSubject === undefined ? activeIdentities[0] : identityBySubject.get(preferredProviderSubject);
    let linkedIdentity = false;
    for (const account of accounts) {
      const existing = identityBySubject.get(account.providerSubject);
      if (existing) {
        selectedIdentity ??= existing;
        continue;
      }
      const identityId = await createIdentity(client, {
        accountId: account.accountId,
        authenticationPrincipalId: input.authenticationPrincipalId,
        linkedAt: input.observedAt,
        personId: existingPersonId,
        providerSubject: account.providerSubject,
      });
      await recordIdentityEvent(client, {
        eventType: 'authentication-identity-linked',
        identityId,
        personId: existingPersonId,
        recordedAt: input.observedAt,
      });
      linkedIdentity = true;
      const createdIdentity = {
        id: identityId,
        person_id: existingPersonId,
        provider_subject: account.providerSubject,
        revoked_at: null,
      };
      if (preferredProviderSubject === account.providerSubject) {
        selectedIdentity = createdIdentity;
      }
      selectedIdentity ??= createdIdentity;
    }
    if (linkedIdentity) {
      await client.query('DELETE FROM web_sessions WHERE user_id = $1', [input.authenticationPrincipalId]);
    }
    if (!selectedIdentity) {
      return identityFailure('link-authentication-identity', 'identity-unavailable');
    }
    return { kind: 'success', value: principal(selectedIdentity.id, existingPersonId) };
  }

  const bootstrapState = await client.query('SELECT 1 FROM platform_bootstrap_state WHERE singleton = TRUE');
  const people = await client.query<CountRow>('SELECT COUNT(*)::INTEGER AS count FROM people');
  const peopleCount = people.rows[0]?.count;
  if (!input.bootstrapFirstOwner || bootstrapState.rows.length > 0 || peopleCount !== 0) {
    return identityFailure('bootstrap-first-owner', 'identity-denied');
  }
  const displayName = parseIdentityText(authenticationPrincipal.name, 'authenticationPrincipal.name');
  const personId = createPersonId();
  const spaceId = createSpaceId();
  await client.query('INSERT INTO spaces (id, kind, display_name, created_at) VALUES ($1, $2, $3, $4)', [
    spaceId,
    'personal',
    `${displayName}'s Space`,
    input.observedAt,
  ]);
  await client.query(
    `INSERT INTO people (id, display_name, personal_space_id, status)
     VALUES ($1, $2, $3, 'active')`,
    [personId, displayName, spaceId],
  );
  const firstAccount = accounts[0];
  if (!firstAccount) {
    return identityFailure('bootstrap-first-owner', 'identity-unavailable');
  }
  const identityId = await createIdentity(client, {
    accountId: firstAccount.accountId,
    authenticationPrincipalId: input.authenticationPrincipalId,
    linkedAt: input.observedAt,
    personId,
    providerSubject: firstAccount.providerSubject,
  });
  await client.query(
    `INSERT INTO platform_bootstrap_state (singleton, authentication_identity_id, completed_at)
     VALUES (TRUE, $1, $2)`,
    [identityId, input.observedAt],
  );
  await recordIdentityEvent(client, {
    eventType: 'first-owner-bootstrapped',
    identityId,
    personId,
    recordedAt: input.observedAt,
  });
  return { kind: 'success', value: principal(identityId, personId) };
};

export const createPlatformAuthenticationStore = (pool: Pool): PlatformAuthenticationStore => {
  const database = drizzle({ client: pool, schema: betterAuthSchema });
  const identityStore: SharedAuthenticationIdentityStore = {
    canUnlinkAuthenticationIdentity: async ({ authenticationPrincipalId, providerSubject }) => {
      try {
        const result = await pool.query<CountRow>(
          `SELECT COUNT(*)::INTEGER AS count
           FROM authentication_identities
           WHERE authentication_principal_id = $1
             AND provider = 'github'
             AND revoked_at IS NULL`,
          [authenticationPrincipalId],
        );
        const target = await pool.query(
          `SELECT 1
           FROM authentication_identities
           WHERE authentication_principal_id = $1
             AND provider = 'github'
             AND provider_subject = $2
             AND revoked_at IS NULL`,
          [authenticationPrincipalId, providerSubject],
        );
        const count = result.rows[0]?.count;
        return typeof count === 'number' && count > 1 && target.rows.length === 1;
      } catch {
        return false;
      }
    },
    resolveAuthenticationIdentity: async (authenticationIdentityId) => {
      try {
        const result = await pool.query<ResolvedIdentityRow>(
          `SELECT identity.id, identity.person_id, identity.provider
           FROM authentication_identities identity
           INNER JOIN people person ON person.id = identity.person_id
           WHERE identity.id = $1
             AND identity.revoked_at IS NULL
             AND person.status = 'active'`,
          [authenticationIdentityId],
        );
        const row = result.rows[0];
        return row?.provider === 'github' ? principal(row.id, row.person_id) : null;
      } catch {
        return null;
      }
    },
    recordAuthenticationEvent: async (input) => {
      try {
        return await withTransaction(pool, async (client) => {
          const identity = await client.query<IdentityRow>(
            `SELECT id, person_id, provider_subject, revoked_at
             FROM authentication_identities
             WHERE id = $1 AND authentication_principal_id = $2 AND provider = 'github'`,
            [input.authenticationIdentityId, input.authenticationPrincipalId],
          );
          const row = identity.rows[0];
          if (!row) {
            return identityFailure<undefined>('audit-authentication', 'identity-denied');
          }
          await recordIdentityEvent(client, {
            eventType: input.eventType,
            identityId: input.webSessionId,
            personId: parsePersonId(row.person_id),
            recordedAt: input.observedAt,
          });
          return { kind: 'success', value: undefined };
        });
      } catch {
        return identityFailure('audit-authentication', 'identity-unavailable');
      }
    },
    revokeAuthenticationIdentity: async (input) => {
      try {
        return await withTransaction(pool, async (client) => {
          await client.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOTSTRAP_LOCK_NAMESPACE, BOOTSTRAP_LOCK_ID]);
          const identities = await loadIdentities(client, input.authenticationPrincipalId);
          const active = identities.filter((identity) => identity.revoked_at === null);
          const target = active.find(
            (identity) =>
              typeof identity.provider_subject === 'string' && identity.provider_subject === input.providerSubject,
          );
          if (!target || active.length <= 1) {
            return identityFailure<undefined>('unlink-authentication-identity', 'identity-denied');
          }
          const updated = await client.query(
            `UPDATE authentication_identities
             SET revoked_at = $3, authentication_provider_account_id = NULL
             WHERE id = $1 AND authentication_principal_id = $2 AND revoked_at IS NULL`,
            [target.id, input.authenticationPrincipalId, input.revokedAt],
          );
          if (updated.rowCount !== 1) {
            return identityFailure<undefined>('unlink-authentication-identity', 'identity-conflict');
          }
          const personId = parsePersonId(target.person_id);
          await recordIdentityEvent(client, {
            eventType: 'authentication-identity-unlinked',
            identityId: parseAuthenticationIdentityId(target.id),
            personId,
            recordedAt: input.revokedAt,
          });
          return { kind: 'success', value: undefined };
        });
      } catch {
        return identityFailure('unlink-authentication-identity', 'identity-unavailable');
      }
    },
    synchronizeAuthenticationPrincipal: async (input) => {
      try {
        parseInstant(input.observedAt);
        return await withTransaction(pool, (client) => synchronizeInTransaction(client, input));
      } catch {
        return identityFailure('link-authentication-identity', 'identity-unavailable');
      }
    },
  };

  return Object.freeze({
    ...identityStore,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: betterAuthSchema,
      transaction: true,
    }),
  });
};
