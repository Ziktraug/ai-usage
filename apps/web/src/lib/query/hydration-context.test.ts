import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { QueryObserver } from '@tanstack/svelte-query';
import { deferredSkillsShellRoute } from '../features/skills/shell/data';
import {
  syntheticInventories,
  syntheticKnownPaths,
  syntheticManagedDocument,
  syntheticObservations,
  syntheticProjectDocument,
  syntheticSnapshot,
} from '../features/skills/shell/synthetic-fixture.test-helper';
import {
  createHydratedWebQueryClient,
  createWebQueryClient,
  dehydrateWebQueryClient,
  mergeWebQueryHydrationStates,
  type WebQueryHydrationState,
} from './client';
import { webQueryHydrationCovers } from './hydration-context.svelte';
import {
  managedSkillMarkdownKey,
  skillsKnownProjectPathsKey,
  skillsProjectInventoriesKey,
  skillsSnapshotKey,
} from './identities/skills';
import type { WebQueryKey } from './keys';
import { quotaRailKey } from './options/quota';
import {
  managedSkillMarkdownQueryOptions,
  type SkillsQueryClient,
  skillsKnownProjectPathsQueryOptions,
  skillsProjectInventoriesQueryOptions,
  skillsSnapshotQueryOptions,
} from './options/skills';
import { FINITE_SWR_STALE_TIME_MS, webQueryPolicies } from './policies';

const QUOTA_UPDATED_AT = 100;
const SKILLS_UPDATED_AT = 200;
const NEWER_UPDATED_AT = 300;
const MERGED_LIVE_DOCUMENT_QUERY_COUNT = 4;
const STALE_MARGIN_MS = 5000;
const SETTLE_TICKS = 5;
const QUIET_WINDOW_MS = 50;
const SKILLS_ROUTE_QUERY_COUNT = 4;
const SEEDED_SKILL_NAME = 'alpha-skill';
const BASE_TIME_MS = Date.UTC(2026, 7, 23, 12, 0, 0);
const unusedSkillsCall = (): never => {
  throw new Error('This Skills query client must not be called.');
};
const EMPTY_SKILLS_CLIENT: SkillsQueryClient = {
  getKnownSkillProjectPaths: unusedSkillsCall,
  getManagedSkillMarkdown: unusedSkillsCall,
  getProjectSkillMarkdown: unusedSkillsCall,
  getSkillManagementSnapshot: unusedSkillsCall,
  getSkillObservations: unusedSkillsCall,
  getSkillProjectInventories: unusedSkillsCall,
};
const HYDRATION_IMPORT_PATTERN = /import\s+\{([^}]*)\}\s+from\s+'[^']*hydration-context\.svelte'/u;

const dehydrated = (
  ...entries: readonly (readonly [key: WebQueryKey, updatedAt: number])[]
): WebQueryHydrationState => {
  const client = createWebQueryClient();
  for (const [key, updatedAt] of entries) {
    client.setQueryData(key, { fixture: key.join('/') }, { updatedAt });
  }
  const state = dehydrateWebQueryClient(client);
  client.clear();
  return state;
};

const quotaRailState = (updatedAt = QUOTA_UPDATED_AT): WebQueryHydrationState =>
  dehydrated([quotaRailKey(), updatedAt]);

const skillsRouteState = (updatedAt = SKILLS_UPDATED_AT): WebQueryHydrationState =>
  dehydrated(
    [skillsSnapshotKey(), updatedAt],
    [skillsKnownProjectPathsKey(), updatedAt],
    [managedSkillMarkdownKey('alpha-skill'), updatedAt],
  );

describe('web query hydration coverage', () => {
  test('covers the Skills route delta on a live document load, where the root state carries the quota rail too', () => {
    const quota = quotaRailState();
    const skills = skillsRouteState();
    const merged = mergeWebQueryHydrationStates(quota, skills);

    expect(merged.dehydratedState.queries).toHaveLength(MERGED_LIVE_DOCUMENT_QUERY_COUNT);
    // The root applies one query the Skills route never carries, so the two states can never be
    // equal on a live document load. That asymmetry is why the gate must ask for coverage, not
    // equality: an equality gate stays false for the whole session and every Skills observer
    // that SSR did not already seed — the SKILL.md of a client-selected skill — never fetches.
    const routeHashes = new Set(skills.dehydratedState.queries.map((query) => query.queryHash));
    const rootOnlyHashes = merged.dehydratedState.queries
      .map((query) => query.queryHash)
      .filter((queryHash) => !routeHashes.has(queryHash));
    const quotaHashes = quota.dehydratedState.queries.map((query) => query.queryHash);

    expect(quotaHashes).toHaveLength(1);
    expect(rootOnlyHashes).toEqual(quotaHashes);
    expect(webQueryHydrationCovers(merged, skills)).toBe(true);
  });

  test("covers a client-side navigation, where the route's data-request delta is empty", () => {
    const deferred = deferredSkillsShellRoute().queryState;

    expect(deferred.dehydratedState.queries).toHaveLength(0);
    expect(webQueryHydrationCovers(quotaRailState(), deferred)).toBe(true);
    expect(webQueryHydrationCovers(undefined, deferred)).toBe(true);
  });

  test('does not cover a route delta the provider has not applied yet', () => {
    const skills = skillsRouteState();

    expect(webQueryHydrationCovers(quotaRailState(), skills)).toBe(false);
    expect(webQueryHydrationCovers(undefined, skills)).toBe(false);
  });

  test('treats an older applied copy as uncovered and a newer one as covered', () => {
    const expected = skillsRouteState(SKILLS_UPDATED_AT);

    expect(webQueryHydrationCovers(skillsRouteState(QUOTA_UPDATED_AT), expected)).toBe(false);
    expect(webQueryHydrationCovers(skillsRouteState(SKILLS_UPDATED_AT), expected)).toBe(true);
    expect(webQueryHydrationCovers(skillsRouteState(NEWER_UPDATED_AT), expected)).toBe(true);
  });

  test('pins the two-sided composition that makes coverage, not equality, the correct gate', async () => {
    const rootLayout = await Bun.file(new URL('../../routes/+layout.svelte', import.meta.url)).text();
    const skillsLayout = await Bun.file(new URL('../../routes/skills/+layout.svelte', import.meta.url)).text();
    const skillsShell = await Bun.file(new URL('../features/skills/shell/skills-shell.svelte', import.meta.url)).text();

    expect(rootLayout).toContain('mergeWebQueryHydrationStates(data.quotaQueryState, page.data.queryState)');
    expect(skillsLayout).toContain('hydrationState={data.queryState}');
    expect(skillsShell).toContain('hydrationContext.covers(hydrationState)');

    // The shell binds the context hook and nothing else from the hydration module, so no
    // signature-style helper can creep back in beside it.
    const [, bindings] = HYDRATION_IMPORT_PATTERN.exec(skillsShell) ?? [];
    expect(
      (bindings ?? '')
        .split(',')
        .map((binding) => binding.trim())
        .filter(Boolean),
    ).toEqual(['useWebQueryHydrationContext']);
  });
});

/**
 * Enabling the Skills observers for the first time in live mode is the one behavioural risk the
 * plan flagged: a mount now genuinely revalidates when the SSR payload is older than the finite-SWR
 * stale time. Plan 087's STOP condition is "the four Skills RPCs firing more than once per 30 s
 * without user action", so these tests drive the REAL production query options for all four route
 * queries through one shared fetch counter that every observer increments, and hold a real quiet
 * window open across a mount. They stand in for the live network-tab check the execution mandate
 * did not permit.
 */
describe('observer revalidation once coverage enables the Skills queries', () => {
  const seededSnapshot = syntheticSnapshot();
  const refetchedSnapshot = syntheticSnapshot([...seededSnapshot.skills, ...seededSnapshot.skills]);
  const seededDocument = { ...syntheticManagedDocument, content: '# seeded from SSR' };

  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < SETTLE_TICKS; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const quietWindow = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
  };

  const mountSkillsObservers = (hydratedAt: number) => {
    let fetches = 0;
    // Every observer, whenever it mounts, reaches the network through this one counter, and the
    // fetched values differ from the seeded ones so a cache read is distinguishable from a refetch.
    const client: SkillsQueryClient = {
      getKnownSkillProjectPaths: () => {
        fetches += 1;
        return Promise.resolve({ data: [...syntheticKnownPaths], ok: true });
      },
      getManagedSkillMarkdown: () => {
        fetches += 1;
        return Promise.resolve({ data: syntheticManagedDocument, ok: true });
      },
      getProjectSkillMarkdown: () => {
        fetches += 1;
        return Promise.resolve({ data: syntheticProjectDocument, ok: true });
      },
      getSkillManagementSnapshot: () => {
        fetches += 1;
        return Promise.resolve({ data: refetchedSnapshot, ok: true });
      },
      getSkillObservations: () => {
        fetches += 1;
        return Promise.resolve({ data: syntheticObservations, ok: true });
      },
      getSkillProjectInventories: () => {
        fetches += 1;
        return Promise.resolve({ data: [...syntheticInventories], ok: true });
      },
    };

    const seed = createWebQueryClient();
    seed.setQueryData(skillsSnapshotKey(), seededSnapshot, { updatedAt: hydratedAt });
    seed.setQueryData(skillsKnownProjectPathsKey(), [], { updatedAt: hydratedAt });
    seed.setQueryData(skillsProjectInventoriesKey(), [], { updatedAt: hydratedAt });
    seed.setQueryData(managedSkillMarkdownKey(SEEDED_SKILL_NAME), seededDocument, { updatedAt: hydratedAt });
    const routeState = dehydrateWebQueryClient(seed);
    seed.clear();

    const applied = mergeWebQueryHydrationStates(quotaRailState(), routeState);
    const queryClient = createHydratedWebQueryClient(applied);
    const enabled = webQueryHydrationCovers(applied, routeState);
    const context = { browser: true, enabled };
    const unsubscribes: (() => void)[] = [];

    const track = <Observer extends { subscribe: (listener: () => void) => () => void }>(
      observer: Observer,
    ): Observer => {
      unsubscribes.push(observer.subscribe(() => undefined));
      return observer;
    };
    const observeSnapshot = () => track(new QueryObserver(queryClient, skillsSnapshotQueryOptions(client, context)));

    return {
      enabled,
      fetchCount: () => fetches,
      mountAll: () => ({
        document: track(
          new QueryObserver(queryClient, managedSkillMarkdownQueryOptions(client, SEEDED_SKILL_NAME, context)),
        ),
        inventories: track(new QueryObserver(queryClient, skillsProjectInventoriesQueryOptions(client, context))),
        knownPaths: track(new QueryObserver(queryClient, skillsKnownProjectPathsQueryOptions(client, context))),
        snapshot: observeSnapshot(),
      }),
      observeSnapshot,
      release: () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
        queryClient.clear();
      },
    };
  };

  afterEach(() => {
    setSystemTime();
  });

  test('revalidates every stale route query exactly once per mount and stays quiet between mounts', async () => {
    setSystemTime(new Date(BASE_TIME_MS));
    const session = mountSkillsObservers(BASE_TIME_MS - (FINITE_SWR_STALE_TIME_MS + STALE_MARGIN_MS));
    const mounted = session.mountAll();
    await settle();

    expect(session.enabled).toBe(true);
    expect(session.fetchCount()).toBe(SKILLS_ROUTE_QUERY_COUNT);
    expect(mounted.snapshot.getCurrentResult().data?.skills).toHaveLength(refetchedSnapshot.skills.length);

    // Hold a real window open and cross the whole stale period with no user action. A polling or
    // focus/reconnect revalidation would land inside this window.
    setSystemTime(new Date(BASE_TIME_MS + FINITE_SWR_STALE_TIME_MS + STALE_MARGIN_MS));
    await quietWindow();

    expect(session.fetchCount()).toBe(SKILLS_ROUTE_QUERY_COUNT);

    // A later mount over now-stale data revalidates once, and only for the key it observes.
    const remounted = session.observeSnapshot();
    await settle();

    expect(session.fetchCount()).toBe(SKILLS_ROUTE_QUERY_COUNT + 1);
    expect(remounted.getCurrentResult().status).toBe('success');
    expect(remounted.getCurrentResult().data?.skills).toHaveLength(refetchedSnapshot.skills.length);
    session.release();
  });

  test('issues no revalidation while the hydrated data is still fresh, on mount or remount', async () => {
    setSystemTime(new Date(BASE_TIME_MS));
    const session = mountSkillsObservers(BASE_TIME_MS);
    const mounted = session.mountAll();
    await settle();

    expect(session.enabled).toBe(true);
    expect(session.fetchCount()).toBe(0);
    expect(mounted.snapshot.getCurrentResult().data?.skills).toHaveLength(seededSnapshot.skills.length);

    const remounted = session.observeSnapshot();
    await quietWindow();

    expect(session.fetchCount()).toBe(0);
    expect(remounted.getCurrentResult().status).toBe('success');
    expect(remounted.getCurrentResult().data?.skills).toHaveLength(seededSnapshot.skills.length);
    session.release();
  });

  test('keeps the finite-SWR policy free of any automatic revalidation trigger', () => {
    // A quiet window can only catch fast polling. This pins the policy a slow poll would need.
    expect(webQueryPolicies.finiteSwr.staleTime).toBe(FINITE_SWR_STALE_TIME_MS);
    expect(webQueryPolicies.finiteSwr.refetchOnWindowFocus).toBe(false);
    expect(webQueryPolicies.finiteSwr.refetchOnReconnect).toBe(false);
    expect(webQueryPolicies.finiteSwr).not.toHaveProperty('refetchInterval');
    for (const options of [
      skillsSnapshotQueryOptions,
      skillsKnownProjectPathsQueryOptions,
      skillsProjectInventoriesQueryOptions,
    ]) {
      expect(options(EMPTY_SKILLS_CLIENT, { browser: true, enabled: true })).not.toHaveProperty('refetchInterval');
    }
  });
});
