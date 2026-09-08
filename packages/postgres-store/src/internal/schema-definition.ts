import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const platformMigrationsTable = pgTable('platform_migrations', {
  appliedAt: timestamp('applied_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  id: text('id').primaryKey(),
  ordinal: integer('ordinal').notNull().unique(),
});

export const platformSchemaMetadataTable = pgTable('platform_schema_metadata', {
  key: text('key').primaryKey(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  value: text('value').notNull(),
});

export const spacesTable = pgTable('spaces', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  displayName: text('display_name').notNull(),
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['personal', 'organization'] }).notNull(),
});

export const peopleTable = pgTable('people', {
  displayName: text('display_name').notNull(),
  id: uuid('id').primaryKey(),
  personalSpaceId: uuid('personal_space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  personalSpaceKind: text('personal_space_kind', { enum: ['personal'] })
    .notNull()
    .default('personal'),
  status: text('status', { enum: ['active', 'suspended'] }).notNull(),
});

export const devicesTable = pgTable('devices', {
  id: uuid('id').primaryKey(),
  label: text('label').notNull(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true }),
  ownerPersonId: uuid('owner_person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['local', 'pending', 'active', 'revoked'] }).notNull(),
});

export const scmAccountsTable = pgTable('scm_accounts', {
  handle: text('handle'),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  provider: text('provider', { enum: ['github', 'gitlab', 'generic'] }).notNull(),
  providerAccountId: text('provider_account_id').notNull(),
});

export const scmInstallationsTable = pgTable('scm_installations', {
  id: uuid('id').primaryKey(),
  provider: text('provider', { enum: ['github', 'gitlab', 'generic'] }).notNull(),
  providerInstallationId: text('provider_installation_id').notNull(),
  selectedRepositoryIds: text('selected_repository_ids').array().notNull().default(sql`'{}'::text[]`),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'suspended', 'revoked'] }).notNull(),
});

export const scmCredentialsTable = pgTable('scm_credentials', {
  accountId: uuid('account_id').references(() => scmAccountsTable.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  encryptedSecretReference: text('encrypted_secret_reference').notNull(),
  id: uuid('id').primaryKey(),
  installationId: uuid('installation_id').references(() => scmInstallationsTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { mode: 'date', withTimezone: true }),
});

export const repositoriesTable = pgTable('repositories', {
  canonicalHost: text('canonical_host').notNull(),
  canonicalName: text('canonical_name').notNull(),
  canonicalOwner: text('canonical_owner'),
  id: uuid('id').primaryKey(),
  provider: text('provider', { enum: ['github', 'gitlab', 'generic'] }).notNull(),
  providerRepositoryId: text('provider_repository_id'),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'renamed', 'archived', 'unknown'] }).notNull(),
});

export const repositoryAliasesTable = pgTable('repository_aliases', {
  firstObservedAt: timestamp('first_observed_at', { mode: 'date', withTimezone: true }).notNull(),
  id: uuid('id').primaryKey(),
  lastObservedAt: timestamp('last_observed_at', { mode: 'date', withTimezone: true }),
  normalizedRemote: text('normalized_remote').notNull(),
  repositoryId: uuid('repository_id')
    .notNull()
    .references(() => repositoriesTable.id, { onDelete: 'restrict' }),
  source: text('source', { enum: ['local-git', 'provider-api', 'manual'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
});

export const projectsTable = pgTable('projects', {
  displayName: text('display_name').notNull(),
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['repository', 'local'] }).notNull(),
  repositoryId: uuid('repository_id').references(() => repositoriesTable.id, { onDelete: 'restrict' }),
  repositorySubpath: text('repository_subpath'),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'archived'] }).notNull(),
});

export const checkoutsTable = pgTable('checkouts', {
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devicesTable.id, { onDelete: 'restrict' }),
  id: uuid('id').primaryKey(),
  lastObservedAt: timestamp('last_observed_at', { mode: 'date', withTimezone: true }).notNull(),
  localPath: text('local_path').notNull(),
  observedRemote: text('observed_remote'),
  projectId: uuid('project_id').references(() => projectsTable.id, { onDelete: 'restrict' }),
  repositoryId: uuid('repository_id').references(() => repositoriesTable.id, { onDelete: 'restrict' }),
  resolutionStatus: text('resolution_status', {
    enum: ['resolved', 'ambiguous', 'candidate', 'unassigned'],
  })
    .notNull()
    .default('unassigned'),
  resolutionReviewedAt: timestamp('resolution_reviewed_at', { mode: 'date', withTimezone: true }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['available', 'missing', 'unknown'] }).notNull(),
});

export const checkoutResolutionCandidatesTable = pgTable(
  'checkout_resolution_candidates',
  {
    checkoutId: uuid('checkout_id')
      .notNull()
      .references(() => checkoutsTable.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositoriesTable.id, { onDelete: 'restrict' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spacesTable.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.checkoutId, table.repositoryId] })],
);

export const captureContextsTable = pgTable('capture_contexts', {
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devicesTable.id, { onDelete: 'restrict' }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').references(() => projectsTable.id, { onDelete: 'restrict' }),
  scmAccountId: uuid('scm_account_id').references(() => scmAccountsTable.id, { onDelete: 'restrict' }),
  scmInstallationId: uuid('scm_installation_id').references(() => scmInstallationsTable.id, {
    onDelete: 'restrict',
  }),
  source: text('source', { enum: ['explicit', 'project-rule', 'personal-fallback', 'unassigned'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
});

export const identityEventsTable = pgTable('identity_events', {
  details: jsonb('details').notNull().default({}),
  eventType: text('event_type').notNull(),
  id: uuid('id').primaryKey(),
  recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  subjectId: uuid('subject_id').notNull(),
  subjectType: text('subject_type').notNull(),
});

export const projectSourceMappingsTable = pgTable(
  'project_source_mappings',
  {
    acknowledgedAt: timestamp('acknowledged_at', { mode: 'date', withTimezone: true }).notNull(),
    checkoutId: uuid('checkout_id')
      .notNull()
      .references(() => checkoutsTable.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projectsTable.id, { onDelete: 'restrict' }),
    projectSourceId: text('project_source_id').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spacesTable.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.projectSourceId] })],
);

export const organizationsTable = pgTable('organizations', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  spaceId: uuid('space_id')
    .primaryKey()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  spaceKind: text('space_kind', { enum: ['organization'] })
    .notNull()
    .default('organization'),
  status: text('status', { enum: ['active', 'suspended'] }).notNull(),
});

export const spaceMembershipsTable = pgTable(
  'space_memberships',
  {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => peopleTable.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    role: text('role', { enum: ['member', 'admin', 'usage-auditor', 'security-auditor'] }).notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => organizationsTable.spaceId, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.personId, table.role] })],
);

export const teamsTable = pgTable('teams', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => organizationsTable.spaceId, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
});

export const teamMembershipsTable = pgTable(
  'team_memberships',
  {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => peopleTable.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => organizationsTable.spaceId, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'revoked'] }).notNull(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teamsTable.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.teamId, table.personId] })],
);

export const teamNestingsTable = pgTable(
  'team_nestings',
  {
    childTeamId: uuid('child_team_id')
      .notNull()
      .references(() => teamsTable.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    parentTeamId: uuid('parent_team_id')
      .notNull()
      .references(() => teamsTable.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => organizationsTable.spaceId, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.parentTeamId, table.childTeamId] })],
);

export const projectGrantsTable = pgTable('project_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projectsTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'collaborator', 'maintainer'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
});

export const repositoryGrantsTable = pgTable('repository_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  repositoryId: uuid('repository_id')
    .notNull()
    .references(() => repositoriesTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'maintainer'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
});

export const scmInstallationRepositoryGrantsTable = pgTable(
  'scm_installation_repository_grants',
  {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => scmInstallationsTable.id, { onDelete: 'restrict' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositoriesTable.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spacesTable.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.installationId, table.repositoryId] })],
);

export const deviceManagersTable = pgTable(
  'device_managers',
  {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devicesTable.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
    personId: uuid('person_id')
      .notNull()
      .references(() => peopleTable.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spacesTable.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.deviceId, table.personId] })],
);

export const sessionAuthorizationScopesTable = pgTable('session_authorization_scopes', {
  id: uuid('id').primaryKey(),
  ownerPersonId: uuid('owner_person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').references(() => projectsTable.id, { onDelete: 'restrict' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'archived', 'purged'] }).notNull(),
});

export const sessionMetadataGrantsTable = pgTable('session_metadata_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'manager'] }).notNull(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessionAuthorizationScopesTable.id, { onDelete: 'restrict' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
});

export const sessionContentGrantsTable = pgTable('session_content_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'editor', 'manager'] }).notNull(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessionAuthorizationScopesTable.id, { onDelete: 'restrict' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
});

export const memoryAuthorizationScopesTable = pgTable('memory_authorization_scopes', {
  id: uuid('id').primaryKey(),
  ownerPersonId: uuid('owner_person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').references(() => projectsTable.id, { onDelete: 'restrict' }),
  requiresTrustedDevice: boolean('requires_trusted_device').notNull().default(false),
  sensitivity: text('sensitivity', { enum: ['normal', 'sensitive'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'superseded'] }).notNull(),
});

export const memoryContentGrantsTable = pgTable('memory_content_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  memoryId: uuid('memory_id')
    .notNull()
    .references(() => memoryAuthorizationScopesTable.id, { onDelete: 'restrict' }),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'proposer', 'manager'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
});

export const workThreadAuthorizationScopesTable = pgTable('work_thread_authorization_scopes', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').references(() => projectsTable.id, { onDelete: 'restrict' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'closed'] }).notNull(),
});

export const workThreadGrantsTable = pgTable('work_thread_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'contributor', 'manager'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
  workThreadId: uuid('work_thread_id')
    .notNull()
    .references(() => workThreadAuthorizationScopesTable.id, { onDelete: 'restrict' }),
});

export const workHandoffAuthorizationScopesTable = pgTable('work_handoff_authorization_scopes', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').references(() => projectsTable.id, { onDelete: 'restrict' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['draft', 'accepted', 'expired'] }).notNull(),
  workThreadId: uuid('work_thread_id')
    .notNull()
    .references(() => workThreadAuthorizationScopesTable.id, { onDelete: 'restrict' }),
});

export const workHandoffGrantsTable = pgTable('work_handoff_grants', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  role: text('role', { enum: ['viewer', 'contributor', 'manager'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'restrict' }),
  workHandoffId: uuid('work_handoff_id')
    .notNull()
    .references(() => workHandoffAuthorizationScopesTable.id, { onDelete: 'restrict' }),
});

export const authorizationAuditEventsTable = pgTable('authorization_audit_events', {
  action: text('action').notNull(),
  actorPersonId: uuid('actor_person_id').references(() => peopleTable.id, { onDelete: 'restrict' }),
  actorServiceId: text('actor_service_id'),
  details: jsonb('details').notNull().default({}),
  id: uuid('id').primaryKey(),
  recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).notNull(),
  result: text('result', { enum: ['allowed', 'denied', 'applied', 'rejected'] }).notNull(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
  subjectId: uuid('subject_id').notNull(),
  subjectType: text('subject_type').notNull(),
});

export const authenticationPrincipalsTable = pgTable('authentication_principals', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  id: uuid('id').primaryKey().defaultRandom(),
  image: text('image'),
  name: text('name').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
});

export const authenticationProviderAccountsTable = pgTable('authentication_provider_accounts', {
  accessToken: text('access_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { mode: 'date', withTimezone: true }),
  accountId: text('account_id').notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  id: uuid('id').primaryKey().defaultRandom(),
  idToken: text('id_token'),
  issuer: text('issuer').notNull(),
  password: text('password'),
  providerId: text('provider_id').notNull(),
  refreshToken: text('refresh_token'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { mode: 'date', withTimezone: true }),
  scope: text('scope'),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authenticationPrincipalsTable.id, { onDelete: 'cascade' }),
});

export const authenticationIdentitiesTable = pgTable('authentication_identities', {
  authenticationPrincipalId: uuid('authentication_principal_id')
    .notNull()
    .references(() => authenticationPrincipalsTable.id, { onDelete: 'cascade' }),
  authenticationProviderAccountId: uuid('authentication_provider_account_id')
    .unique()
    .references(() => authenticationProviderAccountsTable.id, { onDelete: 'set null' }),
  id: uuid('id').primaryKey(),
  linkedAt: timestamp('linked_at', { mode: 'date', withTimezone: true }).notNull(),
  personId: uuid('person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  provider: text('provider', { enum: ['github'] }).notNull(),
  providerSubject: text('provider_subject').notNull(),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
});

export const webSessionsTable = pgTable('web_sessions', {
  absoluteExpiresAt: timestamp('absolute_expires_at', { mode: 'date', withTimezone: true }).notNull(),
  authenticationIdentityId: uuid('authentication_identity_id')
    .notNull()
    .references(() => authenticationIdentitiesTable.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  freshUntil: timestamp('fresh_until', { mode: 'date', withTimezone: true }).notNull(),
  id: uuid('id').primaryKey().defaultRandom(),
  ipAddress: text('ip_address'),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  tokenDigest: text('token_digest').notNull().unique(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => authenticationPrincipalsTable.id, { onDelete: 'cascade' }),
});

export const authenticationVerificationsTable = pgTable('authentication_verifications', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  value: text('value').notNull(),
});

export const platformBootstrapStateTable = pgTable('platform_bootstrap_state', {
  authenticationIdentityId: uuid('authentication_identity_id')
    .notNull()
    .unique()
    .references(() => authenticationIdentitiesTable.id, { onDelete: 'restrict' }),
  completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }).notNull(),
  singleton: boolean('singleton').primaryKey().default(true),
});

export const deviceEnrollmentGrantsTable = pgTable('device_enrollment_grants', {
  consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
  consumedDeviceId: uuid('consumed_device_id').references(() => devicesTable.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  id: uuid('id').primaryKey(),
  keyVersion: integer('key_version').notNull(),
  keyedDigest: text('keyed_digest').notNull(),
  label: text('label').notNull(),
  personId: uuid('person_id')
    .notNull()
    .references(() => peopleTable.id, { onDelete: 'restrict' }),
  publicTokenId: text('public_token_id').notNull().unique(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
});

export const deviceCredentialsTable = pgTable('device_credentials', {
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devicesTable.id, { onDelete: 'restrict' }),
  id: uuid('id').primaryKey(),
  keyVersion: integer('key_version').notNull(),
  keyedDigest: text('keyed_digest').notNull(),
  lastUsedAt: timestamp('last_used_at', { mode: 'date', withTimezone: true }),
  publicTokenId: text('public_token_id').notNull().unique(),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { mode: 'date', withTimezone: true }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spacesTable.id, { onDelete: 'restrict' }),
});

export const betterAuthSchema = Object.freeze({
  authenticationPrincipal: authenticationPrincipalsTable,
  authenticationProviderAccount: authenticationProviderAccountsTable,
  authenticationVerification: authenticationVerificationsTable,
  webSession: webSessionsTable,
});
