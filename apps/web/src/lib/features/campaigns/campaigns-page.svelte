<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits string ARIA states verified by the browser regressions -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton, ghostButtonStyle } from '@ai-usage/design-system/report';
  import { page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import { campaignMapTitle } from '@ai-usage/report-core/campaign-map';
  import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
  import {
    createInfiniteQuery,
    createQuery,
    keepPreviousData,
    type QueryKey,
    useQueryClient,
  } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';
  import { browser } from '$app/env';
  import { afterNavigate, beforeNavigate, snapshot } from '$app/navigation';
  import { page } from '$app/state';
  import { campaignDisplayLabelFor, indexCampaignLabelOverrides } from '../../foundation/campaign-label-overrides';
  import { campaignMapFixtureGeneratedAt } from '../../foundation/campaign-map-fixture';
  import { parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
  import { displayTitle } from '../../foundation/presentation/display-title';
  import { fmtCompact } from '../../foundation/presentation/format';
  import {
    loadNextCampaignPage,
    pruneCampaignExplorations,
    retainedCampaignOptions,
    retainedCampaignQuery,
  } from '../../query/options/campaigns';
  import { campaignLabelOverridesQueryOptions, reportBootstrapQueryOptions } from '../../query/options/report';
  import { optionalSessionLookupQueryOptions } from '../../query/options/session';
  import { SessionRevisionExpiredError, type SessionWindowIntent } from '../../query/options/session-window';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import SessionDetailQuerySlot from '../sessions/detail/session-detail-query-slot.svelte';
  import { dashboardSearchCodec } from '../shell/navigation';
  import { useShellNavigationOwner } from '../shell/navigation-owner-context';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import CampaignAgentMap from './campaign-agent-map.svelte';
  import { resolveCampaignDetailSelection } from './campaign-detail-selection';
  import CampaignProjectTimeline from './campaign-project-timeline.svelte';
  import { buildCampaignTimeline, campaignTimelineRange } from './campaign-timeline-model';
  import CampaignVirtualList from './campaign-virtual-list.svelte';
  import { createCampaignExplorationState } from './campaigns-exploration-state.svelte';
  import { createCampaignFocusRestoration } from './campaigns-focus-restoration.svelte';
  import type { CampaignsPageData } from './campaigns-load';
  import { createCampaignNavigationActions } from './campaigns-navigation-actions.svelte';
  import {
    activeCard,
    activeViewButton,
    campaignList,
    card,
    cardStyle,
    detail,
    empty,
    field,
    input,
    layout,
    mobileBack,
    muted,
    notice,
    title,
    toolbar,
    viewControls,
  } from './campaigns-page.styles';
  import { campaignPageClientsFor } from './campaigns-page-clients';
  import {
    bootstrapCampaignRevision,
    campaignMapFor,
    campaignRefreshFor,
    campaignTimelineContext,
    detailNavigationRowsFor,
    inheritedFiltersFor,
    MULTIPLE_HARNESSES,
    mergeRowsById,
    optionalSessionLookupRequest,
    recordedAt,
    sessionCount,
    syntheticCampaignRevision,
  } from './campaigns-page-model';
  import {
    type CampaignExplorationData,
    campaignMatchingMembersOptions,
    campaignsExplorationOptions,
    campaignsListOptions,
    campaignsRequest,
  } from './campaigns-query';
  import { readCampaignSelection } from './campaigns-selection';

  let { data }: { data: CampaignsPageData } = $props();
  const queryClient = useQueryClient();
  const shellNavigation = useShellNavigationOwner();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const clients = untrack(() => campaignPageClientsFor({ browser, mode: data.mode, rpc }));
  let replayOpen = $state(false);
  // Loaded on first open. A script-side import keeps Svelte's await-block runtime out of the
  // shared first-load chunk, which the report's gzip budget counts.
  let replayComponent = $state<typeof import('./campaign-replay.svelte')['default'] | null>(null);
  let replayLoadFailed = $state(false);
  const toggleReplay = (): void => {
    replayOpen = !replayOpen;
    if (!(replayOpen && replayComponent === null)) {
      return;
    }
    replayLoadFailed = false;
    import('./campaign-replay.svelte').then(
      (module) => {
        replayComponent = module.default;
      },
      () => {
        replayLoadFailed = true;
      },
    );
  };
  let previousKey = $state<QueryKey>();
  const focusRestoration = createCampaignFocusRestoration({
    campaignView: () => campaignView,
    pathname: () => page.url.pathname,
    searchExpanded: () => explorationState.searchExpanded,
    selectedSessionId: () => selectedSessionId,
  });
  const explorationState = createCampaignExplorationState({ focus: focusRestoration, scope: () => scope });
  const campaignNavigation = createCampaignNavigationActions({
    exploration: explorationState,
    focus: focusRestoration,
    goto: (url, gotoOptions) => shellNavigation.goto(url, gotoOptions),
    href: () => page.url.href,
    latest: () => latest,
    pageState: () => page.state,
    pageUrl: () => pageUrl,
    rowRevisionFor: (rowId) => rowRevisionFor(rowId),
    search: () => search,
    selectedKey: () => selectedKey,
    selectedSessionId: () => selectedSessionId,
    selectionRowId: () => selection?.row.rowId,
  });
  const {
    applyFilters,
    changeSelection,
    clearFilters,
    clearSelection,
    openSession,
    restart,
    selectCampaign,
    selectView,
  } = campaignNavigation;
  let checkedExpiredRevision = '';
  const bootstrapQuery = createQuery(() =>
    reportBootstrapQueryOptions(clients.report, { browser: browser && data.mode === 'live' }),
  );
  const bootstrap = $derived(bootstrapQuery.data?.ok ? bootstrapQuery.data : null);
  const bootstrapUnavailable = $derived(
    bootstrapQuery.data && !bootstrapQuery.data.ok ? bootstrapQuery.data.error.message : null,
  );
  const labelsQuery = createQuery(() =>
    campaignLabelOverridesQueryOptions(clients.report, { browser: browser && data.mode === 'live' }),
  );
  const labels = $derived(indexCampaignLabelOverrides(data.mode === 'live' ? (labelsQuery.data ?? []) : []));
  const latest = $derived.by(() =>
    data.mode === 'live' ? bootstrapCampaignRevision(bootstrap) : syntheticCampaignRevision(),
  );
  const revision = $derived(explorationState.inspected?.revision ?? latest?.revision);
  // SvelteKit 3 types `page.url` as read-only; the shared URL helpers take a URL.
  const pageUrl = $derived(new URL(page.url.href));
  const search = $derived(parseDashboardSearchUrl(pageUrl, dashboardSearchCodec));
  const scope = $derived(JSON.stringify(search));
  const harnessSelection = $derived(search.harness.length > 1 ? MULTIPLE_HARNESSES : (search.harness[0] ?? ''));
  const campaignView = $derived(page.url.searchParams.get('campaignView') === 'timeline' ? 'timeline' : 'list');
  const inheritedFilters = $derived(inheritedFiltersFor(search));
  const request = $derived(
    campaignsRequest(
      search,
      explorationState.inspected?.generatedAt ?? latest?.generatedAt ?? campaignMapFixtureGeneratedAt,
      revision ?? 'pending-campaigns',
    ),
  );
  const requestedTimelineRange = $derived(
    campaignTimelineRange(
      search.range,
      explorationState.inspected?.generatedAt ?? latest?.generatedAt ?? campaignMapFixtureGeneratedAt,
    ),
  );
  const urlSelection = $derived(readCampaignSelection(pageUrl, request));
  let requestedCampaign = $state(
    untrack(() => {
      if (urlSelection.status === 'selected') {
        return urlSelection.campaignKey;
      }
      const hydrated = retainedCampaignQuery<CampaignExplorationData['list']>(
        queryClient,
        campaignsListOptions(clients.session, request).queryKey,
      );
      return hydrated?.pages[0]?.items[0]?.campaignKey ?? '';
    }),
  );
  const selectedSessionId = $derived(page.url.searchParams.get('selectedSession') ?? '');
  const intent = $derived<SessionWindowIntent>({
    topLevelDepth: explorationState.topDepth,
    campaignChildrenDepth: {},
    campaignSessionsDepth: requestedCampaign
      ? { [requestedCampaign]: explorationState.memberDepths[requestedCampaign] ?? 1 }
      : {},
  });
  const options = $derived(
    campaignsExplorationOptions({
      client: clients.session,
      queryClient,
      request,
      timelineRange: requestedTimelineRange,
      intent,
      anchors: explorationState.anchors,
      ...(explorationState.matchingRestoration ? { matching: explorationState.matchingRestoration } : {}),
    }),
  );
  const exploration = createQuery(() => ({
    ...options,
    enabled:
      browser && revision !== undefined && (data.mode !== 'live' || (bootstrap !== null && !bootstrapQuery.error)),
    placeholderData: keepPreviousData,
  }));
  const retained = createQuery(() => retainedCampaignOptions<CampaignExplorationData>(previousKey));
  const visible = $derived(exploration.data ?? retained.data);
  const listPages = $derived(visible?.list.pages ?? []);
  const items = $derived(listPages.flatMap((entry) => entry.items));
  const virtualCampaigns = $derived(items.map((item) => ({ key: item.campaignKey, item })));
  const selectedKey = $derived(
    urlSelection.status === 'selected'
      ? urlSelection.campaignKey
      : explorationState.automaticCampaign || items[0]?.campaignKey || '',
  );
  const selectedItem = $derived(items.find((item) => item.campaignKey === selectedKey));
  const visibleRevision = $derived(visible?.request.revision);
  const listAnswersRequest = $derived(
    visibleRevision === request.revision &&
      visible &&
      sessionQueryFingerprint(visible.request) === sessionQueryFingerprint(request),
  );
  // Placeholders and the retained Query value carry their own presentation context. Never fit
  // an old response to the newly requested period while its replacement is still being acquired.
  const timelineContext = $derived(campaignTimelineContext(visible));
  const timeline = $derived(
    buildCampaignTimeline(
      items,
      visible?.timelineRange ?? { from: null, to: null },
      explorationState.timelineAxis?.context === timelineContext ? explorationState.timelineAxis.axis : null,
    ),
  );
  const memberPages = $derived(visible?.members.find((entry) => entry.campaignKey === selectedKey)?.data.pages ?? []);
  const root = $derived(memberPages[0]?.root);
  const mapRevision = $derived(memberPages[0]?.revision);
  const map = $derived(root ? campaignMapFor(selectedKey, root, memberPages) : null);
  const rows = $derived(map?.nodes.map((node) => node.row) ?? []);
  const presentedMap = $derived(
    map ? { ...map, title: campaignDisplayLabelFor(labels, selectedKey, map.title) } : null,
  );
  const timelineMap = $derived(mapRevision === visibleRevision ? presentedMap : null);
  const hasMoreCampaigns = $derived(Boolean(listPages.at(-1)?.nextCursor));
  const hasMoreSessions = $derived(Boolean(memberPages.at(-1)?.nextCursor));
  const matchingOptions = $derived(
    campaignMatchingMembersOptions(clients.session, visible?.request ?? request, selectedKey || 'pending-selection'),
  );
  const matching = createInfiniteQuery(() => ({
    ...matchingOptions,
    enabled: browser && Boolean(search.q && selectedKey && visibleRevision && listAnswersRequest),
  }));
  const matchedRows = $derived(
    search.q &&
      matching.data?.pages[0]?.revision === visibleRevision &&
      matching.data?.pages[0]?.campaignKey === selectedKey &&
      retainedCampaignQuery(queryClient, matchingOptions.queryKey) === matching.data
      ? (matching.data?.pages.flatMap((entry) => entry.items) ?? [])
      : [],
  );
  const matchRows = $derived(matchedRows.map((row) => ({ key: row.rowId, row })));
  const detailRows = $derived(mergeRowsById(rows, matchedRows));
  const rowRevisionFor = (rowId: string): string | undefined =>
    matchedRows.some((row) => row.rowId === rowId) ? matching.data?.pages[0]?.revision : mapRevision;
  const localDetailSelection = $derived(
    resolveCampaignDetailSelection({
      campaignKey: selectedKey,
      knownRevision: rowRevisionFor(selectedSessionId),
      knownRows: detailRows,
      lookup: undefined,
      revision: visibleRevision,
      rowId: selectedSessionId,
    }),
  );
  const selectedLookupRequest = $derived.by(() => {
    if (localDetailSelection.kind !== 'loading' || !visibleRevision) {
      return;
    }
    return optionalSessionLookupRequest(visibleRevision, selectedSessionId);
  });
  const selectedLookup = createQuery(() =>
    optionalSessionLookupQueryOptions(clients.session, selectedLookupRequest, { browser }),
  );
  const detailSelection = $derived(
    resolveCampaignDetailSelection({
      campaignKey: selectedKey,
      knownRevision: rowRevisionFor(selectedSessionId),
      knownRows: detailRows,
      lookup: selectedLookup.data?.ok ? selectedLookup.data.data : undefined,
      revision: visibleRevision,
      rowId: selectedSessionId,
    }),
  );
  const selection = $derived(detailSelection.kind === 'open' ? detailSelection.selection : null);
  const compatibleMemberRows = $derived.by(() => {
    const selectionRevision = selection?.revision;
    if (!selectionRevision) {
      return [];
    }
    return mergeRowsById(
      mapRevision === selectionRevision ? rows : [],
      matching.data?.pages[0]?.revision === selectionRevision ? matchedRows : [],
    );
  });
  const detailNavigationRows = $derived(detailNavigationRowsFor(selection, compatibleMemberRows));
  const detailLookupFailed = $derived(
    detailSelection.kind === 'loading' && (selectedLookup.isError || selectedLookup.data?.ok === false),
  );
  const invalidSessionLink = $derived(
    Boolean(selectedSessionId && visibleRevision && localDetailSelection.kind === 'loading' && !selectedLookupRequest),
  );
  const loadMatches = (): boolean => {
    if (
      !matching.hasNextPage ||
      matching.isFetching ||
      matching.error ||
      exploration.isFetching ||
      !listAnswersRequest
    ) {
      return false;
    }
    loadNextCampaignPage(matching);
    return true;
  };
  const pendingRevision = $derived(latest && visibleRevision && latest.revision !== visibleRevision);
  const isRefreshing = $derived(exploration.isFetching);
  // The shell observes this from its first render, before conditional Retry controls appear.
  const shellBusy = $derived(bootstrapQuery.isFetching || isRefreshing);
  const bootstrapNeedsRecovery = $derived(data.mode === 'live' && (!bootstrap || Boolean(bootstrapQuery.error)));
  // A healthy alias revalidation must not disable a Retry on the already inspected revision.
  const recoveryBusy = $derived(isRefreshing || (bootstrapNeedsRecovery && bootstrapQuery.isFetching));

  $effect(() => {
    if (
      browser &&
      window.matchMedia('(min-width: 1024px)').matches &&
      (explorationState.mapNavigation.focusKey ||
        (explorationState.mapNavigation.anchor && explorationState.mapNavigation.anchor.key !== root?.rowId))
    ) {
      explorationState.mobileMap = true;
    }
  });

  $effect(() => {
    if (!explorationState.inspected && latest) {
      explorationState.inspected = latest;
    }
  });
  $effect(() => {
    explorationState.followScope(scope);
  });
  $effect(() => {
    requestedCampaign = selectedKey;
    if (!explorationState.automaticCampaign && listAnswersRequest && items[0]) {
      explorationState.automaticCampaign = items[0].campaignKey;
    }
  });
  $effect(() => {
    if (
      exploration.data &&
      !exploration.isPlaceholderData &&
      retainedCampaignQuery<CampaignExplorationData>(queryClient, options.queryKey) === exploration.data
    ) {
      previousKey = options.queryKey;
      pruneCampaignExplorations(queryClient, options.queryKey);
      if (
        (explorationState.timelineAxis?.context !== timelineContext || !explorationState.timelineAxis?.axis) &&
        timeline.axis
      ) {
        explorationState.timelineAxis = { context: timelineContext, axis: timeline.axis };
      }
    }
  });
  $effect(() => {
    if (
      data.mode === 'live' &&
      (exploration.error instanceof SessionRevisionExpiredError ||
        (selectedLookup.data?.ok === false && selectedLookup.data.error.tag === 'RevisionExpired')) &&
      revision &&
      checkedExpiredRevision !== revision
    ) {
      checkedExpiredRevision = revision;
      bootstrapQuery.refetch();
    }
  });
  const loadCampaigns = (): boolean => {
    if (!hasMoreCampaigns || isRefreshing || exploration.error || !listAnswersRequest) {
      return false;
    }
    explorationState.topDepth = listPages.length + 1;
    return true;
  };
  const loadMembers = (): boolean => {
    if (!hasMoreSessions || isRefreshing || exploration.error || !listAnswersRequest) {
      return false;
    }
    explorationState.memberDepths = { ...explorationState.memberDepths, [selectedKey]: memberPages.length + 1 };
    return true;
  };
  const refresh = (): void => {
    if (!latest) {
      return;
    }
    explorationState.refresh(
      campaignRefreshFor({
        campaignView,
        items,
        latest,
        listPageCount: listPages.length,
        matchedRows,
        matchingDepth: search.q && matching.data ? matching.data.pages.length : null,
        memberPageCount: memberPages.length,
        navigation: explorationState,
        rows,
        selectedKey,
        selectedSessionId,
      }),
    );
  };
  beforeNavigate(focusRestoration.beforeNavigate);
  afterNavigate(() => {
    focusRestoration.restoreFocus().catch(campaignNavigation.focusFailed);
  });
  onDestroy(focusRestoration.destroy);
  const retry = async (): Promise<void> => {
    if (recoveryBusy) {
      return;
    }
    if (bootstrapNeedsRecovery) {
      // Recover the dependency through its existing Query observer. A valid bootstrap enables
      // exploration reactively; an imperative follow-up would duplicate that acquisition.
      await bootstrapQuery.refetch({ cancelRefetch: false });
    } else if (revision !== undefined) {
      await exploration.refetch({ cancelRefetch: false });
    }
  };
  // Back/Forward and a reload return to the exploration the reader left: SvelteKit stores this per
  // history entry and serialises it with the app transport. The id outlives a rebuild, where the
  // default call-site id would change with the chunk hashes.
  snapshot({ capture: explorationState.capture, id: 'campaigns-page', restore: explorationState.restore });
</script>

<svelte:head><title>Campaigns · ai-usage</title></svelte:head>

<main aria-busy={shellBusy} class={pageClass} data-report-revision={visibleRevision} data-route-shell="campaigns">
  <div class={shell}>
    <WorkspaceHeader
      description="Follow related sessions from intent to execution. Select a campaign to explore its agents and their recorded chronology."
      eyebrow="Agent work"
      heading="Campaigns"
    />
    <nav aria-label="Campaign view" class={viewControls}>
      <button
        aria-pressed={campaignView === 'list' ? 'true' : 'false'}
        class={css(ghostButtonStyle, campaignView === 'list' && activeViewButton)}
        onclick={() => selectView('list')}
        type="button"
      >
        Agent Map
      </button>
      <button
        aria-pressed={campaignView === 'timeline' ? 'true' : 'false'}
        class={css(ghostButtonStyle, campaignView === 'timeline' && activeViewButton)}
        onclick={() => selectView('timeline')}
        type="button"
      >
        Project timeline
      </button>
    </nav>
    <form class={toolbar} onsubmit={applyFilters}>
      <label class={field}
        >Find a campaign<input
          class={input}
          name="q"
          placeholder="Title, project, model…"
          title="Search matches source title text, project and model. Display titles omit some Markdown formatting."
          type="search"
          value={search.q}
        ></label
      >
      <label class={field}
        >Period<select class={input} name="range" value={search.range.mode}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="all">All history</option>
          {#if search.range.mode === 'custom'}
            <option value="custom">Custom: {search.range.from ?? 'start'} – {search.range.to ?? 'end'}</option>
          {/if}
        </select></label
      >
      <label class={field}
        >Harness<select class={input} name="harness" value={harnessSelection}>
          {#if search.harness.length > 1}
            <option value={MULTIPLE_HARNESSES}>Multiple harnesses ({search.harness.join(', ')})</option>
          {/if}
          <option value="">All harnesses</option>
          <option>Codex</option>
          <option>Claude</option>
          <option>OpenCode</option>
          <option>Cursor</option>
        </select></label
      >
      <button class={ghostButton} type="submit">Apply filters</button>
    </form>
    {#if inheritedFilters.length > 0}
      <p class={notice}>
        Other filters: {inheritedFilters.join(' · ')}
        <button class={ghostButton} onclick={clearFilters} type="button">Clear all filters</button>
      </p>
    {/if}
    {#if data.mode !== 'live'}
      <p class={notice}>Synthetic demonstration · no local history is read.</p>
    {/if}
    {#if campaignNavigation.navigationError}
      <p class={notice} role="alert">{campaignNavigation.navigationError}</p>
    {/if}
    {#if detailSelection.kind === 'missing' || invalidSessionLink}
      <p class={notice} data-session-route-status="missing" role="status">
        This session is not part of the selected campaign in this report revision.
        <button class={ghostButton} onclick={() => changeSelection(null)} type="button">Close session details</button>
      </p>
    {:else if detailLookupFailed}
      <p class={notice} data-session-route-status="failed" role="status">
        {selectedLookup.data?.ok === false
          ? selectedLookup.data.error.message
          : 'The selected session could not be loaded.'}
        <button class={ghostButton} onclick={() => selectedLookup.refetch()} type="button">Retry session</button>
        <button class={ghostButton} onclick={() => changeSelection(null)} type="button">Close session details</button>
      </p>
    {:else if detailSelection.kind === 'loading'}
      <p class={notice} data-session-route-status="loading" role="status">Loading session details…</p>
    {/if}
    {#if urlSelection.status === 'invalid'}
      <p class={notice} role="status">
        The campaign link is invalid. Showing recent campaigns.
        <button class={ghostButton} onclick={clearSelection} type="button">Clear selection</button>
      </p>
    {/if}
    {#if bootstrapUnavailable || bootstrapQuery.error || exploration.error}
      <div class={notice} role="status">
        {bootstrapQuery.error?.message ?? bootstrapUnavailable ?? exploration.error?.message}
        <button aria-busy={recoveryBusy} class={ghostButton} disabled={recoveryBusy} onclick={retry} type="button">
          Retry
        </button>
      </div>
    {/if}
    {#if labelsQuery.error}
      <p class={notice} role="status">Saved campaign labels are unavailable. Showing derived titles.</p>
    {/if}
    {#if data.mode === 'live' && bootstrapQuery.isPending}
      <p aria-live="polite" class={notice} role="status">Loading report…</p>
    {/if}
    {#if listPages.length > 0 && !listAnswersRequest}
      <p class={notice} role="status">
        Showing last loaded campaigns. The requested filters or revision are
        {exploration.isFetching ? 'loading' : 'unavailable'}.
      </p>
    {/if}
    {#if pendingRevision}
      <p class={notice} role="status">
        New data is available. Your current exploration is preserved.
        <button class={ghostButton} disabled={isRefreshing} onclick={refresh} type="button">Apply new data</button>
      </p>
    {/if}
    {#if exploration.error}
      <button class={ghostButton} onclick={restart} type="button">Return to latest results</button>
    {/if}
    {#if visible?.missingAnchors.length}
      <p class={notice} role="status">
        An earlier position is no longer present. Showing the remaining campaign context.
      </p>
    {/if}
    {#snippet listFooter()}
      <div class={notice}>
        {#if exploration.error}
          <span role="status">More campaigns are unavailable.</span>
          <button aria-busy={recoveryBusy} class={ghostButton} disabled={recoveryBusy} onclick={retry} type="button">
            Retry campaigns
          </button>
        {:else if isRefreshing}
          <span role="status">Loading campaigns…</span>
        {:else if hasMoreCampaigns}
          More campaigns appear as you scroll.
        {:else}
          End of results · {items.length} campaigns
        {/if}
      </div>
    {/snippet}
    {#snippet membersFooter()}
      <div class={notice}>
        {#if exploration.error}
          <span role="status">More sessions are unavailable.</span>
          <button aria-busy={recoveryBusy} class={ghostButton} disabled={recoveryBusy} onclick={retry} type="button">
            Retry sessions
          </button>
        {:else if isRefreshing}
          <span role="status">Loading campaign sessions…</span>
        {:else if hasMoreSessions}
          More sessions appear as you scroll.
        {:else}
          End of campaign · {map?.totalCount ?? 0} sessions
        {/if}
      </div>
    {/snippet}
    {#if search.q && matchedRows.length > 0}
      <section aria-label="Matching sessions" class={notice}>
        <p>
          {matching.data?.pages[0]?.itemCount ?? 0}
          matching sessions in the selected campaign · search covers all its stored sessions.
        </p>
        {#if !explorationState.searchExpanded}
          {#each matchedRows.slice(0, 3) as row (row.rowId)}
            <button class={ghostButton} data-matching-row-id={row.rowId} onclick={() => openSession(row)} type="button">
              Open matching session {displayTitle(row.name || row.sessionLabel)}
            </button>
          {/each}
        {/if}
        {#if matchedRows.length > 3 || matching.hasNextPage || explorationState.searchExpanded}
          <button
            class={ghostButton}
            onclick={() => (explorationState.searchExpanded = !explorationState.searchExpanded)}
            type="button"
          >
            {explorationState.searchExpanded ? 'Return to full campaign' : 'Explore matching sessions'}
          </button>
        {/if}
      </section>
    {:else if search.q && matching.error}
      <p class={notice} role="status">
        Matching sessions are unavailable.
        <button class={ghostButton} onclick={() => matching.refetch()} type="button">Retry search</button>
      </p>
    {/if}
    {#if explorationState.searchExpanded && search.q}
      <CampaignVirtualList
        estimate={90}
        label="Matching session results"
        onNearEnd={loadMatches}
        rows={matchRows}
        surface="search"
        bind:this={focusRestoration.searchVirtualList}
        bind:navigation={explorationState.searchNavigation}
      >
        {#snippet children(
          _entry,
        )}
          <button
            class={card}
            data-matching-row-id={_entry.row.rowId}
            onclick={() => openSession(_entry.row)}
            type="button"
          >
            Open matching session {displayTitle(_entry.row.name || _entry.row.sessionLabel)}
          </button>
        {/snippet}
        {#snippet footer()}
          {#if matching.error}
            <p role="status">More matching sessions are unavailable.</p>
            <button class={ghostButton} onclick={() => loadNextCampaignPage(matching)} type="button">
              Retry search
            </button>
          {:else if matching.isFetching}
            <p role="status">Loading matching sessions…</p>
          {:else if !matching.hasNextPage}
            <p>End of matching sessions</p>
          {/if}
        {/snippet}
      </CampaignVirtualList>
    {:else if campaignView === 'timeline'}
      {#if visible && (visible.timelineRange.from === null || visible.timelineRange.to === null)}
        <button
          class={ghostButton}
          onclick={() =>
            (explorationState.timelineAxis = {
              context: timelineContext,
              axis: buildCampaignTimeline(items, visible.timelineRange).axis,
            })}
          type="button"
        >
          Fit loaded campaigns
        </button>
      {/if}
      <CampaignProjectTimeline
        campaignPages={listPages.map((entry) => entry.items.map((item) => item.campaignKey))}
        footer={listFooter}
        {hasMoreSessions}
        labelFor={(key, label) => campaignDisplayLabelFor(labels, key, label)}
        map={timelineMap}
        mapError={exploration.error?.message ?? null}
        mapLoading={isRefreshing}
        onLoadMoreCampaigns={loadCampaigns}
        onLoadMoreSessions={() => {
          if (exploration.error) {
            retry();
            return false;
          }
          return loadMembers();
        }}
        onOpenSession={openSession}
        onSelectCampaign={selectCampaign}
        selectedCampaignKey={selectedKey}
        {timeline}
        bind:collapsedProjects={explorationState.collapsedProjects}
        bind:expansion={explorationState.expansion}
        bind:navigation={explorationState.timelineNavigation}
        bind:virtualList={focusRestoration.timelineVirtualList}
      />
      <p class={notice}>
        {items.length}
        of {listPages[0]?.itemCount ?? 0} campaigns loaded. Campaign discovery uses recorded activity; bars show
        recorded chronology.
      </p>
      {#if selectedKey && memberPages.length > 0 && !root && !isRefreshing}
        <p class={notice} role="status">
          This campaign is unavailable in the current served revision.
          <button class={ghostButton} onclick={clearSelection} type="button">Clear selection</button>
        </p>
      {/if}
      {#if selectedKey && !selectedItem && map}
        <p class={notice}>
          The selected campaign is outside the loaded results.
          <button class={ghostButton} onclick={() => selectView('list')} type="button">Open Agent Map</button>
        </p>
      {/if}
    {:else}
      <button
        class={mobileBack}
        onclick={() => (explorationState.mobileMap = !explorationState.mobileMap)}
        type="button"
      >
        {explorationState.mobileMap ? 'Back to campaigns' : 'View selected campaign'}
      </button>
      <div class={layout} data-mobile-map={explorationState.mobileMap ? 'true' : 'false'}>
        <section aria-label="Recent campaigns" class={campaignList} data-campaign-list>
          <p class={muted}>{items.length} of {listPages[0]?.itemCount ?? 0} campaigns · most recent first</p>
          <CampaignVirtualList
            estimate={150}
            footer={listFooter}
            label="Recent campaign results"
            onNearEnd={loadCampaigns}
            rows={virtualCampaigns}
            surface="list"
            bind:navigation={explorationState.listNavigation}
          >
            {#snippet children(
              _entry,
            )}
              {@const item = _entry.item}
              <button
                aria-pressed={item.campaignKey === selectedKey ? 'true' : 'false'}
                class={css(cardStyle, item.campaignKey === selectedKey && activeCard)}
                data-campaign-card
                data-campaign-key={item.campaignKey}
                onclick={() => selectCampaign(item.campaignKey)}
                type="button"
              >
                <span class={title}
                  >{campaignDisplayLabelFor(labels, item.campaignKey, campaignMapTitle(item.row))}</span
                >
                <span class={muted}>{item.row.projectLabel} · {item.row.harness}</span>
                <span class={muted} title="Last recorded activity">{recordedAt(item.row)}</span>
                <span class={muted}
                  >{sessionCount(item.row)}
                  ·
                  {item.row.partial || item.row.usageUnavailable ? '≥ ' : ''}
                  {fmtCompact(item.row.tokenTotal)}
                  recorded tokens{item.row.campaignVisibleCount === item.row.campaignTotalCount
                    ? ''
                    : ' in filter'}</span
                >
              </button>
            {/snippet}
          </CampaignVirtualList>
        </section>
        <div class={detail} data-map-revision={mapRevision}>
          {#if map && presentedMap}
            <p class={muted}>{root?.projectLabel} · {map.harnesses.join(' · ')}</p>
            {#if selectedItem && (selectedItem.row.campaignVisibleCount ?? map.totalCount) < map.totalCount}
              <p class={muted}>{sessionCount(selectedItem.row)} match the list filters. Map scope: full campaign.</p>
            {/if}
            <CampaignAgentMap
              footer={membersFooter}
              map={presentedMap}
              onNearEnd={loadMembers}
              onOpen={openSession}
              bind:collapsed={explorationState.collapsedNodes}
              bind:navigation={explorationState.mapNavigation}
              bind:virtualList={focusRestoration.mapVirtualList}
            />
          {:else if isRefreshing}
            <p role="status">Loading campaign hierarchy…</p>
          {:else if selectedKey}
            <p role="status">This campaign is unavailable in the current served revision.</p>
          {:else}
            <p>Select a campaign to inspect its Agent Map.</p>
          {/if}
        </div>
      </div>
    {/if}
    {#if items.length === 0 && !isRefreshing}
      <div class={empty}>No campaigns match this period and search. Try a wider period or clear the search.</div>
    {/if}
    {#if timelineMap && mapRevision}
      <button class={ghostButton} onclick={toggleReplay} type="button">
        {replayOpen ? 'Hide campaign replay' : 'Show campaign replay'}
      </button>
      {#if replayOpen}
        {#if replayComponent}
          {@const CampaignReplay = replayComponent}
          {#key JSON.stringify([timelineMap.campaignKey, mapRevision])}
            <CampaignReplay client={clients.session} map={timelineMap} onOpen={openSession} revision={mapRevision} />
          {/key}
        {:else if replayLoadFailed}
          <p role="alert">The replay could not load. Close and reopen it to retry.</p>
        {:else}
          <p role="status">Loading campaign replay…</p>
        {/if}
      {/if}
    {/if}
    <SessionDetailQuerySlot
      client={clients.session}
      memberRows={compatibleMemberRows}
      onSelectionChange={changeSelection}
      onSelectMember={openSession}
      {queryClient}
      rows={detailNavigationRows}
      {selection}
    />
  </div>
</main>
