<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits string ARIA states verified by the browser regressions -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import { buildCampaignMap, campaignMapTitle } from '@ai-usage/report-core/campaign-map';
  import { type SessionPresentationRow, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
  import {
    createInfiniteQuery,
    createQuery,
    keepPreviousData,
    type QueryKey,
    useQueryClient,
  } from '@tanstack/svelte-query';
  import { tick, untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { campaignLabelFor, indexCampaignLabelOverrides } from '../../../campaign-label-overrides';
  import { campaignMapFixtureGeneratedAt } from '../../../campaign-map-fixture';
  import { type DashboardSearch, dashboardSearchDefaultsFor } from '../../../dashboard-search';
  import { sessionAnalysisTargetForSession } from '../../../session-analysis-target';
  import { dashboardUrlFor, parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
  import { fmtCompact } from '../../foundation/presentation/format';
  import {
    loadNextCampaignPage,
    pruneCampaignExplorations,
    retainedCampaignOptions,
    retainedCampaignQuery,
  } from '../../query/options/campaigns';
  import { campaignLabelOverridesQueryOptions, reportBootstrapQueryOptions } from '../../query/options/report';
  import { SessionRevisionExpiredError, type SessionWindowIntent } from '../../query/options/session-window';
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
  import { buildCampaignTimeline, type CampaignTimelineAxis } from './campaign-timeline-model';
  import CampaignVirtualList from './campaign-virtual-list.svelte';
  import type { CampaignScrollState } from './campaign-virtual-window';
  import type { CampaignsPageData } from './campaigns-load';
  import {
    type CampaignExplorationAnchors,
    type CampaignExplorationData,
    campaignMatchingMembersOptions,
    campaignsExplorationOptions,
    campaignsListOptions,
    campaignsRequest,
  } from './campaigns-query';
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
  let previousKey = $state<QueryKey>();
  let inspected = $state<{ revision: string; generatedAt: string } | null>(null);
  let topDepth = $state(1);
  let memberDepths = $state<Record<string, number>>({});
  let automaticCampaign = $state('');
  let anchors = $state<CampaignExplorationAnchors>({});
  let matchingRestoration = $state<{ campaignKey: string; depth: number; rowIds: readonly string[] } | null>(null);
  let listNavigation = $state<CampaignScrollState>({});
  let mapNavigation = $state<CampaignScrollState>({});
  let timelineNavigation = $state<CampaignScrollState>({});
  let collapsedNodes = $state<ReadonlySet<string>>(new Set());
  let collapsedProjects = $state<ReadonlySet<string>>(new Set());
  let expansion = $state<{ key: string; open: boolean } | null>(null);
  let timelineAxis = $state<CampaignTimelineAxis | null>(null);
  let mapVirtualList = $state<{ focusKey: (key: string) => Promise<boolean> }>();
  let timelineVirtualList = $state<{ focusKey: (key: string) => Promise<boolean> }>();
  let mobileMap = $state(false);
  let searchExpanded = $state(false);
  let searchNavigation = $state<CampaignScrollState>({});
  let searchVirtualList = $state<{ focusKey: (key: string) => Promise<boolean> }>();
  let pendingFocus = '';
  let checkedExpiredRevision = '';
  let previousScope = '';
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
  const latest = $derived.by(() => {
    if (data.mode !== 'live') {
      return { revision: 'synthetic-campaign-map-v1', generatedAt: campaignMapFixtureGeneratedAt };
    }
    return bootstrap
      ? { revision: bootstrap.manifest.revision, generatedAt: bootstrap.bootstrap.support.generatedAt }
      : null;
  });
  const revision = $derived(inspected?.revision ?? latest?.revision);
  const search = $derived(parseDashboardSearchUrl(page.url, dashboardSearchCodec));
  const scope = $derived(JSON.stringify(search));
  const harnessSelection = $derived(search.harness.length > 1 ? MULTIPLE_HARNESSES : (search.harness[0] ?? ''));
  const campaignView = $derived(page.url.searchParams.get('campaignView') === 'timeline' ? 'timeline' : 'list');
  const inheritedFilters = $derived([
    ...Object.entries(search.filters).map(([name, value]) => `${name}: ${value}`),
    ...search.machine.map((value) => `machine: ${value}`),
    ...search.origin.map((value) => `origin: ${value}`),
    ...(search.timeCell ? [`local time: ${search.timeCell}`] : []),
  ]);
  const request = $derived(
    campaignsRequest(
      search,
      inspected?.generatedAt ?? latest?.generatedAt ?? campaignMapFixtureGeneratedAt,
      revision ?? 'pending-campaigns',
    ),
  );
  const urlSelection = $derived(readCampaignSelection(page.url, request));
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
    topLevelDepth: topDepth,
    campaignChildrenDepth: {},
    campaignSessionsDepth: requestedCampaign ? { [requestedCampaign]: memberDepths[requestedCampaign] ?? 1 } : {},
  });
  const options = $derived(
    campaignsExplorationOptions({
      client: clients.session,
      queryClient,
      request,
      intent,
      anchors,
      ...(matchingRestoration ? { matching: matchingRestoration } : {}),
    }),
  );
  const exploration = createQuery(() => ({
    ...options,
    enabled: browser && revision !== undefined,
    placeholderData: keepPreviousData,
  }));
  const retained = createQuery(() => retainedCampaignOptions<CampaignExplorationData>(previousKey));
  const visible = $derived(exploration.data ?? retained.data);
  const listPages = $derived(visible?.list.pages ?? []);
  const items = $derived(listPages.flatMap((entry) => entry.items));
  const virtualCampaigns = $derived(items.map((item) => ({ key: item.campaignKey, item })));
  const selectedKey = $derived(
    urlSelection.status === 'selected' ? urlSelection.campaignKey : automaticCampaign || items[0]?.campaignKey || '',
  );
  const selectedItem = $derived(items.find((item) => item.campaignKey === selectedKey));
  const visibleRevision = $derived(visible?.request.revision);
  const listAnswersRequest = $derived(
    visibleRevision === request.revision &&
      visible &&
      sessionQueryFingerprint(visible.request) === sessionQueryFingerprint(request),
  );
  const timeline = $derived(
    buildCampaignTimeline(items, visible?.request.range ?? { from: null, to: null }, timelineAxis),
  );
  const memberPages = $derived(visible?.members.find((entry) => entry.campaignKey === selectedKey)?.data.pages ?? []);
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
  const detailRows = $derived.by(() => {
    const known = new Map(rows.map((row) => [row.rowId, row]));
    for (const row of matchedRows) {
      known.set(row.rowId, row);
    }
    return [...known.values()];
  });
  const rowRevisionFor = (rowId: string): string | undefined =>
    matchedRows.some((row) => row.rowId === rowId) ? matching.data?.pages[0]?.revision : mapRevision;
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

  $effect(() => {
    if (
      browser &&
      window.matchMedia('(min-width: 1024px)').matches &&
      (mapNavigation.focusKey || (mapNavigation.anchor && mapNavigation.anchor.key !== root?.rowId))
    ) {
      mobileMap = true;
    }
  });

  $effect(() => {
    if (!inspected && latest) {
      inspected = latest;
    }
  });
  $effect(() => {
    if (previousScope && previousScope !== scope) {
      automaticCampaign = '';
      searchExpanded = false;
      searchNavigation = {};
      topDepth = 1;
      memberDepths = {};
      anchors = {};
      matchingRestoration = null;
      timelineAxis = null;
      listNavigation = {};
      mapNavigation = {};
      timelineNavigation = {};
      collapsedNodes = new Set();
      collapsedProjects = new Set();
    }
    previousScope = scope;
  });
  $effect(() => {
    requestedCampaign = selectedKey;
    if (!automaticCampaign && listAnswersRequest && items[0]) {
      automaticCampaign = items[0].campaignKey;
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
      if (!timelineAxis && timeline.axis) {
        timelineAxis = timeline.axis;
      }
    }
  });
  $effect(() => {
    const row = detailRows.find((entry) => entry.rowId === selectedSessionId);
    const selectedRevision = rowRevisionFor(selectedSessionId);
    if (row && selectedRevision) {
      selection = { row, revision: selectedRevision, target: sessionAnalysisTargetForSession(row) };
    } else if (!selectedSessionId) {
      selection = null;
    } else if (visible?.missingAnchors.includes(selectedSessionId)) {
      selection = null;
      navigationError = 'The selected session is no longer present in this revision. The campaign remains available.';
    }
  });
  // A bookmark restores bounded selection, not an unbounded download of earlier pages.
  $effect(() => {
    if (
      selectedKey &&
      selectedSessionId &&
      !selection &&
      !exploration.error &&
      !anchors.memberRowIds?.[selectedKey]?.includes(selectedSessionId)
    ) {
      anchors = { ...anchors, memberRowIds: { [selectedKey]: [selectedSessionId] } };
    }
  });
  $effect(() => {
    if (
      data.mode === 'live' &&
      exploration.error instanceof SessionRevisionExpiredError &&
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
    topDepth = listPages.length + 1;
    return true;
  };
  const loadMembers = (): boolean => {
    if (!hasMoreSessions || isRefreshing || exploration.error || !listAnswersRequest) {
      return false;
    }
    memberDepths = { ...memberDepths, [selectedKey]: memberPages.length + 1 };
    return true;
  };
  const refresh = (): void => {
    if (!latest) {
      return;
    }
    matchingRestoration =
      search.q && matching.data
        ? {
            campaignKey: selectedKey,
            depth: matching.data.pages.length,
            rowIds: [searchNavigation.anchor?.key, selectedSessionId].filter(
              (key): key is string => Boolean(key) && matchedRows.some((row) => row.rowId === key),
            ),
          }
        : null;
    const campaignAnchor = listNavigation.anchor?.key;
    const timelineAnchor = timelineNavigation.anchor?.key;
    let timelineCampaignAnchor: string | undefined;
    if (timelineAnchor?.startsWith('campaign:')) {
      timelineCampaignAnchor = timelineAnchor.slice('campaign:'.length);
    } else if (timelineAnchor?.startsWith('project-continuation:')) {
      timelineCampaignAnchor = timelineAnchor.slice('project-continuation:'.length);
    } else if (timelineAnchor?.startsWith('project:')) {
      timelineCampaignAnchor = items.find(
        (item) => item.row.projectKey === timelineAnchor.slice('project:'.length),
      )?.campaignKey;
    } else if (timelineAnchor && rows.some((row) => row.rowId === timelineAnchor)) {
      timelineCampaignAnchor = selectedKey;
    }
    const memberAnchor = campaignView === 'timeline' ? timelineNavigation.anchor?.key : mapNavigation.anchor?.key;
    anchors = {
      campaignKeys: [...new Set([campaignAnchor, timelineCampaignAnchor].filter((key): key is string => Boolean(key)))],
      memberRowIds: selectedKey
        ? {
            [selectedKey]: [
              selectedSessionId,
              rows.some((row) => row.rowId === memberAnchor) ? memberAnchor : undefined,
            ].filter((key): key is string => Boolean(key)),
          }
        : {},
    };
    topDepth = Math.max(topDepth, listPages.length);
    memberDepths = { ...memberDepths, [selectedKey]: Math.max(memberDepths[selectedKey] ?? 1, memberPages.length) };
    inspected = latest;
  };
  const restart = (): void => {
    anchors = {};
    matchingRestoration = null;
    topDepth = 1;
    memberDepths = {};
    listNavigation = {};
    mapNavigation = {};
    timelineNavigation = {};
    timelineAxis = null;
    inspected = latest;
    const url = new URL(page.url);
    url.searchParams.delete('selectedSession');
    navigate(url);
  };
  const navigate = async (url: URL): Promise<void> => {
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
    if (campaignKey !== selectedKey) {
      matchingRestoration = null;
      searchNavigation = {};
      url.searchParams.delete('selectedSession');
      mapNavigation = {};
      collapsedNodes = new Set();
    }
    mobileMap = true;
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
    automaticCampaign = '';
    const url = new URL(page.url);
    url.searchParams.delete('selectedCampaign');
    url.searchParams.delete('selectedSession');
    navigate(url);
  };
  const clearFilters = (): void => {
    const url = dashboardUrlFor(page.url, dashboardSearchDefaultsFor('date'), dashboardSearchCodec);
    url.searchParams.delete('selectedCampaign');
    url.searchParams.delete('selectedSession');
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
    url.searchParams.delete('selectedSession');
    navigate(url);
  };

  const openSession = (row: SessionPresentationRow): void => {
    const selectedRevision = rowRevisionFor(row.rowId);
    if (!selectedRevision) {
      return;
    }
    mobileMap = true;
    selection = { revision: selectedRevision, row, target: sessionAnalysisTargetForSession(row) };
    const url = new URL(page.url);
    url.searchParams.set('selectedCampaign', selectedKey);
    url.searchParams.set('selectedSession', row.rowId);
    navigate(url);
  };
  const restoreFocus = async (): Promise<void> => {
    if (!pendingFocus) {
      return;
    }
    const key = pendingFocus;
    pendingFocus = '';
    await tick();
    if (searchExpanded) {
      await searchVirtualList?.focusKey(key);
    } else {
      const direct = document.querySelector<HTMLElement>(`[data-matching-row-id="${CSS.escape(key)}"]`);
      if (direct) {
        direct.focus({ preventScroll: true });
      } else {
        await (campaignView === 'timeline' ? timelineVirtualList : mapVirtualList)?.focusKey(key);
      }
    }
  };
  const changeSelection = (next: SessionSelectionInput | null): void => {
    if (next) {
      openSession(next.row);
      return;
    }
    pendingFocus = selection?.row.rowId ?? selectedSessionId;
    selection = null;
    const url = new URL(page.url);
    url.searchParams.delete('selectedSession');
    navigate(url).then(restoreFocus);
  };
  const retry = async (): Promise<void> => {
    await exploration.refetch();
  };
  export const capture = () => ({
    scope,
    anchors,
    matchingRestoration,
    inspected,
    automaticCampaign,
    topDepth,
    memberDepths,
    listNavigation,
    mapNavigation,
    timelineNavigation,
    timelineAxis,
    collapsedNodes: [...collapsedNodes],
    collapsedProjects: [...collapsedProjects],
    expansion,
    mobileMap,
    searchExpanded,
    searchNavigation,
  });
  export const restore = (saved: ReturnType<typeof capture>): void => {
    previousScope = saved.scope;
    anchors = saved.anchors;
    matchingRestoration = saved.matchingRestoration;
    inspected = saved.inspected;
    automaticCampaign = saved.automaticCampaign;
    topDepth = saved.topDepth;
    memberDepths = saved.memberDepths;
    listNavigation = saved.listNavigation;
    mapNavigation = saved.mapNavigation;
    timelineNavigation = saved.timelineNavigation;
    timelineAxis = saved.timelineAxis;
    collapsedNodes = new Set(saved.collapsedNodes);
    collapsedProjects = new Set(saved.collapsedProjects);
    expansion = saved.expansion;
    mobileMap = saved.mobileMap;
    searchExpanded = saved.searchExpanded;
    searchNavigation = saved.searchNavigation;
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
    '&[data-mobile-map=true] > section': { display: { base: 'none', lg: 'block' } },
    '&[data-mobile-map=false] > div': { display: { base: 'none', lg: 'grid' } },
    minW: 0,
  });
  const mobileBack = css({ display: { base: 'block', lg: 'none' }, p: '12px', color: 'accent', cursor: 'pointer' });
  const campaignList = css({
    display: 'grid',
    gap: '6px',
    minW: 0,
    '& [data-campaign-scroll]': { h: { base: '65dvh', lg: 'calc(100dvh - 330px)' } },
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
    {#if bootstrapUnavailable || bootstrapQuery.error || exploration.error}
      <div class={notice} role="status">
        {bootstrapUnavailable ?? bootstrapQuery.error?.message ?? exploration.error?.message}
        <button class={ghostButton} onclick={retry} type="button">Retry</button>
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
          <button class={ghostButton} onclick={retry} type="button">Retry campaigns</button>
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
          <button class={ghostButton} onclick={retry} type="button">Retry sessions</button>
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
        {#if !searchExpanded}
          {#each matchedRows.slice(0, 3) as row (row.rowId)}
            <button class={ghostButton} data-matching-row-id={row.rowId} onclick={() => openSession(row)} type="button">
              Open matching session {row.name || row.sessionLabel}
            </button>
          {/each}
        {/if}
        {#if matchedRows.length > 3 || matching.hasNextPage || searchExpanded}
          <button class={ghostButton} onclick={() => searchExpanded = !searchExpanded} type="button">
            {searchExpanded ? 'Return to full campaign' : 'Explore matching sessions'}
          </button>
        {/if}
      </section>
    {:else if search.q && matching.error}
      <p class={notice} role="status">
        Matching sessions are unavailable.
        <button class={ghostButton} onclick={() => matching.refetch()} type="button">Retry search</button>
      </p>
    {/if}
    {#if searchExpanded && search.q}
      <CampaignVirtualList
        estimate={90}
        label="Matching session results"
        onNearEnd={loadMatches}
        rows={matchRows}
        surface="search"
        bind:this={searchVirtualList}
        bind:navigation={searchNavigation}
      >
        {#snippet children(_entry)}
          <button
            class={card}
            data-matching-row-id={_entry.row.rowId}
            onclick={() => openSession(_entry.row)}
            type="button"
          >
            Open matching session {_entry.row.name || _entry.row.sessionLabel}
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
      <button
        class={ghostButton}
        onclick={() => timelineAxis = buildCampaignTimeline(items, visible?.request.range ?? {from:null,to:null}).axis}
        type="button"
      >
        Fit loaded campaigns
      </button>
      <CampaignProjectTimeline
        campaignPages={listPages.map((entry) => entry.items.map((item) => item.campaignKey))}
        footer={listFooter}
        {hasMoreSessions}
        labelFor={(key, label) => campaignLabelFor(labels, key, label)}
        map={timelineMap}
        mapError={exploration.error?.message ?? null}
        mapLoading={isRefreshing}
        onLoadMoreCampaigns={loadCampaigns}
        onLoadMoreSessions={() => { if (exploration.error) {retry(); return false;} return loadMembers(); }}
        onOpenSession={openSession}
        onSelectCampaign={selectCampaign}
        selectedCampaignKey={selectedKey}
        {timeline}
        bind:collapsedProjects
        bind:expansion
        bind:navigation={timelineNavigation}
        bind:virtualList={timelineVirtualList}
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
      <button class={mobileBack} onclick={() => mobileMap = !mobileMap} type="button">
        {mobileMap ? 'Back to campaigns' : 'View selected campaign'}
      </button>
      <div class={layout} data-mobile-map={mobileMap ? 'true' : 'false'}>
        <section aria-label="Recent campaigns" class={campaignList} data-campaign-list>
          <p class={muted}>{items.length} of {listPages[0]?.itemCount ?? 0} campaigns · most recent first</p>
          <CampaignVirtualList
            estimate={150}
            footer={listFooter}
            label="Recent campaign results"
            onNearEnd={loadCampaigns}
            rows={virtualCampaigns}
            surface="list"
            bind:navigation={listNavigation}
          >
            {#snippet children(_entry)}
              {@const item = _entry.item}
              <button
                aria-pressed={item.campaignKey === selectedKey ? 'true' : 'false'}
                class={cx(card, item.campaignKey === selectedKey && activeCard)}
                data-campaign-card
                data-campaign-key={item.campaignKey}
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
              bind:collapsed={collapsedNodes}
              bind:navigation={mapNavigation}
              bind:virtualList={mapVirtualList}
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
    <SessionDetailQuerySlot
      client={clients.session}
      onSelectionChange={changeSelection}
      {queryClient}
      rows={detailRows}
      {selection}
    />
  </div>
</main>
