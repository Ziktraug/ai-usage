<script lang="ts">
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import {
    createInfiniteQuery,
    type InfiniteData,
    type QueryClient,
    type QueryKey,
    skipToken,
  } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import { campaignMembersOptions, loadNextCampaignPage } from '../../../query/options/campaigns';
  import { SessionRevisionExpiredError } from '../../../query/options/session-window';
  import { webQueryPolicies } from '../../../query/policies';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import SessionDrawer from './session-drawer.svelte';
  import SessionMembers from './session-members.svelte';
  import type { SessionDetailController, SessionDetailControllerSnapshot } from './types';

  type MemberPage = Extract<
    Awaited<ReturnType<SessionClientAdapter['campaignChildren']>>,
    { readonly ok: true }
  >['data'];

  let {
    campaignLabelSlot,
    campaignSlot,
    client,
    controller,
    memberRows = [],
    onClosingChange,
    onFieldFilter,
    onSelectMember,
    queryClient,
    rows,
    snapshot,
  }: {
    campaignLabelSlot?: Snippet;
    campaignSlot?: Snippet;
    client: SessionClientAdapter;
    controller: SessionDetailController;
    /** Known actual sessions from this same revision, including a directly selected far child. */
    memberRows?: readonly SessionPresentationRow[];
    onClosingChange?: (closing: boolean) => void;
    onFieldFilter?: (key: 'model' | 'project', value: string) => void;
    onSelectMember?: (row: SessionPresentationRow) => void;
    queryClient: QueryClient;
    rows: readonly SessionPresentationRow[];
    snapshot: SessionDetailControllerSnapshot;
  } = $props();

  let closing = $state(false);
  let pendingNext: Promise<void> | undefined;
  const campaignKey = $derived(snapshot.row?.campaignKey);
  const enabled = $derived(
    typeof window !== 'undefined' && !closing && snapshot.row !== null && snapshot.revision !== null && !!campaignKey,
  );
  const members = createInfiniteQuery<
    MemberPage,
    Error,
    InfiniteData<MemberPage, string | null>,
    QueryKey,
    string | null
  >(
    () =>
      enabled && snapshot.revision && campaignKey
        ? campaignMembersOptions(client, snapshot.revision, campaignKey)
        : {
            ...webQueryPolicies.immutableRevision,
            enabled: false,
            getNextPageParam: () => undefined,
            initialPageParam: null,
            queryFn: skipToken,
            queryKey: ['web', 'session-members', 'closed'],
          },
    () => queryClient,
  );
  const page = $derived(members.data?.pages[0]);
  const canonicalRows = $derived.by((): readonly SessionPresentationRow[] => {
    const unique = new Map<string, SessionPresentationRow>();
    for (const entry of members.data?.pages ?? []) {
      if (entry.root) {
        unique.set(entry.root.rowId, entry.root);
      }
      for (const row of entry.items) {
        unique.set(row.rowId, row);
      }
    }
    return [...unique.values()];
  });
  // Joining known rows helps the rounds reader resolve a far child without copying
  // the Query cache into local state or pretending that its intervening pages loaded.
  const joinedRows = $derived.by((): readonly SessionPresentationRow[] => {
    const unique = new Map(canonicalRows.map((row) => [row.rowId, row]));
    for (const row of memberRows) {
      if (row.campaignKey === campaignKey && !unique.has(row.rowId)) {
        unique.set(row.rowId, row);
      }
    }
    return [...unique.values()];
  });
  const expired = $derived(members.error instanceof SessionRevisionExpiredError);
  const loadNext = (): boolean => {
    if (!enabled || members.isFetching || members.error || !members.hasNextPage || pendingNext) {
      return false;
    }
    pendingNext = loadNextCampaignPage(members).finally(() => {
      pendingNext = undefined;
    });
    return true;
  };
  const retry = async (): Promise<void> => {
    if (!enabled || expired || members.isFetching) {
      return;
    }
    if (members.data && members.hasNextPage) {
      await loadNextCampaignPage(members);
    } else {
      await members.refetch({ throwOnError: false });
    }
  };
  const selectMember = (row: SessionPresentationRow): void => {
    if (onSelectMember) {
      onSelectMember(row);
    } else {
      controller.select({ ...(snapshot.revision ? { revision: snapshot.revision } : {}), row });
    }
  };
  const handleClosingChange = (value: boolean): void => {
    // Changing the observer key releases this detail's acquisition. TanStack aborts
    // an unused request, while another observer (the Map) can keep the same read alive.
    closing = value;
    onClosingChange?.(value);
  };
</script>

{#snippet canonicalMembers()}
  {#if snapshot.row && campaignKey}
    <SessionMembers
      campaign={snapshot.row}
      error={members.error}
      {expired}
      hasNextPage={members.hasNextPage}
      loading={members.isFetching}
      onNearEnd={loadNext}
      onRetry={retry}
      onSelectMember={selectMember}
      rows={canonicalRows}
      totalCount={page ? page.itemCount + (page.root ? 1 : 0) : undefined}
    />
  {/if}
{/snippet}

<SessionDrawer
  {...(campaignLabelSlot === undefined ? {} : { campaignLabelSlot })}
  {...(snapshot.revision && campaignKey ? { campaignSlot: canonicalMembers } : campaignSlot ? { campaignSlot } : {})}
  {controller}
  memberRows={snapshot.revision ? joinedRows : memberRows}
  onClosingChange={handleClosingChange}
  {...(onFieldFilter === undefined ? {} : { onFieldFilter })}
  onSelectMember={selectMember}
  {rows}
  {snapshot}
/>
