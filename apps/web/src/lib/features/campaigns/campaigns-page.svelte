<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits string ARIA states verified by the browser regressions -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import { buildCampaignMap, campaignMapTitle } from '@ai-usage/report-core/campaign-map';
  import {
    type SessionPresentationRow,
    type SessionQueryRequest,
    sessionQueryFingerprint,
  } from '@ai-usage/report-core/session-query';
  import {
    createInfiniteQuery,
    createQuery,
    keepPreviousData,
    type QueryKey,
    useQueryClient,
  } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { campaignLabelFor, indexCampaignLabelOverrides } from '../../../campaign-label-overrides';
  import { campaignMapFixtureGeneratedAt } from '../../../campaign-map-fixture';
  import { type DashboardSearch, dashboardSearchDefaultsFor } from '../../../dashboard-search';
  import { sessionAnalysisTargetForSession } from '../../../session-analysis-target';
  import { dashboardUrlFor, parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
  import { fmtCompact } from '../../foundation/presentation/format';
  import { loadNextCampaignPage, retainedCampaignQuery } from '../../query/options/campaigns';
  import { campaignLabelOverridesQueryOptions, reportBootstrapQueryOptions } from '../../query/options/report';
  import { SessionRevisionExpiredError } from '../../query/options/session-window';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { createSessionClientAdapter } from '../../rpc/session-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import SessionDetailQuerySlot from '../sessions/detail/session-detail-query-slot.svelte';
  import type { SessionSelectionInput } from '../sessions/detail/types';
  import { dashboardSearchCodec } from '../shell/navigation';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import CampaignAgentMap from './campaign-agent-map.svelte';
  import CampaignProjectTimeline from './campaign-project-timeline.svelte';
  import { buildCampaignTimeline } from './campaign-timeline-model';
  import type { CampaignsPageData } from './campaigns-load';
  import { campaignMembersOptions, campaignsListOptions, campaignsRequest } from './campaigns-query';
  import { readCampaignSelection } from './campaigns-selection';
  import { createSyntheticCampaignClient } from './campaigns-synthetic';

  const MULTIPLE_HARNESSES = 'inherited-harnesses';

  let { data }: { data: CampaignsPageData } = $props();
  const queryClient = useQueryClient();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const clients = untrack(() => {
    const report =
      browser && rpc
        ? createReportClient(rpc)
        : ssrUnavailableClient<ReturnType<typeof createReportClient>>('campaigns report');
    if (data.mode !== 'live') {
      return { report, session: createSyntheticCampaignClient() };
    }
    const session =
      browser && rpc
        ? createSessionClientAdapter(rpc.session)
        : ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('campaigns session');
    return { report, session };
  });
  let selection = $state<SessionSelectionInput | null>(null);
  let navigationError = $state<string | null>(null);
  let previousListKey = $state<QueryKey>();
  let previousListRequest = $state<SessionQueryRequest>();
  let previousMembersKey = $state<{ campaignKey: string; queryKey: QueryKey }>();
  let recoveredExpiredRevision = $state<string>();
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
  const revision = $derived(data.mode === 'live' ? bootstrap?.manifest.revision : 'synthetic-campaign-map-v1');
  const generatedAt = $derived(bootstrap?.bootstrap.support.generatedAt ?? campaignMapFixtureGeneratedAt);
  const search = $derived(parseDashboardSearchUrl(page.url, dashboardSearchCodec));
  const harnessSelection = $derived(search.harness.length > 1 ? MULTIPLE_HARNESSES : (search.harness[0] ?? ''));
  const campaignView = $derived(page.url.searchParams.get('campaignView') === 'timeline' ? 'timeline' : 'list');
  const inheritedFilters = $derived([
    ...Object.entries(search.filters).map(([name, value]) => `${name}: ${value}`),
    ...search.machine.map((value) => `machine: ${value}`),
    ...search.origin.map((value) => `origin: ${value}`),
    ...(search.timeCell ? [`local time: ${search.timeCell}`] : []),
  ]);
  const request = $derived(campaignsRequest(search, generatedAt, revision ?? 'pending-campaigns'));
  const listQuery = createInfiniteQuery(() => ({
    ...campaignsListOptions(clients.session, request),
    enabled: browser && revision !== undefined,
    placeholderData: keepPreviousData,
  }));
  const listData = $derived(
    listQuery.data ?? retainedCampaignQuery<NonNullable<typeof listQuery.data>>(queryClient, previousListKey),
  );
  const listPages = $derived(listData?.pages ?? []);
  const items = $derived(listPages.flatMap((entry) => entry.items));
  const visibleRevision = $derived(listPages[0]?.revision);
  const listAnswersRequest = $derived(
    visibleRevision === request.revision && listPages[0]?.requestFingerprint === sessionQueryFingerprint(request),
  );
  const visibleListRequest = $derived.by(() => {
    if (listAnswersRequest) {
      return request;
    }
    if (
      previousListRequest &&
      previousListRequest.revision === visibleRevision &&
      listPages[0]?.requestFingerprint === sessionQueryFingerprint(previousListRequest)
    ) {
      return previousListRequest;
    }
    return null;
  });
  const timeline = $derived(buildCampaignTimeline(items, visibleListRequest?.range ?? { from: null, to: null }));
  const urlSelection = $derived(readCampaignSelection(page.url, request));
  const selectedKey = $derived(
    urlSelection.status === 'selected' ? urlSelection.campaignKey : (items[0]?.campaignKey ?? ''),
  );
  const selectedItem = $derived(items.find((item) => item.campaignKey === selectedKey));
  const membersQuery = createInfiniteQuery(() => ({
    ...campaignMembersOptions(
      clients.session,
      visibleRevision ?? 'pending-campaigns',
      selectedKey || 'pending-campaign-selection',
    ),
    enabled: browser && visibleRevision !== undefined && selectedKey.length > 0,
    placeholderData: (previous) => (previous?.pages[0]?.campaignKey === selectedKey ? previous : undefined),
  }));
  const memberData = $derived(
    membersQuery.data ??
      (previousMembersKey?.campaignKey === selectedKey
        ? retainedCampaignQuery<NonNullable<typeof membersQuery.data>>(queryClient, previousMembersKey.queryKey)
        : undefined),
  );
  const memberPages = $derived(memberData?.pages ?? []);
  const root = $derived(memberPages[0]?.root);
  const mapRevision = $derived(memberPages[0]?.revision);
  const map = $derived(
    root
      ? buildCampaignMap({
          campaignKey: selectedKey,
          children: memberPages.flatMap((entry) => entry.items),
          root,
          totalCount: (memberPages[0]?.itemCount ?? 0) + 1,
        })
      : null,
  );
  const rows = $derived(map?.nodes.map((node) => node.row) ?? []);
  const presentedMap = $derived(map ? { ...map, title: campaignLabelFor(labels, selectedKey, map.title) } : null);
  const timelineMap = $derived(mapRevision === visibleRevision ? presentedMap : null);
  const isRefreshing = $derived(listQuery.isFetching || membersQuery.isFetching);
  const recoverExpiredRevision = async (expiredRevision: string): Promise<void> => {
    const refreshed = await bootstrapQuery.refetch();
    if (refreshed.data?.ok && refreshed.data.manifest.revision === expiredRevision) {
      if (listQuery.error instanceof SessionRevisionExpiredError) {
        await listQuery.refetch();
      }
      if (membersQuery.error instanceof SessionRevisionExpiredError) {
        await membersQuery.refetch();
      }
    }
  };
  $effect(() => {
    if (listQuery.data && !listQuery.isPlaceholderData && listAnswersRequest) {
      previousListKey = campaignsListOptions(clients.session, request).queryKey;
      previousListRequest = request;
    }
  });
  $effect(() => {
    if (membersQuery.data && !membersQuery.isPlaceholderData && visibleRevision) {
      previousMembersKey = {
        campaignKey: selectedKey,
        queryKey: campaignMembersOptions(clients.session, visibleRevision, selectedKey).queryKey,
      };
    }
  });
  $effect(() => {
    const expired =
      listQuery.error instanceof SessionRevisionExpiredError ||
      membersQuery.error instanceof SessionRevisionExpiredError;
    if (data.mode === 'live' && expired && revision && recoveredExpiredRevision !== revision) {
      recoveredExpiredRevision = revision;
      recoverExpiredRevision(revision);
    }
  });
  $effect(() => {
    const selected = selection;
    if (selected && (selected.revision !== mapRevision || !rows.some((row) => row.rowId === selected.row.rowId))) {
      selection = null;
    }
  });

  const navigate = async (url: URL): Promise<void> => {
    selection = null;
    navigationError = null;
    try {
      await goto(url, { keepFocus: true, noScroll: true });
    } catch (cause) {
      navigationError = cause instanceof Error ? cause.message : 'Campaign navigation failed.';
    }
  };
  const selectCampaign = (campaignKey: string): void => {
    const url = new URL(page.url);
    url.searchParams.set('selectedCampaign', campaignKey);
    navigate(url);
  };
  const selectView = (view: 'list' | 'timeline'): void => {
    const url = new URL(page.url);
    if (view === 'timeline') {
      url.searchParams.set('campaignView', 'timeline');
    } else {
      url.searchParams.delete('campaignView');
    }
    navigate(url);
  };
  const clearSelection = (): void => {
    const url = new URL(page.url);
    url.searchParams.delete('selectedCampaign');
    navigate(url);
  };
  const clearFilters = (): void => {
    const url = dashboardUrlFor(page.url, dashboardSearchDefaultsFor('date'), dashboardSearchCodec);
    url.searchParams.delete('selectedCampaign');
    navigate(url);
  };
  const applyFilters = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) {
      return;
    }
    const form = new FormData(event.currentTarget);
    const range = form.get('range');
    const harness = String(form.get('harness') ?? '');
    let nextHarness = harness ? [harness] : [];
    if (harness === MULTIPLE_HARNESSES) {
      nextHarness = search.harness;
    }
    const next: DashboardSearch = {
      ...search,
      q: String(form.get('q') ?? ''),
      harness: nextHarness,
      range:
        range === 'custom'
          ? search.range
          : { mode: range === '7d' || range === '90d' || range === 'all' || range === 'today' ? range : '30d' },
    };
    const url = dashboardUrlFor(page.url, next, dashboardSearchCodec);
    url.searchParams.delete('selectedCampaign');
    navigate(url);
  };
  const openSession = (row: SessionPresentationRow): void => {
    if (!mapRevision) {
      return;
    }
    selection = { revision: mapRevision, row, target: sessionAnalysisTargetForSession(row) };
  };
  const changeSelection = (next: SessionSelectionInput | null): void => {
    selection =
      next && mapRevision
        ? { ...next, revision: mapRevision, target: sessionAnalysisTargetForSession(next.row) }
        : null;
  };
  const retry = async (): Promise<void> => {
    if (data.mode === 'live') {
      await bootstrapQuery.refetch();
    }
    await listQuery.refetch();
    if (selectedKey) {
      await membersQuery.refetch();
    }
  };
  const recordedAt = (row: SessionPresentationRow): string => {
    const value = row.activeDate ?? row.endDate ?? row.date;
    const date = new Date(value ?? '');
    if (!Number.isFinite(date.getTime())) {
      return 'Time not recorded';
    }
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      date.getUTCMonth()
    ];
    const clock = date.toISOString().slice(11, 16);
    return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${clock} UTC`;
  };
  const sessionCount = (row: SessionPresentationRow): string => {
    const total = row.campaignTotalCount ?? 1;
    const visible = row.campaignVisibleCount ?? total;
    if (visible !== total) {
      return `${visible} of ${total} sessions`;
    }
    return `${total} ${total === 1 ? 'session' : 'sessions'}`;
  };

  const toolbar = css({ display: 'flex', alignItems: 'end', flexWrap: 'wrap', gap: '12px', mb: '24px' });
  const viewControls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', mb: '20px' });
  const activeViewButton = css({ bg: 'accentTint', borderColor: 'accent', color: 'ink' });
  const field = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '11px' });
  const input = css({
    minH: '40px',
    px: '12px',
    py: '7px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    fontSize: '12px',
    maxW: 'full',
    _focusVisible: { outline: '2px solid token(colors.accent)' },
  });
  const layout = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(230px, 0.38fr) minmax(0, 1fr)' },
    alignItems: 'start',
    gap: '24px',
    minW: 0,
  });
  const campaignList = css({
    display: 'grid',
    gap: '6px',
    minW: 0,
    maxH: { base: '360px', lg: 'calc(100vh - 260px)' },
    overflowY: 'auto',
    pr: '4px',
  });
  const card = css({
    display: 'grid',
    gap: '7px',
    p: '14px',
    textAlign: 'left',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    cursor: 'pointer',
    minW: 0,
    w: 'full',
    _hover: { bg: 'accentTint' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
  const activeCard = css({ bg: 'accentTint', borderColor: 'accent' });
  const title = css({ fontSize: '13px', fontWeight: 600, lineHeight: 1.45, overflowWrap: 'anywhere' });
  const muted = css({ color: 'muted', fontSize: '11px', lineHeight: 1.55 });
  const detail = css({
    display: 'grid',
    gap: '16px',
    minW: 0,
    border: '1px solid token(colors.line)',
    borderRadius: 'lg',
    p: { base: '16px', md: '24px' },
    bg: 'surface',
  });
  const empty = css({
    display: 'grid',
    gap: '12px',
    p: '24px',
    border: '1px dashed token(colors.lineStrong)',
    borderRadius: 'md',
    color: 'muted',
    fontSize: '13px',
    lineHeight: 1.7,
  });
  const notice = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6, mb: '12px' });
</script>

<svelte:head><title>Campaigns · ai-usage</title></svelte:head>

<main class={pageClass} data-report-revision={visibleRevision} data-route-shell="campaigns">
  <div class={shell}>
    <WorkspaceHeader
      description="Follow related sessions from intent to execution. Select a campaign to explore its agents and their recorded chronology."
      eyebrow="Agent work"
      heading="Campaigns"
    />
    <nav aria-label="Campaign view" class={viewControls}>
      <button
        aria-pressed={campaignView === 'list' ? 'true' : 'false'}
        class={cx(ghostButton, campaignView === 'list' && activeViewButton)}
        onclick={() => selectView('list')}
        type="button"
      >
        Agent Map
      </button>
      <button
        aria-pressed={campaignView === 'timeline' ? 'true' : 'false'}
        class={cx(ghostButton, campaignView === 'timeline' && activeViewButton)}
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
    {#if navigationError}
      <p class={notice} role="alert">{navigationError}</p>
    {/if}
    {#if urlSelection.status === 'invalid'}
      <p class={notice} role="status">
        The campaign link is invalid. Showing recent campaigns.
        <button class={ghostButton} onclick={clearSelection} type="button">Clear selection</button>
      </p>
    {/if}
    {#if bootstrapUnavailable || bootstrapQuery.error || listQuery.error || membersQuery.error}
      <div class={notice} role="status">
        {bootstrapUnavailable ?? bootstrapQuery.error?.message ?? listQuery.error?.message ?? membersQuery.error?.message}
        <button class={ghostButton} onclick={retry} type="button">Retry</button>
      </div>
    {/if}
    {#if labelsQuery.error}
      <p class={notice} role="status">Saved campaign labels are unavailable. Showing derived titles.</p>
    {/if}
    {#if isRefreshing}
      <p aria-live="polite" class={notice} role="status">Updating campaigns…</p>
    {:else if data.mode === 'live' && bootstrapQuery.isPending}
      <p aria-live="polite" class={notice} role="status">Loading report…</p>
    {/if}
    {#if listPages.length > 0 && !listAnswersRequest}
      <p class={notice} role="status">
        Showing last loaded campaigns. The requested filters or revision are
        {listQuery.isFetching ? 'loading' : 'unavailable'}.
      </p>
    {/if}
    {#if campaignView === 'timeline'}
      <CampaignProjectTimeline
        hasMoreSessions={membersQuery.hasNextPage}
        labelFor={(key, label) => campaignLabelFor(labels, key, label)}
        map={timelineMap}
        mapError={membersQuery.error?.message ?? null}
        mapLoading={membersQuery.isFetching || (mapRevision !== visibleRevision && !membersQuery.error)}
        onLoadMoreSessions={() => loadNextCampaignPage(membersQuery)}
        onOpenSession={openSession}
        onSelectCampaign={selectCampaign}
        selectedCampaignKey={selectedKey}
        {timeline}
      />
      <p class={notice}>
        {items.length}
        of {listPages[0]?.itemCount ?? 0} campaigns loaded. Campaigns are discovered by recorded activity in the
        selected period; their bars show the recorded campaign chronology.
      </p>
      {#if selectedKey && membersQuery.isSuccess && !membersQuery.isPlaceholderData && !root}
        <p class={notice} role="status">
          This campaign is unavailable in the current served revision.
          <button class={ghostButton} onclick={clearSelection} type="button">Clear selection</button>
        </p>
      {:else if selectedKey && !selectedItem && (map || items.length > 0)}
        <p class={notice}>
          The selected campaign is outside the loaded results.
          <button class={ghostButton} onclick={() => selectView('list')} type="button">Open Agent Map</button>
        </p>
      {/if}
      {#if listQuery.hasNextPage}
        <button
          class={ghostButton}
          disabled={listQuery.isFetching}
          onclick={() => loadNextCampaignPage(listQuery)}
          type="button"
        >
          Load more campaigns
        </button>
      {/if}
      {#if items.length === 0 && !listQuery.isPending}
        <div class={empty}>No campaigns match this period and search. Try a wider period or clear the search.</div>
      {/if}
    {:else}
      <div class={layout}>
        <section aria-label="Recent campaigns" class={campaignList} data-campaign-list>
          <p class={muted}>{items.length} of {listPages[0]?.itemCount ?? 0} campaigns · most recent first</p>
          {#each items as item (item.campaignKey)}
            <button
              aria-pressed={item.campaignKey === selectedKey ? 'true' : 'false'}
              class={cx(card, item.campaignKey === selectedKey && activeCard)}
              data-campaign-card
              onclick={() => selectCampaign(item.campaignKey)}
              type="button"
            >
              <span class={title}>{campaignLabelFor(labels, item.campaignKey, campaignMapTitle(item.row))}</span>
              <span class={muted}>{item.row.projectLabel} · {item.row.harness}</span>
              <span class={muted} title="Last recorded activity">{recordedAt(item.row)}</span>
              <span class={muted}
                >{sessionCount(item.row)}
                ·
                {item.row.partial || item.row.usageUnavailable ? '≥ ' : ''}
                {fmtCompact(item.row.tokenTotal)}
                recorded tokens{item.row.campaignVisibleCount === item.row.campaignTotalCount ? '' : ' in filter'}</span
              >
            </button>
          {/each}
          {#if listQuery.hasNextPage}
            <button
              class={ghostButton}
              disabled={listQuery.isFetching}
              onclick={() => loadNextCampaignPage(listQuery)}
              type="button"
            >
              Load more campaigns
            </button>
          {/if}
          {#if items.length === 0 && !listQuery.isPending}
            <div class={empty}>No campaigns match this period and search. Try a wider period or clear the search.</div>
          {/if}
        </section>
        {#if map}
          <div class={detail} data-map-revision={mapRevision}>
            <p class={muted}>{root?.projectLabel}· {map.harnesses.join(' · ')}</p>
            {#if selectedItem && listAnswersRequest && mapRevision === visibleRevision && (selectedItem.row.campaignVisibleCount ?? map.totalCount) < map.totalCount}
              <p class={muted}>{sessionCount(selectedItem.row)} match the list filters. Map scope: full campaign.</p>
            {/if}
            {#if mapRevision !== visibleRevision}
              <p class={notice} role="status">Showing the last complete Agent Map while the newer revision loads.</p>
            {/if}
            {#if presentedMap}
              <CampaignAgentMap map={presentedMap} onOpen={openSession} />
            {/if}
            {#if map.omittedCount > 0}
              <p class={notice}>
                {map.omittedCount}
                sessions are not loaded yet. Counts and timing describe the loaded portion.
              </p>
            {/if}
            {#if membersQuery.hasNextPage}
              <button
                class={ghostButton}
                disabled={membersQuery.isFetching}
                onclick={() => loadNextCampaignPage(membersQuery)}
                type="button"
              >
                Load more sessions
              </button>
            {/if}
          </div>
        {:else if membersQuery.isPending && selectedKey}
          <div class={empty} role="status">Loading campaign hierarchy…</div>
        {:else if selectedKey && membersQuery.isSuccess}
          <div class={empty} role="status">
            This campaign is unavailable in the current served revision.
            <button class={ghostButton} onclick={clearSelection} type="button">Show recent campaigns</button>
          </div>
        {:else}
          <div class={empty}>Select a campaign to inspect its Agent Map.</div>
        {/if}
      </div>
    {/if}
    <SessionDetailQuerySlot
      client={clients.session}
      onSelectionChange={changeSelection}
      {queryClient}
      {rows}
      {selection}
    />
  </div>
</main>
