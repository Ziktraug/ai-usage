import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readAuthorizedResourceScopeIds } from '@ai-usage/authorization/scope-internal';
import { type PersonId, parsePersonId, parseSpaceId, type SpaceId } from '@ai-usage/platform-core/identity';
import { projectAuthorizationScopeSqlForBenchmark } from '@ai-usage/postgres-store/performance-testing';
import { createPlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { Pool, type QueryResultRow } from 'pg';
import { startPostgresCluster } from './pg-harness';

const spaceCount = 50;
const projectsPerSpace = 200;
const peoplePerSpace = 20;
const warmupSamples = 10;
const measuredRounds = 5;
const triggerP95Milliseconds = 150;

interface ExplainRow extends QueryResultRow {
  readonly 'QUERY PLAN': unknown;
}

interface ExplainMetrics {
  readonly operatorRows: number;
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
}

const deterministicUuid = (label: string): string => {
  const digest = createHash('md5').update(label).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const organizationSpaceId = (spaceIndex: number): SpaceId =>
  parseSpaceId(deterministicUuid(`authorization-benchmark-organization-${spaceIndex}`));

const personId = (spaceIndex: number, personIndex: number): PersonId =>
  parsePersonId(deterministicUuid(`authorization-benchmark-person-${spaceIndex}-${personIndex}`));

const percentile = (sorted: readonly number[], fraction: number): number => {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
};

const rounded = (value: number): number => Math.round(value * 1000) / 1000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const numeric = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const collectExplainMetrics = (node: unknown): ExplainMetrics => {
  if (!isRecord(node)) {
    return { operatorRows: 0, sharedHitBlocks: 0, sharedReadBlocks: 0 };
  }
  const loops = numeric(node['Actual Loops']);
  let operatorRows = numeric(node['Actual Rows']) * (loops === 0 ? 1 : loops);
  let sharedHitBlocks = numeric(node['Shared Hit Blocks']);
  let sharedReadBlocks = numeric(node['Shared Read Blocks']);
  const children = node.Plans;
  if (Array.isArray(children)) {
    for (const child of children) {
      const metrics = collectExplainMetrics(child);
      operatorRows += metrics.operatorRows;
      sharedHitBlocks += metrics.sharedHitBlocks;
      sharedReadBlocks += metrics.sharedReadBlocks;
    }
  }
  return { operatorRows, sharedHitBlocks, sharedReadBlocks };
};

const applicationRoleUrl = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  url.username = 'authorization_benchmark_app';
  return url.toString();
};

const seedWorkload = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE FUNCTION benchmark_uuid(value TEXT) RETURNS UUID
    LANGUAGE SQL IMMUTABLE STRICT AS $$
      SELECT (
        substr(md5(value), 1, 8) || '-' ||
        substr(md5(value), 9, 4) || '-4' ||
        substr(md5(value), 14, 3) || '-a' ||
        substr(md5(value), 18, 3) || '-' ||
        substr(md5(value), 21, 12)
      )::UUID
    $$;

    INSERT INTO spaces (id, kind, display_name, created_at)
    SELECT benchmark_uuid('authorization-benchmark-organization-' || space_index),
           'organization', 'Benchmark organization ' || space_index, TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index;

    INSERT INTO spaces (id, kind, display_name, created_at)
    SELECT benchmark_uuid('authorization-benchmark-personal-' || space_index || '-' || person_index),
           'personal', 'Benchmark personal Space', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(1, ${peoplePerSpace}) AS person_index;

    INSERT INTO people (id, display_name, personal_space_id, status)
    SELECT benchmark_uuid('authorization-benchmark-person-' || space_index || '-' || person_index),
           'Benchmark Person ' || space_index || '-' || person_index,
           benchmark_uuid('authorization-benchmark-personal-' || space_index || '-' || person_index),
           'active'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(1, ${peoplePerSpace}) AS person_index;

    INSERT INTO organizations (space_id, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-organization-' || space_index),
           'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index;

    INSERT INTO space_memberships (space_id, person_id, role, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-organization-' || space_index),
           benchmark_uuid('authorization-benchmark-person-' || space_index || '-' || person_index),
           'member', 'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(1, ${peoplePerSpace}) AS person_index;

    INSERT INTO teams (id, space_id, name, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-team-' || team_kind || '-' || space_index),
           benchmark_uuid('authorization-benchmark-organization-' || space_index),
           'Benchmark ' || team_kind, 'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN (VALUES ('child'), ('middle'), ('parent')) AS team(team_kind);

    INSERT INTO team_memberships (space_id, team_id, person_id, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-organization-' || space_index),
           benchmark_uuid('authorization-benchmark-team-child-' || space_index),
           benchmark_uuid('authorization-benchmark-person-' || space_index || '-' || person_index),
           'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(1, ${peoplePerSpace}) AS person_index;

    INSERT INTO team_nestings (space_id, parent_team_id, child_team_id, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-organization-' || space_index),
           benchmark_uuid('authorization-benchmark-team-middle-' || space_index),
           benchmark_uuid('authorization-benchmark-team-child-' || space_index),
           'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    UNION ALL
    SELECT benchmark_uuid('authorization-benchmark-organization-' || space_index),
           benchmark_uuid('authorization-benchmark-team-parent-' || space_index),
           benchmark_uuid('authorization-benchmark-team-middle-' || space_index),
           'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index;

    INSERT INTO projects (id, space_id, kind, display_name, status)
    SELECT benchmark_uuid('authorization-benchmark-project-' || space_index || '-' || project_index),
           benchmark_uuid('authorization-benchmark-organization-' || space_index),
           'local', 'Benchmark Project ' || project_index, 'active'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(1, ${projectsPerSpace}) AS project_index;

    INSERT INTO project_grants
      (id, space_id, project_id, team_id, role, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-team-grant-' || space_index || '-' || project_index),
           benchmark_uuid('authorization-benchmark-organization-' || space_index),
           benchmark_uuid('authorization-benchmark-project-' || space_index || '-' || project_index),
           benchmark_uuid('authorization-benchmark-team-parent-' || space_index),
           'viewer', 'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(1, 120) AS project_index;

    INSERT INTO project_grants
      (id, space_id, project_id, person_id, role, status, created_at)
    SELECT benchmark_uuid('authorization-benchmark-person-grant-' || space_index || '-' || project_index),
           benchmark_uuid('authorization-benchmark-organization-' || space_index),
           benchmark_uuid('authorization-benchmark-project-' || space_index || '-' || project_index),
           benchmark_uuid(
             'authorization-benchmark-person-' || space_index || '-' || (((project_index - 121) % ${peoplePerSpace}) + 1)
           ),
           'collaborator', 'active', TIMESTAMPTZ '2026-08-29 00:00:00Z'
    FROM generate_series(1, ${spaceCount}) AS space_index
    CROSS JOIN generate_series(121, 160) AS project_index;

    ANALYZE spaces;
    ANALYZE people;
    ANALYZE organizations;
    ANALYZE space_memberships;
    ANALYZE teams;
    ANALYZE team_memberships;
    ANALYZE team_nestings;
    ANALYZE projects;
    ANALYZE project_grants;
  `);
};

const explainRepresentativeQuery = async (pool: Pool, spaceId: SpaceId, actorId: PersonId): Promise<ExplainMetrics> => {
  const query = projectAuthorizationScopeSqlForBenchmark();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('ai_usage.active_space_id', $1, TRUE)", [spaceId]);
    const result = await client.query<ExplainRow>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, [
      spaceId,
      actorId,
      true,
    ]);
    await client.query('ROLLBACK');
    const document = result.rows[0]?.['QUERY PLAN'];
    const root = Array.isArray(document) ? document[0] : undefined;
    return collectExplainMetrics(isRecord(root) ? root.Plan : undefined);
  } finally {
    client.release();
  }
};

if (process.env.AI_USAGE_RUN_POSTGRES_TESTS !== '1') {
  throw new Error('Run this benchmark through bun run benchmark:authorization inside nix develop.');
}

const cluster = await startPostgresCluster('authorization-benchmark');
const administrator = createPlatformTestingDatabase(cluster.url);
const seedPool = new Pool({ connectionString: cluster.url, max: 1 });
let applicationPool: Pool | undefined;
let store: Awaited<ReturnType<typeof createPlatformStore>> | undefined;

try {
  await administrator.runMigrations({ mode: 'apply' });
  await seedWorkload(seedPool);
  await seedPool.query('CREATE ROLE authorization_benchmark_app LOGIN NOSUPERUSER');
  await seedPool.query('GRANT USAGE, CREATE ON SCHEMA public TO authorization_benchmark_app');
  await seedPool.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO authorization_benchmark_app');

  const applicationUrl = applicationRoleUrl(cluster.url);
  store = await createPlatformStore({
    connectTimeoutMs: 5000,
    databaseUrl: applicationUrl,
    migrationMode: 'verify',
    poolSize: 8,
    queryTimeoutMs: 15_000,
    tlsMode: 'disable',
  });
  applicationPool = new Pool({ connectionString: applicationUrl, max: 1 });

  const sample = async (spaceIndex: number): Promise<number> => {
    const startedAt = performance.now();
    const scope = await store?.authorization.materializeResourceScope({
      context: { activeSpaceId: organizationSpaceId(spaceIndex), trustedDevice: true },
      permission: 'view_project',
      principal: { kind: 'person', personId: personId(spaceIndex, 1) },
      resourceKind: 'project',
    });
    const duration = performance.now() - startedAt;
    if (scope?.kind !== 'scope' || readAuthorizedResourceScopeIds(scope).length !== 122) {
      throw new Error('The benchmark scope did not contain the expected 122 Projects.');
    }
    return duration;
  };

  for (let index = 0; index < warmupSamples; index += 1) {
    await sample((index % spaceCount) + 1);
  }

  const durations: number[] = [];
  for (let round = 0; round < measuredRounds; round += 1) {
    for (let spaceIndex = 1; spaceIndex <= spaceCount; spaceIndex += 1) {
      durations.push(await sample(spaceIndex));
    }
  }
  durations.sort((left, right) => left - right);

  const explain = await explainRepresentativeQuery(applicationPool, organizationSpaceId(1), personId(1, 1));
  const p95 = percentile(durations, 0.95);
  process.stdout.write(
    `${JSON.stringify(
      {
        authorizedProjectsPerSample: 122,
        explain: {
          operatorRows: Math.round(explain.operatorRows),
          sharedHitBlocks: Math.round(explain.sharedHitBlocks),
          sharedReadBlocks: Math.round(explain.sharedReadBlocks),
        },
        latencyMilliseconds: {
          p50: rounded(percentile(durations, 0.5)),
          p95: rounded(p95),
          p99: rounded(percentile(durations, 0.99)),
        },
        measuredSamples: durations.length,
        openFgaPerformanceTriggerFired: p95 > triggerP95Milliseconds,
        triggerP95Milliseconds,
        workload: {
          nestedTeamDepth: 3,
          peoplePerSpace,
          projectsPerSpace,
          spaces: spaceCount,
        },
      },
      null,
      2,
    )}\n`,
  );
  if (p95 > triggerP95Milliseconds) {
    process.exitCode = 2;
  }
} finally {
  await store?.close().catch(() => undefined);
  await applicationPool?.end().catch(() => undefined);
  await seedPool.end().catch(() => undefined);
  await administrator.close().catch(() => undefined);
  await cluster.stop();
}
