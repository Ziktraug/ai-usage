<script lang="ts">
  import { type SessionPresentationRow, sessionNeighborFingerprint } from '@ai-usage/report-core/session-query';
  import { onMount, type Snippet, untrack } from 'svelte';
  import type { SessionDetailController, SessionDetailControllerSnapshot, SessionSelectionInput } from './controller';
  import SessionDrawer from './session-drawer.svelte';

  let {
    campaignSlot,
    controller,
    onFieldFilter,
    rows,
    selection,
  }: {
    campaignSlot?: Snippet;
    controller: SessionDetailController;
    onFieldFilter?: (key: 'model' | 'project', value: string) => void;
    rows: readonly SessionPresentationRow[];
    selection: SessionSelectionInput | null;
  } = $props();

  let snapshot = $state<SessionDetailControllerSnapshot>(untrack(() => controller.current()));
  let selectedIdentity = $state('');

  const identityFor = (next: SessionSelectionInput | null): string => {
    if (!next) {
      return '';
    }
    if (next.query) {
      return sessionNeighborFingerprint({ query: next.query, rowId: next.row.rowId });
    }
    if (next.revision) {
      return `revision:${next.revision}:${next.row.rowId}`;
    }
    return `local:${next.row.rowId}`;
  };

  $effect(() => {
    const identity = identityFor(selection);
    if (identity === selectedIdentity) {
      return;
    }
    selectedIdentity = identity;
    if (selection) {
      controller.select(selection);
    } else {
      controller.close();
    }
  });

  onMount(() => {
    const unsubscribe = controller.subscribe((next) => {
      snapshot = next;
    });
    const keydown = (event: KeyboardEvent): void => controller.handleKeyDown(event);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', keydown);
      unsubscribe();
      controller.dispose();
    };
  });
</script>

<div data-selected-row-id={snapshot.row?.rowId} data-session-detail-slot>
  {#if snapshot.row}
    <SessionDrawer
      {...(campaignSlot === undefined ? {} : { campaignSlot })}
      {controller}
      {...(onFieldFilter === undefined ? {} : { onFieldFilter })}
      {rows}
      {snapshot}
    />
  {/if}
</div>
