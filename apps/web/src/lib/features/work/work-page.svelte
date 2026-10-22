<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { Drawer, drawer, page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import type { SessionPageResult } from '@ai-usage/report-core/session-query';
  import type { WorkRoot } from '@ai-usage/report-core/work-attention';
  import {
    createInfiniteQuery,
    createQuery,
    type InfiniteData,
    keepPreviousData,
    type QueryKey,
  } from '@tanstack/svelte-query';
  import { onMount, tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import { loadNextCampaignPage, retainedCampaignOptions } from '../../query/options/campaigns';
  import { quotaRailQueryOptions } from '../../query/options/quota';
  import { reportBootstrapQueryOptions } from '../../query/options/report';
  import { SessionRevisionExpiredError } from '../../query/options/session-window';
  import { workSessionsOptions } from '../../query/options/work';
  import {
    WorkAttentionQueryError,
    workAttentionQueryOptions,
    workAttentionRequestFromSearch,
  } from '../../query/options/work-attention';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { createSessionClientAdapter } from '../../rpc/session-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import { resolveWorkAttentionClient, type WorkAttentionClient } from '../../rpc/work-attention-client';
  import { useShellNavigationOwner } from '../shell/navigation-owner-context';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import WorkAttentionBoard from './work-attention-board.svelte';
  import WorkAttentionDetail from './work-attention-detail.svelte';
  import {
    parseWorkAttentionSearch,
    type WorkAttentionSearch,
    workRootId,
    writeWorkAttentionSearch,
  } from './work-attention-model';
  import { createSyntheticWorkAttentionClient } from './work-attention-synthetic';
  import WorkCoverageLine from './work-coverage-line.svelte';
  import type { WorkPageData } from './work-load';
  import WorkSession from './work-session.svelte';
  import WorkSources from './work-sources.svelte';
  import {
    workAside,
    workButton,
    workDrawerBody,
    workHeading,
    workInput,
    workLayout,
    workMuted,
    workPanel,
    workStack,
  } from './work-styles';
  import { createSyntheticWorkClient, WORK_DEMO_REVISION, WORK_DEMO_TIME } from './work-synthetic';

  let { data }: { data: WorkPageData } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const shellNavigation = useShellNavigationOwner();
  const clients = untrack(() => {
    const report =
      browser && rpc
        ? createReportClient(rpc)
        : ssrUnavailableClient<ReturnType<typeof createReportClient>>('Work report');
    const browserAttention = (): WorkAttentionClient =>
      browser && rpc ? resolveWorkAttentionClient(rpc) : ssrUnavailableClient<WorkAttentionClient>('Work attention');
    const attention = data.mode === 'demo' ? createSyntheticWorkAttentionClient() : browserAttention();
    if (data.mode !== 'live') {
      return { attention, report, session: createSyntheticWorkClient() };
    }
    const session =
      browser && rpc
        ? createSessionClientAdapter(rpc.session)
        : ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('Work sessions');
    return { attention, report, session };
  });

  // --- Declared outcomes (the resume surface) ---------------------------------------------------
  const attentionQuery = createQuery(() =>
    workAttentionQueryOptions(clients.attention, workAttentionRequestFromSearch(page.url.searchParams), {
      browser,
      enabled: true,
    }),
  );
  const dataset = $derived(attentionQuery.data ?? null);
  const attentionError = $derived.by(() => {
    if (attentionQuery.error instanceof WorkAttentionQueryError) {
      return attentionQuery.error.message;
    }
    if (attentionQuery.error) {
      return 'Declared outcomes could not be read.';
    }
    return dataset ? null : (data.attentionFailure?.message ?? null);
  });

  // --- URL state: filters, selection -------------------------------------------------------------
  const search = $derived<WorkAttentionSearch>(parseWorkAttentionSearch(page.url.searchParams));
  const selectedId = $derived(search.root);
  const selectedRoot = $derived<WorkRoot | null>(
    selectedId && dataset ? (dataset.roots.find((root) => workRootId(root) === selectedId) ?? null) : null,
  );
  let openedFromList = false;
  let lastFocusedId: string | null = null;
  let pendingFocusId = $state<string | null>(null);
  let board = $state<{ focusRoot: (id: string) => Promise<boolean> }>();
  let drawerCloseButton = $state<HTMLButtonElement>();
  const navigate = (next: URL, replace: boolean): Promise<void> =>
    shellNavigation.goto(next, { keepFocus: true, noScroll: true, replaceState: replace });
  const updateSearch = (patch: Partial<WorkAttentionSearch>): void => {
    navigate(writeWorkAttentionSearch(new URL(page.url), { ...search, ...patch }), true);
  };
  const exploreContext = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) {
      return;
    }
    const fields = new FormData(event.currentTarget);
    const next = new URL(page.url);
    for (const name of ['context-project', 'context-days']) {
      const value = String(fields.get(name) ?? '').trim();
      if (value && value !== '30') {
        next.searchParams.set(name, value);
      } else {
        next.searchParams.delete(name);
      }
    }
    next.searchParams.delete('root');
    next.searchParams.delete('project');
    navigate(next, true);
  };
  const select = (id: string): void => {
    lastFocusedId = id;
    const switching = selectedId !== null;
    if (!switching) {
      openedFromList = true;
    }
    navigate(writeWorkAttentionSearch(new URL(page.url), { ...search, root: id }), switching);
  };
  const close = (): void => {
    pendingFocusId = lastFocusedId ?? selectedId;
    if (openedFromList && browser && window.history.length > 1) {
      openedFromList = false;
      window.history.back();
      return;
    }
    navigate(writeWorkAttentionSearch(new URL(page.url), { ...search, root: null }), true);
  };
  // Whatever closed the detail (the close control, Escape, the drawer, or history traversal), the
  // reader lands back on the row they left: the address change is the one signal all paths share.
  let previousSelectedId: string | null = untrack(() => selectedId);
  $effect(() => {
    const current = selectedId;
    const previous = previousSelectedId;
    previousSelectedId = current;
    if (current !== null || previous === null) {
      return;
    }
    const id = untrack(() => pendingFocusId) ?? lastFocusedId ?? previous;
    pendingFocusId = null;
    board?.focusRoot(id);
  });

  // --- Side panel from 1024px, drawer below ------------------------------------------------------
  const wide = new MediaQuery('(min-width: 64rem)', false);
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || !selectedRoot || !wide.current) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-scope="drawer"], [data-scope="tooltip"]')
      ) {
        return;
      }
      close();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  const drawerOpen = $derived(hydrated && !wide.current && selectedRoot !== null);
  const asideDetail = $derived(selectedRoot && (!hydrated || wide.current) ? selectedRoot : null);

  // --- Served session roots (secondary, collapsed) -----------------------------------------------
  const bootstrapQuery = createQuery(() =>
    reportBootstrapQueryOptions(clients.report, { browser: browser && data.mode === 'live' }),
  );
  const bootstrap = $derived(bootstrapQuery.data?.ok ? bootstrapQuery.data : null);
  const revision = $derived(
    data.mode === 'live' ? (bootstrap?.manifest.revision ?? 'work-unavailable') : WORK_DEMO_REVISION,
  );
  const generatedAt = $derived(data.mode === 'live' ? (bootstrap?.manifest.generatedAt ?? null) : WORK_DEMO_TIME);
  let lastReadableKey = $state<QueryKey>();
  let checkedExpiredRevision = '';
  const sessions = createInfiniteQuery(() => ({
    ...workSessionsOptions(clients.session, revision),
    placeholderData: keepPreviousData,
    enabled: browser && (data.mode !== 'live' || bootstrap !== null),
  }));
  const retained = createQuery(() =>
    retainedCampaignOptions<InfiniteData<SessionPageResult, string | null>>(lastReadableKey),
  );
  const displayed = $derived(sessions.data ?? retained.data);
  const displayedRevision = $derived(displayed?.pages[0]?.revision ?? revision);
  $effect(() => {
    if (sessions.data && !sessions.isPlaceholderData && !sessions.error) {
      lastReadableKey = workSessionsOptions(clients.session, revision).queryKey;
    }
    if (
      data.mode === 'live' &&
      sessions.error instanceof SessionRevisionExpiredError &&
      checkedExpiredRevision !== revision
    ) {
      checkedExpiredRevision = revision;
      bootstrapQuery.refetch();
    }
  });
  const quotas = createQuery(() => quotaRailQueryOptions(clients.report, { browser, enabled: data.mode === 'live' }));
  const items = $derived(displayed?.pages.flatMap((result) => result.items) ?? []);
  const loadedRows = $derived(items.map((item) => item.row));
  const ordinary = $derived(items.filter((item) => item.row.origin !== 'classifier'));
  const reviews = $derived(items.filter((item) => item.row.origin === 'classifier'));
  let reviewsOpen = $state(false);
  const sessionsUnavailable = $derived(
    Boolean(
      bootstrapQuery.error ||
        (bootstrapQuery.data && !bootstrapQuery.data.ok) ||
        sessions.error ||
        (data.initialFailure && !sessions.data),
    ),
  );
  const retryAll = (): void => {
    attentionQuery.refetch();
    bootstrapQuery.refetch();
    sessions.refetch();
  };
  const focusDrawerClose = async (): Promise<void> => {
    await tick();
    drawerCloseButton?.focus();
  };
  $effect(() => {
    if (drawerOpen) {
      focusDrawerClose();
    }
  });
</script>

{#snippet detail()}
  {#if selectedRoot && dataset}
    <WorkAttentionDetail
      {loadedRows}
      mode={data.mode}
      onClose={close}
      providers={quotas.data?.latest ?? []}
      quotaUnavailable={Boolean(quotas.error) || !quotas.data}
      reference={dataset.generatedAt}
      revision={displayedRevision}
      root={selectedRoot}
      sessionClient={clients.session}
      bind:closeButton={drawerCloseButton}
    />
  {/if}
{/snippet}

<svelte:head><title>Work · ai-usage</title></svelte:head>
<div class={shell}>
  <main class={pageClass} data-route-shell="work" data-work-hydrated={hydrated}>
    <WorkspaceHeader
      description="What the sessions declared, what was observed since, and where a decision is yours."
      eyebrow="Resume"
      heading="Work"
    >
      {#snippet meta()}
        {#if dataset}
          <WorkCoverageLine
            coverage={dataset.coverage}
            reference={dataset.generatedAt}
            roots={dataset.roots}
            synthetic={data.mode === 'demo'}
          />
        {/if}
      {/snippet}
    </WorkspaceHeader>
    <div class={workStack}>
      {#if data.mode !== 'live'}
        <p class={workMuted}>
          Synthetic demonstration · no local history is read. Declared outcomes, facts and routing eligibility are
          fixture data.
        </p>
      {/if}
      <details class={workPanel} data-work-project-context>
        <summary class={workHeading}>Explore a project context</summary>
        <form class={workStack} onsubmit={exploreContext}>
          <label class={workMuted}
            >Exact project label
            <input
              class={workInput}
              name="context-project"
              placeholder="For example: ai-usage"
              value={page.url.searchParams.get('context-project') ?? ''}
            >
          </label>
          <label class={workMuted}
            >History window
            <select class={workInput} name="context-days" value={page.url.searchParams.get('context-days') ?? '30'}>
              <option value="30">30 days</option>
              <option value="180">180 days</option>
              <option value="365">365 days</option>
              <option value="3650">10 years</option>
            </select>
          </label>
          <button class={workButton} type="submit">Read project context</button>
          <p class={workMuted}>
            The exact project label is matched before the root limit, including its recorded worktrees. An empty label
            reads all projects. The history window is explicit; open Desktop questions are retained at any age.
          </p>
        </form>
      </details>
      {#if page.url.searchParams.has('context-project') || page.url.searchParams.has('context-days')}
        <p class={workMuted} role="status">
          Context: {page.url.searchParams.get('context-project') || 'all projects'} ·
          {workAttentionRequestFromSearch(page.url.searchParams).sinceDays ?? 30}
          days · at most 100 ranked roots.
        </p>
      {/if}
      <WorkSources {generatedAt} mode={data.mode} support={bootstrap?.bootstrap ?? null} />
      {#if dataset}
        <div class={workLayout}>
          <WorkAttentionBoard
            {dataset}
            onFocusRow={(id) => {
              lastFocusedId = id;
            }}
            onSearch={updateSearch}
            onSelect={select}
            {search}
            {selectedId}
            bind:this={board}
          />
          <aside aria-label="Selected root" class={cx(workAside, workPanel)} data-work-aside>
            {#if asideDetail}
              {@render detail()}
            {:else if selectedId && !selectedRoot}
              <p class={workMuted} role="status">
                The selected root is not in this ranking. The ranking covers {dataset.roots.length} of
                {dataset.totalRoots}
                roots; the selection is kept in the address.
              </p>
            {:else}
              <p class={workMuted}>Select a row to read its declaration, facts and the review simulation.</p>
            {/if}
          </aside>
        </div>
        {#if hydrated}
          <Drawer
            closeOnInteractOutside
            contentAriaLabel="Selected root"
            contentClass={drawer}
            modal
            onOpenChange={(open) => {
              if (!open) {
                close();
              }
            }}
            open={drawerOpen}
            preventScroll
            trapFocus
          >
            <div class={workDrawerBody}>
              {#if selectedRoot}
                {@render detail()}
              {/if}
            </div>
          </Drawer>
        {/if}
      {:else if attentionError}
        <section class={workPanel} role="alert">
          <p class={workHeading}>Declared outcomes are unavailable</p>
          <p class={workMuted}>{attentionError}</p>
          <p class={workMuted}>This does not establish that there is nothing to do.</p>
          <button
            class={workButton}
            disabled={attentionQuery.isFetching}
            onclick={() => attentionQuery.refetch()}
            type="button"
          >
            Retry declared outcomes
          </button>
        </section>
      {:else}
        <p class={workMuted} role="status">Reading declared outcomes…</p>
      {/if}

      <details class={workPanel} data-work-served-roots>
        <summary class={workHeading}>
          All observed session roots (served revision)
          <span class={workMuted}>
            {items.length}
            of {displayed?.pages[0]?.itemCount ?? 'unknown'} loaded · most recent first · recorded usage, no declared
            outcome
          </span>
        </summary>
        <div class={workStack}>
          {#if displayedRevision !== revision}
            <p class={workMuted} role="status">
              Showing the previous readable revision while newer observations are
              {sessions.error ? 'unavailable' : 'loading'}. Related sessions use that same retained revision.
            </p>
          {/if}
          {#if sessionsUnavailable}
            <section class={workPanel} role="alert">
              <p class={workHeading}>Session observations are unavailable</p>
              {#if data.initialFailure && !sessions.data}
                <p class={workMuted}>{data.initialFailure.message}</p>
              {/if}
              <p class={workMuted}>
                The stored revision could not be read. This does not establish that there is nothing to do.
              </p>
              <button class={workButton} onclick={retryAll} type="button">Retry stored observations</button>
            </section>
          {:else if items.length === 0}
            <p class={workMuted} role="status">
              {sessions.isPending ? 'Reading stored session observations…' : 'No session roots were observed in this revision.'}
            </p>
          {/if}
          {#each ordinary as item (item.row.rowId)}
            <WorkSession client={clients.session} {item} revision={displayedRevision} />
          {/each}
          {#if reviews.length > 0}
            <details class={workPanel} ontoggle={(event) => { reviewsOpen = event.currentTarget.open; }}>
              <summary class={workHeading}>Standalone automated reviews ({reviews.length})</summary>
              {#if reviewsOpen}
                {#each reviews as item (item.row.rowId)}
                  <WorkSession client={clients.session} {item} revision={displayedRevision} />
                {/each}
              {/if}
            </details>
          {/if}
          {#if sessions.hasNextPage && displayedRevision === revision}
            <button
              class={workButton}
              disabled={sessions.isFetching}
              onclick={() => loadNextCampaignPage(sessions)}
              type="button"
            >
              Load more observed sessions
            </button>
          {/if}
        </div>
      </details>
    </div>
  </main>
</div>
