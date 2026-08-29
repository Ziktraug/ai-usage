import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot as DomainSkillManagementSnapshot } from '@ai-usage/skills';
import type {
  ProjectSkillMarkdownDocument,
  ProjectSkillMarkdownInput,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillMarkdownSaveResult,
} from '@ai-usage/web-contract/skills';
import { QueryObserver } from '@tanstack/svelte-query';
import type { SkillsClientResult } from '../../rpc/skills-client';
import { createWebQueryClient } from '../client';
import { webQueryPolicies } from '../policies';
import { publicationInvalidatedKeys } from '../publication';
import {
  applyManagedMarkdownSaveToCache,
  applySkillsConfigurationSnapshotToCache,
  invalidateSkillsQueries,
  managedSkillMarkdownKey,
  managedSkillMarkdownQueryOptions,
  projectSkillMarkdownKey,
  projectSkillMarkdownQueryOptions,
  type SkillsQueryClient,
  type SkillsQueryError,
  skillObservationsKey,
  skillsKnownProjectPathsKey,
  skillsKnownProjectPathsQueryOptions,
  skillsProjectInventoriesKey,
  skillsProjectInventoriesQueryOptions,
  skillsSnapshotKey,
  skillsSnapshotQueryOptions,
} from './skills';

const snapshot: SkillManagementSnapshot = {
  config: {},
  configured: false,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { skillEnabledByName: {}, version: 1 },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
};

const managedDocument = (skillName: string, content = '# Stored'): SkillMarkdownDocument => ({
  content,
  path: `/synthetic/skills/${skillName}/SKILL.md`,
  sha256: 'a'.repeat(64),
  skillName,
});

const unavailable = <Value>(): SkillsClientResult<Value> => ({
  error: { message: 'Skills are unavailable.', tag: 'Unavailable' },
  ok: false,
});

const skillsClient = (overrides: Partial<SkillsQueryClient> = {}): SkillsQueryClient => ({
  getKnownSkillProjectPaths: () => Promise.resolve(unavailable()),
  getManagedSkillMarkdown: () => Promise.resolve(unavailable()),
  getProjectSkillMarkdown: () => Promise.resolve(unavailable()),
  getSkillManagementSnapshot: () => Promise.resolve(unavailable()),
  getSkillObservations: () => Promise.resolve(unavailable()),
  getSkillProjectInventories: () => Promise.resolve(unavailable()),
  ...overrides,
});

const projectMarkdownInput = {
  projectPath: '/synthetic/project',
  runtimeDirId: 'agents-project',
  skillName: 'review',
} as const satisfies ProjectSkillMarkdownInput;

describe('Skills query options', () => {
  test('QUERY-SKILLS-SNAPSHOT: uses separate finite SWR keys and explicit browser enablement', async () => {
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const record = <Value>(name: string, signal: AbortSignal | undefined, data: Value): SkillsClientResult<Value> => {
      calls.push(name);
      if (signal) {
        signals.push(signal);
      }
      return { data, ok: true };
    };
    const client = skillsClient({
      getKnownSkillProjectPaths: ({ signal } = {}) => Promise.resolve(record('known-paths', signal, [])),
      getSkillManagementSnapshot: ({ signal } = {}) => Promise.resolve(record('snapshot', signal, snapshot)),
      getSkillProjectInventories: ({ signal } = {}) => Promise.resolve(record('inventories', signal, [])),
    });
    const serverDisabled = skillsSnapshotQueryOptions(client, { browser: false, enabled: true });
    const businessDisabled = skillsSnapshotQueryOptions(client, { browser: true, enabled: false });

    expect(serverDisabled).toMatchObject({
      enabled: false,
      gcTime: webQueryPolicies.finiteSwr.gcTime,
      queryKey: skillsSnapshotKey(),
      retry: false,
      staleTime: webQueryPolicies.finiteSwr.staleTime,
      structuralSharing: false,
    });
    expect(skillsKnownProjectPathsKey()).not.toEqual(skillsSnapshotKey());
    expect(skillsProjectInventoriesKey()).not.toEqual(skillsSnapshotKey());
    expect(skillsProjectInventoriesKey()).not.toEqual(skillsKnownProjectPathsKey());

    const queryClient = createWebQueryClient();
    const serverObserver = new QueryObserver(queryClient, serverDisabled);
    const businessObserver = new QueryObserver(queryClient, businessDisabled);
    const unsubscribeServer = serverObserver.subscribe(() => undefined);
    const unsubscribeBusiness = businessObserver.subscribe(() => undefined);
    await Promise.resolve();
    expect(calls).toEqual([]);
    unsubscribeServer();
    unsubscribeBusiness();

    await Promise.all([
      queryClient.fetchQuery(skillsSnapshotQueryOptions(client, { browser: true, enabled: true })),
      queryClient.fetchQuery(skillsKnownProjectPathsQueryOptions(client, { browser: true, enabled: true })),
      queryClient.fetchQuery(skillsProjectInventoriesQueryOptions(client, { browser: true, enabled: true })),
    ]);
    expect(calls.sort()).toEqual(['inventories', 'known-paths', 'snapshot']);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);

    const publishedSnapshots: SkillManagementSnapshot[] = [];
    const snapshotObserver = new QueryObserver(
      queryClient,
      skillsSnapshotQueryOptions(client, { browser: true, enabled: true }),
    );
    const unsubscribeSnapshot = snapshotObserver.subscribe((result) => {
      if (result.data) {
        publishedSnapshots.push(result.data);
      }
    });
    const equalRefreshPublication = structuredClone(snapshot);
    queryClient.setQueryData(skillsSnapshotKey(), equalRefreshPublication);
    expect(queryClient.getQueryData<SkillManagementSnapshot>(skillsSnapshotKey())).toBe(equalRefreshPublication);
    expect(publishedSnapshots.at(-1)).toBe(equalRefreshPublication);
    unsubscribeSnapshot();
  });

  test('QUERY-SKILLS-MARKDOWN: keys managed/project documents by canonical scope and exact identity', async () => {
    const calls: Array<{ input: unknown; signal: AbortSignal | undefined; type: string }> = [];
    const client = skillsClient({
      getManagedSkillMarkdown: (skillName, { signal } = {}) => {
        calls.push({ input: skillName, signal, type: 'managed' });
        return Promise.resolve({ data: managedDocument(skillName), ok: true });
      },
      getProjectSkillMarkdown: (input, { signal } = {}) => {
        calls.push({ input, signal, type: 'project' });
        return Promise.resolve({
          data: {
            content: '# Project',
            path: '/synthetic/project/.agents/skills/review/SKILL.md',
            skillName: input.skillName,
            truncated: false,
          },
          ok: true,
        });
      },
    });

    expect(managedSkillMarkdownKey('review')).toEqual([
      'web',
      'finite-swr',
      'skills',
      'markdown',
      'scope',
      'managed',
      'skill',
      'review',
    ]);
    expect(projectSkillMarkdownKey(projectMarkdownInput)).toEqual([
      'web',
      'finite-swr',
      'skills',
      'markdown',
      'scope',
      'project',
      'project-path',
      '/synthetic/project',
      'runtime-dir',
      'agents-project',
      'skill',
      'review',
    ]);
    expect(projectSkillMarkdownKey(projectMarkdownInput)).not.toEqual(managedSkillMarkdownKey('review'));
    expect(projectSkillMarkdownKey({ ...projectMarkdownInput, runtimeDirId: 'claude-project' })).not.toEqual(
      projectSkillMarkdownKey(projectMarkdownInput),
    );

    const queryClient = createWebQueryClient();
    await Promise.all([
      queryClient.fetchQuery(managedSkillMarkdownQueryOptions(client, 'review', { browser: true, enabled: true })),
      queryClient.fetchQuery(
        projectSkillMarkdownQueryOptions(client, projectMarkdownInput, { browser: true, enabled: true }),
      ),
    ]);
    expect(calls.map(({ type }) => type).sort()).toEqual(['managed', 'project']);
    expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
  });

  test('QUERY-SKILLS-MUTATION-EXACT: successful save updates only its exact managed document', () => {
    const queryClient = createWebQueryClient();
    const exactKey = managedSkillMarkdownKey('review');
    const otherManagedKey = managedSkillMarkdownKey('other');
    const projectKey = projectSkillMarkdownKey(projectMarkdownInput);
    const priorExact = managedDocument('review', '# Prior');
    const otherManaged = managedDocument('other');
    const projectDocument: ProjectSkillMarkdownDocument = {
      content: '# Project',
      path: '/synthetic/project/.agents/skills/review/SKILL.md',
      skillName: projectMarkdownInput.skillName,
      truncated: false,
    };
    queryClient.setQueryData(exactKey, priorExact);
    queryClient.setQueryData(otherManagedKey, otherManaged);
    queryClient.setQueryData(projectKey, projectDocument);
    queryClient.setQueryData(skillsSnapshotKey(), snapshot);
    const savedDocument = managedDocument('review', '# Saved');
    const saveResult = {
      data: { document: savedDocument, snapshot },
      ok: true,
    } as const satisfies SkillsClientResult<SkillMarkdownSaveResult>;

    expect(applyManagedMarkdownSaveToCache(queryClient, 'review', saveResult)).toBe(true);
    expect(queryClient.getQueryData<SkillMarkdownDocument>(exactKey)).toEqual(savedDocument);
    expect(queryClient.getQueryData<SkillMarkdownDocument>(otherManagedKey)).toBe(otherManaged);
    expect(queryClient.getQueryData<ProjectSkillMarkdownDocument>(projectKey)).toBe(projectDocument);
    expect(queryClient.getQueryData<SkillManagementSnapshot>(skillsSnapshotKey())).toBe(snapshot);
  });

  test('QUERY-DIRTY-BUFFER-CLIENT-OWNED: pending/conflict/error outcomes retain cache and never store drafts', async () => {
    const queryClient = createWebQueryClient();
    const key = managedSkillMarkdownKey('review');
    const prior = managedDocument('review', '# Stored');
    const dirtyDraft = '# Unsaved private draft';
    queryClient.setQueryData(key, prior);
    const pendingSave = Promise.withResolvers<SkillsClientResult<SkillMarkdownSaveResult>>();
    const pendingApplication = pendingSave.promise.then((result) =>
      applyManagedMarkdownSaveToCache(queryClient, 'review', result),
    );

    await Promise.resolve();
    expect(queryClient.getQueryData<SkillMarkdownDocument>(key)).toBe(prior);
    pendingSave.resolve({ data: { reason: 'conflict' }, ok: true });
    expect(await pendingApplication).toBe(false);
    expect(
      applyManagedMarkdownSaveToCache(queryClient, 'review', {
        error: { message: 'Save failed.', tag: 'Unavailable' },
        ok: false,
      }),
    ).toBe(false);
    expect(queryClient.getQueryData<SkillMarkdownDocument>(key)).toBe(prior);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map(({ state }) => state.data),
      ),
    ).not.toContain(dirtyDraft);

    queryClient.setQueryData(skillsSnapshotKey(), snapshot);
    await queryClient.invalidateQueries({ exact: true, queryKey: skillsSnapshotKey(), refetchType: 'none' });
    const failedRefresh = queryClient.fetchQuery(
      skillsSnapshotQueryOptions(skillsClient(), { browser: true, enabled: true }),
    );
    await expect(failedRefresh).rejects.toMatchObject({
      message: 'Skills are unavailable.',
      name: 'SkillsQueryError',
      tag: 'Unavailable',
    } satisfies Partial<SkillsQueryError>);
    expect(queryClient.getQueryData<SkillManagementSnapshot>(skillsSnapshotKey())).toBe(snapshot);
  });

  test('QUERY-SKILLS-CONFIGURATION: seeds inventories after an unconfigured save and skips target creation', async () => {
    const queryClient = createWebQueryClient();
    const configuredSnapshot = {
      config: { sourceRepoPath: '/synthetic/source' },
      configured: true,
      diagnostics: [],
      nativeRuleFindings: [],
      projections: [],
      skills: [],
      sourceState: { skillEnabledByName: {}, version: 1 },
      summary: snapshot.summary,
      targets: [],
      unmanagedEntries: [],
    } satisfies DomainSkillManagementSnapshot;
    const targetSnapshot = {
      ...configuredSnapshot,
      summary: { ...configuredSnapshot.summary, targetCount: 1 },
    } satisfies DomainSkillManagementSnapshot;
    const order: string[] = [];
    const knownProjectPaths = [] as const;
    queryClient.setQueryData(skillsSnapshotKey(), snapshot);
    queryClient.setQueryData(skillsKnownProjectPathsKey(), knownProjectPaths, { updatedAt: Date.now() });
    const knownPathsObserver = new QueryObserver(queryClient, {
      ...webQueryPolicies.finiteSwr,
      queryFn: () => {
        expect(queryClient.getQueryData<DomainSkillManagementSnapshot>(skillsSnapshotKey())).toEqual(
          configuredSnapshot,
        );
        order.push('known-project-paths');
        return knownProjectPaths;
      },
      queryKey: skillsKnownProjectPathsKey(),
    });
    const unsubscribe = knownPathsObserver.subscribe(() => undefined);
    const inventories = [] as const;
    let inventoryFetches = 0;
    const inventoryClient = {
      getSkillProjectInventories: () => {
        inventoryFetches += 1;
        order.push('project-inventories');
        expect(queryClient.getQueryData<DomainSkillManagementSnapshot>(skillsSnapshotKey())).toEqual(
          configuredSnapshot,
        );
        return Promise.resolve({ data: inventories, ok: true } as const);
      },
    };

    await applySkillsConfigurationSnapshotToCache(queryClient, inventoryClient, configuredSnapshot, true);
    expect(order).toEqual(['known-project-paths', 'project-inventories']);
    expect(queryClient.getQueryData<readonly []>(skillsProjectInventoriesKey())).toBe(inventories);

    queryClient.removeQueries({ exact: true, queryKey: skillsProjectInventoriesKey() });
    order.length = 0;
    await applySkillsConfigurationSnapshotToCache(queryClient, inventoryClient, targetSnapshot, false);
    expect(queryClient.getQueryData<DomainSkillManagementSnapshot>(skillsSnapshotKey())).toEqual(targetSnapshot);
    expect(queryClient.getQueryData(skillsProjectInventoriesKey())).toBeUndefined();
    expect(order).toEqual([]);
    expect(inventoryFetches).toBe(1);
    unsubscribe();
  });

  test('QUERY-SMALLEST-KEY-UPDATE: invalidates/refetches only selected exact Skills keys', async () => {
    const queryClient = createWebQueryClient();
    const counts = { inventories: 0, knownPaths: 0, markdown: 0, snapshot: 0 };
    const entries = [
      { key: skillsSnapshotKey(), name: 'snapshot' as const },
      { key: skillsKnownProjectPathsKey(), name: 'knownPaths' as const },
      { key: skillsProjectInventoriesKey(), name: 'inventories' as const },
      { key: managedSkillMarkdownKey('review'), name: 'markdown' as const },
    ];
    const unsubscribers = entries.map(({ key, name }) => {
      queryClient.setQueryData(key, { value: name }, { updatedAt: Date.now() });
      const observer = new QueryObserver(queryClient, {
        ...webQueryPolicies.finiteSwr,
        queryFn: () => {
          counts[name] += 1;
          return { value: name };
        },
        queryKey: key,
      });
      return observer.subscribe(() => undefined);
    });

    await invalidateSkillsQueries(queryClient, ['snapshot', 'project-inventories', 'snapshot']);
    expect(counts).toEqual({ inventories: 1, knownPaths: 0, markdown: 0, snapshot: 1 });
    expect(queryClient.getQueryState(skillsKnownProjectPathsKey())?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(managedSkillMarkdownKey('review'))?.isInvalidated).toBe(false);
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });

  test('QUERY-SKILL-OBSERVATION-FRESHNESS: a finished publication refetches a mounted observations surface', async () => {
    const queryClient = createWebQueryClient();
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      ...webQueryPolicies.collectionSwr,
      queryFn: () => {
        fetches += 1;
        return { fetches };
      },
      queryKey: skillObservationsKey(),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetches).toBe(1);

    // The policy revalidates on nothing a browser does, so without this the surface would show its
    // first paint for as long as the tab stayed open. A publication is the engine saying the cycle
    // that writes observations has finished, which is the only event that can change them.
    for (const queryKey of publicationInvalidatedKeys()) {
      await queryClient.invalidateQueries({ exact: true, queryKey });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetches).toBe(2);
    unsubscribe();
    queryClient.clear();
  });
});
