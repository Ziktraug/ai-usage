<script lang="ts">
  import { type SessionPresentationRow, sessionNeighborFingerprint } from '@ai-usage/report-core/session-query';
  import { onMount, type Snippet, untrack } from 'svelte';
  import type { SessionDetailController, SessionDetailControllerSnapshot, SessionSelectionInput } from './controller';

  type SessionDrawerModule = typeof import('./session-drawer.svelte');

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
  let drawerModule = $state<SessionDrawerModule>();
  let drawerLoadFailed = $state(false);
  let drawerLoad: Promise<void> | undefined;

  const ensureDrawer = (): void => {
    drawerLoad ??= import('./session-drawer.svelte')
      .then((module) => {
        drawerModule = module;
      })
      .catch(() => {
        drawerLoadFailed = true;
      });
  };

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

  $effect(() => {
    if (snapshot.row) {
      ensureDrawer();
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
  {#if snapshot.row && drawerModule}
    {@const SessionDrawer = drawerModule.default}
    <SessionDrawer
      {...(campaignSlot === undefined ? {} : { campaignSlot })}
      {controller}
      {...(onFieldFilter === undefined ? {} : { onFieldFilter })}
      {rows}
      {snapshot}
    />
  {:else if snapshot.row && drawerLoadFailed}
    <p role="status">Session details are temporarily unavailable.</p>
  {/if}
</div>
