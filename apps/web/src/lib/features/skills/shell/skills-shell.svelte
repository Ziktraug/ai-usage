<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import type {
    ProjectSkillMarkdownDocument,
    ProjectSkillMarkdownInput,
    SkillMarkdownDocument,
  } from '@ai-usage/web-contract/skills';
  import { createQuery, useIsFetching } from '@tanstack/svelte-query';
  import { onMount, type Snippet, untrack } from 'svelte';
  import { replaceState } from '$app/navigation';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import type { WebQueryHydrationState } from '../../../query/client';
  import { useWebQueryHydrationContext } from '../../../query/hydration-context.svelte';
  import {
    managedSkillMarkdownQueryOptions,
    projectSkillMarkdownQueryOptions,
    type SkillsQueryClient,
    skillObservationsQueryOptions,
    skillsKnownProjectPathsQueryOptions,
    skillsProjectInventoriesQueryOptions,
    skillsSnapshotQueryOptions,
  } from '../../../query/options/skills';
  import { useWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import { createSkillsManagementOperationEpisode } from '../management/operation-episode.svelte';
  import { createSkillsPresentationProjection } from '../presentation';
  import { createSkillsShellViewModel, normalizeSkillsQuerySnapshot } from './model';
  import { createSkillsFallbackNavigationRequest } from './skills-fallback-navigation';
  import SkillsWorkspace from './skills-workspace.svelte';
  import type { SkillsHealthSlotPlacement, SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';
  import { createSkillsSnapshotController, type SkillsDraftGuardPort } from './snapshot-controller';

  let {
    editorSlot,
    healthSlot,
    hydrationState,
    matrixSlot,
    navigationState,
    onSourceChange,
    pathname,
    runtimeMode,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    healthSlot?: Snippet<[SkillsShellSlotContext, SkillsHealthSlotPlacement]>;
    hydrationState: WebQueryHydrationState;
    matrixSlot?: Snippet<[SkillsShellSlotContext]>;
    navigationState: App.PageState;
    onSourceChange?: (source: string) => void;
    pathname: string;
    runtimeMode: RuntimeMode;
  } = $props();

  const browserRpc = untrack(() =>
    typeof globalThis.location === 'undefined' ? undefined : useWebQueryRpcContext().rpc,
  );
  let browserClient: ReturnType<typeof createSkillsClient> | undefined;
  const resolveClient = (): ReturnType<typeof createSkillsClient> => {
    if (!browserRpc) {
      throw new Error('The shared browser RPC context is unavailable.');
    }
    browserClient ??= createSkillsClient(browserRpc.skills);
    return browserClient;
  };
  const client: SkillsQueryClient = {
    getKnownSkillProjectPaths: (options) => resolveClient().getKnownSkillProjectPaths(options),
    getManagedSkillMarkdown: (skillName, options) => resolveClient().getManagedSkillMarkdown(skillName, options),
    getProjectSkillMarkdown: (input, options) => resolveClient().getProjectSkillMarkdown(input, options),
    getSkillManagementSnapshot: (options) => resolveClient().getSkillManagementSnapshot(options),
    getSkillObservations: (options) => resolveClient().getSkillObservations(options),
    getSkillProjectInventories: (options) => resolveClient().getSkillProjectInventories(options),
  };
  const management = createSkillsManagementOperationEpisode(resolveClient);
  let mounted = $state(false);
  const hydrationContext = useWebQueryHydrationContext();
  const hydrationApplied = $derived(hydrationContext.covers(hydrationState));
  const queriesEnabled = $derived(mounted && hydrationApplied && runtimeMode !== 'demo');
  const snapshotQuery = createQuery(() =>
    skillsSnapshotQueryOptions(client, {
      browser: mounted,
      enabled: queriesEnabled,
    }),
  );
  const knownPathsQuery = createQuery(() =>
    skillsKnownProjectPathsQueryOptions(client, {
      browser: mounted,
      enabled: queriesEnabled,
    }),
  );
  const inventoriesQuery = createQuery(() =>
    skillsProjectInventoriesQueryOptions(client, {
      browser: mounted,
      enabled: queriesEnabled && snapshotQuery.data?.configured === true,
    }),
  );
  // Its own query, on its own identity and cadence: observations move when the engine collects,
  // never because this page navigated (ADR 0022 / the collection-swr policy).
  const observationsQuery = createQuery(() =>
    skillObservationsQueryOptions(client, {
      browser: mounted,
      enabled: queriesEnabled,
    }),
  );
  const querySnapshot = $derived(
    snapshotQuery.data === undefined ? undefined : normalizeSkillsQuerySnapshot(snapshotQuery.data),
  );
  const initialSnapshot = untrack(() => querySnapshot);
  let acceptedSnapshot = $state<SkillManagementSnapshot | undefined>(initialSnapshot);
  let pendingSnapshot = $state<SkillManagementSnapshot | undefined>();
  const createSnapshotController = (initial: SkillManagementSnapshot) =>
    createSkillsSnapshotController({
      initial,
      onCommit: (snapshot) => {
        acceptedSnapshot = snapshot;
      },
    });
  let snapshotController = initialSnapshot ? createSnapshotController(initialSnapshot) : undefined;
  const synchronizePendingSnapshot = (): void => {
    pendingSnapshot = snapshotController?.pending();
  };
  const registerDraft = (guard: SkillsDraftGuardPort): void => {
    snapshotController?.registerDraft(guard);
  };
  const unregisterDraft = (guard: SkillsDraftGuardPort): void => {
    snapshotController?.unregisterDraft(guard);
  };
  const discardPendingSnapshot = async (): Promise<boolean> => {
    const discarded = (await snapshotController?.discardPending()) ?? false;
    synchronizePendingSnapshot();
    return discarded;
  };
  const focusDraft = (): void => {
    snapshotController?.focusDraft();
  };
  const keepPendingSnapshot = (): void => {
    snapshotController?.retainCurrent();
    synchronizePendingSnapshot();
  };
  const snapshotUpdates = $derived<SkillsSnapshotUpdatePort>({
    pendingDecision:
      pendingSnapshot === undefined
        ? undefined
        : {
            discard: discardPendingSnapshot,
            focus: focusDraft,
            keep: keepPendingSnapshot,
            snapshot: pendingSnapshot,
          },
    registerDraft,
    unregisterDraft,
  });

  $effect(() => {
    const nextSnapshot = querySnapshot;
    if (nextSnapshot === undefined) {
      return;
    }
    snapshotController ??= createSnapshotController(nextSnapshot);
    if (snapshotController.current() !== nextSnapshot) {
      snapshotController.apply(nextSnapshot);
    }
    acceptedSnapshot = snapshotController.current();
    synchronizePendingSnapshot();
  });

  const view = $derived(
    acceptedSnapshot &&
      knownPathsQuery.data &&
      (acceptedSnapshot.configured !== true || inventoriesQuery.data !== undefined)
      ? createSkillsShellViewModel({
          inventories: inventoriesQuery.data ?? [],
          knownProjectPaths: knownPathsQuery.data,
          pathname,
          snapshot: acceptedSnapshot,
        })
      : undefined,
  );
  const managedSkillName = $derived(view?.selection.type === 'global-skill' ? view.selection.skillName : undefined);
  const managedDocumentQuery = createQuery(() =>
    managedSkillMarkdownQueryOptions(client, managedSkillName ?? '', {
      browser: mounted,
      enabled: queriesEnabled && managedSkillName !== undefined,
    }),
  );
  const projectDocumentInput = $derived.by<ProjectSkillMarkdownInput | undefined>(() => {
    if (view?.selectionDetail.kind !== 'project-skill') {
      return;
    }
    const observation = view.selectionDetail.skill.observations.at(0);
    if (observation === undefined) {
      return;
    }
    return {
      projectPath: observation.projectPath,
      runtimeDirId: observation.runtimeDirId,
      skillName: view.selectionDetail.skill.name,
    };
  });
  const projectDocumentQuery = createQuery(() =>
    projectSkillMarkdownQueryOptions(
      client,
      projectDocumentInput ?? { projectPath: '', runtimeDirId: 'agents-project', skillName: '' },
      {
        browser: mounted,
        enabled: queriesEnabled && projectDocumentInput !== undefined,
      },
    ),
  );
  const selectedDocument = $derived<ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined>(
    managedSkillName === undefined ? projectDocumentQuery.data : managedDocumentQuery.data,
  );
  const skillsFetching = useIsFetching({ queryKey: ['web', 'finite-swr', 'skills'] });
  // Observations live under their own cadence prefix, so the skills fetch gate above cannot see
  // them. Counting them separately keeps the hydration contract honest instead of declaring the
  // page settled while one of its reads is still in flight.
  const observationsFetching = useIsFetching({ queryKey: ['web', 'collection-swr', 'skill-observations'] });
  const observationsError = $derived(
    observationsQuery.error instanceof Error ? observationsQuery.error.message : undefined,
  );
  const presentation = $derived(
    view === undefined
      ? undefined
      : createSkillsPresentationProjection({
          observations: observationsQuery.data,
          observationsError,
          view,
        }),
  );
  const queryContractReady = $derived(
    mounted &&
      snapshotQuery.data !== undefined &&
      knownPathsQuery.data !== undefined &&
      (observationsQuery.data !== undefined || observationsQuery.error !== null) &&
      !observationsQuery.isFetching &&
      observationsFetching.current === 0 &&
      (snapshotQuery.data.configured !== true || inventoriesQuery.data !== undefined) &&
      (managedSkillName === undefined || managedDocumentQuery.data !== undefined) &&
      (projectDocumentInput === undefined || projectDocumentQuery.data !== undefined) &&
      !snapshotQuery.isFetching &&
      !knownPathsQuery.isFetching &&
      !inventoriesQuery.isFetching &&
      !managedDocumentQuery.isFetching &&
      !projectDocumentQuery.isFetching &&
      skillsFetching.current === 0,
  );
  const hydrated = $derived(hydrationApplied && queryContractReady);
  const loading = $derived(snapshotQuery.isPending || knownPathsQuery.isPending);
  const messageFromError = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);
  const errorMessage = $derived(messageFromError(snapshotQuery.error) ?? messageFromError(knownPathsQuery.error));
  const statusPanel = css({
    display: 'grid',
    minH: '260px',
    placeItems: 'center',
    p: '20px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
  });

  onMount(() => {
    const activationFrame = window.requestAnimationFrame(() => {
      mounted = true;
    });
    return () => window.cancelAnimationFrame(activationFrame);
  });

  $effect(() => {
    if (!(mounted && view?.fallbackHref)) {
      return;
    }
    const request = createSkillsFallbackNavigationRequest(window.location.href, navigationState);
    replaceState(request.intent.url, request.state);
  });
</script>

{#if view && presentation}
  <SkillsWorkspace
    {...(editorSlot === undefined ? {} : { editorSlot })}
    {...(healthSlot === undefined ? {} : { healthSlot })}
    {hydrated}
    {management}
    {...(matrixSlot === undefined ? {} : { matrixSlot })}
    {presentation}
    {selectedDocument}
    {...(onSourceChange === undefined ? {} : { onSourceChange })}
    snapshot={view.snapshot}
    {snapshotUpdates}
    {view}
  />
{:else if loading}
  <div aria-busy="true" class={statusPanel}>Loading skills…</div>
{:else}
  <section aria-live="polite" class={statusPanel}>
    <div>
      <h2>Skills unavailable</h2>
      <p>{errorMessage ?? 'Skill data could not be loaded.'}</p>
    </div>
  </section>
{/if}
