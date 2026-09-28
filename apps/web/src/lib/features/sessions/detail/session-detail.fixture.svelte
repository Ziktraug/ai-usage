<script lang="ts">
  import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import { createWebQueryClient } from '../../../query/client';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import { syntheticSessionRow } from '../table/session-table.fixtures';
  import { sessionDetailFixtureResponse } from './session-detail.fixtures';
  import SessionDetailQuerySlot from './session-detail-query-slot.svelte';
  import type { SessionSelectionInput } from './types';

  const queryClient = createWebQueryClient();
  const rows = [syntheticSessionRow(0), syntheticSessionRow(1)];
  let revision = $state(1);
  let selection = $state<SessionSelectionInput | null>({ revision: 'revision-1', row: rows[0]! });
  let pending = $state(false);
  let release: (() => void) | undefined;
  let reject: (() => void) | undefined;
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected fixture operation'));
  const client: SessionClientAdapter = {
    campaignChildren: unused,
    lookup: unused,
    neighbors: unused,
    page: unused,
    vcs: unused,
    detail: (request, signal) => {
      const response = sessionDetailFixtureResponse(request.revision, request.rowId);
      if (request.revision === 'revision-1') {
        return Promise.resolve(response);
      }
      pending = true;
      return new Promise<SessionDetailResponse>((resolve, fail) => {
        release = () => {
          pending = false;
          resolve(response);
        };
        reject = () => {
          pending = false;
          fail(new Error('Fixture detail refresh failed'));
        };
        signal?.addEventListener(
          'abort',
          () => {
            pending = false;
            fail(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  const refresh = (): void => {
    revision += 1;
    if (selection) {
      selection = { ...selection, revision: `revision-${revision}` };
    }
  };
  onDestroy(() => queryClient.clear());
</script>

<div data-pending={pending} data-session-detail-fixture>
  <button onclick={refresh} type="button">Publish revision</button>
  <button onclick={() => release?.()} type="button">Release detail</button>
  <button onclick={() => reject?.()} type="button">Fail detail</button>
  <button onclick={() => { selection = { revision: `revision-${revision}`, row: rows[1]! }; }} type="button">
    Select other session
  </button>
</div>
<QueryClientProvider client={queryClient}>
  <SessionDetailQuerySlot
    {client}
    onSelectionChange={(next) => { selection = next; }}
    {queryClient}
    {rows}
    {selection}
  />
</QueryClientProvider>
