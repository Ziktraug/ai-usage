<script lang="ts">
  import CampaignVirtualList from './campaign-virtual-list.svelte';

  interface Row {
    key: string;
    label: string;
  }

  let rows = $state<Row[]>([{ key: 'row-0', label: 'Short page session 0' }]);
  let nextCursor = $state<number | null>(1);
  let loading = $state(false);
  let pageError = $state('');
  let requests = $state(0);
  const acquire = async (cursor: number): Promise<void> => {
    try {
      const response = await fetch(`/__campaign-short-page-fixture?cursor=${cursor}`);
      if (!response.ok) {
        throw new Error('The synthetic page was unavailable');
      }
      const page: { rows: Row[]; nextCursor: number | null } = await response.json();
      rows = [...rows, ...page.rows];
      nextCursor = page.nextCursor;
    } catch (cause) {
      pageError = cause instanceof Error ? cause.message : 'The synthetic page failed';
    } finally {
      loading = false;
    }
  };
  const loadMore = (): boolean => {
    if (loading || pageError || nextCursor === null) {
      return false;
    }
    loading = true;
    requests += 1;
    acquire(nextCursor);
    return true;
  };
</script>

<h1>Short campaign pages</h1>
<p data-short-page-loaded={rows.length} data-short-page-requests={requests}>
  {rows.length}
  rows loaded · {requests} acquisitions
</p>
<CampaignVirtualList estimate={80} label="Short page sessions" onNearEnd={loadMore} {rows} surface="list">
  {#snippet children(_row)}
    <button data-short-page-row={_row.key} style="box-sizing: border-box; height: 80px; width: 100%;" type="button">
      {_row.label}
    </button>
  {/snippet}
  {#snippet footer()}
    <p>{pageError || (loading ? 'Loading another short page…' : 'More sessions available')}</p>
  {/snippet}
</CampaignVirtualList>
