<script lang="ts">
  import { type SessionPresentationRow, sessionNeighborFingerprint } from '@ai-usage/report-core/session-query';
  import { createQuery, type QueryClient } from '@tanstack/svelte-query';
  import { onMount, type Snippet, tick } from 'svelte';
  import { classifySessionAnalysisError } from '../../../../session-analysis-error';
  import { sessionAnalysisTargetForSession } from '../../../../session-analysis-target';
  import { drawerCommandForKey } from '../../../foundation/navigation/svelte/navigation';
  import {
    optionalSessionDetailQueryOptions,
    optionalSessionNeighborsQueryOptions,
    optionalSessionVcsQueryOptions,
  } from '../../../query/options/session';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import type { SessionDetailController, SessionDetailControllerSnapshot, SessionSelectionInput } from './types';

  type SessionDrawerModule = typeof import('./session-drawer.svelte');
  const interactiveElementTagPattern = /^(INPUT|SELECT|TEXTAREA)$/;
  const openDrawerContentSelector = '[data-scope="drawer"][data-part="content"][data-state="open"][role="dialog"]';

  const escapeBelongsToActiveOverlay = (event: Pick<KeyboardEvent, 'defaultPrevented' | 'key' | 'target'>): boolean => {
    if (event.key !== 'Escape') {
      return false;
    }
    if (event.defaultPrevented) {
      return true;
    }
    const targetElement = event.target;
    return targetElement instanceof Element && targetElement.closest(openDrawerContentSelector) !== null;
  };

  let {
    campaignSlot,
    client,
    onFieldFilter,
    onSelectionChange,
    queryClient,
    rows,
    selection,
  }: {
    campaignSlot?: Snippet;
    client: SessionClientAdapter;
    onFieldFilter?: (key: 'model' | 'project', value: string) => void;
    onSelectionChange: (selection: SessionSelectionInput | null) => void;
    queryClient: QueryClient;
    rows: readonly SessionPresentationRow[];
    selection: SessionSelectionInput | null;
  } = $props();

  let analysisOpen = $state(false);
  let vcsRequested = $state(false);
  let selectedIdentity = $state('');
  let drawerModule = $state<SessionDrawerModule>();
  let drawerLoadFailed = $state(false);
  let drawerLoad: Promise<void> | undefined;

  const identityFor = (next: SessionSelectionInput | null): string => {
    if (!next) {
      return '';
    }
    if (next.query) {
      return sessionNeighborFingerprint({ query: next.query, rowId: next.row.rowId });
    }
    return next.revision ? `revision:${next.revision}:${next.row.rowId}` : `local:${next.row.rowId}`;
  };
  const revision = $derived(selection?.query?.revision ?? selection?.revision);
  const target = $derived(
    selection?.target ?? (selection ? sessionAnalysisTargetForSession(selection.row) : undefined),
  );
  const neighborsQuery = createQuery(() =>
    optionalSessionNeighborsQueryOptions(
      client,
      selection?.query ? { query: selection.query, rowId: selection.row.rowId } : undefined,
      { browser: typeof globalThis.location !== 'undefined' },
    ),
  );
  const detailQuery = createQuery(() =>
    optionalSessionDetailQueryOptions(
      client,
      analysisOpen && revision && target ? { revision, rowId: target.reportRowId } : undefined,
      { browser: typeof globalThis.location !== 'undefined' },
    ),
  );
  const vcsQuery = createQuery(() =>
    optionalSessionVcsQueryOptions(
      client,
      vcsRequested && revision && target ? { revision, rowId: target.reportRowId } : undefined,
      { browser: typeof globalThis.location !== 'undefined' },
    ),
  );
  const neighbors = $derived(neighborsQuery.data?.ok ? neighborsQuery.data.data : undefined);
  const navigation = $derived(
    selection?.query
      ? {
          loading: neighborsQuery.isFetching,
          next: neighbors?.next ?? null,
          previous: neighbors?.previous ?? null,
          total: selection.total ?? rows.length,
        }
      : undefined,
  );
  const snapshot = $derived<SessionDetailControllerSnapshot>({
    analysisError: detailQuery.error ? classifySessionAnalysisError(detailQuery.error) : null,
    analysisLoading: detailQuery.isFetching,
    analysisOpen,
    analysisResponse: detailQuery.data ?? null,
    navigation,
    revision: revision ?? null,
    row: selection?.row ?? null,
    target: target ?? null,
    vcsResolution:
      vcsQuery.error === null ? (vcsQuery.data ?? null) : { reason: 'resolver-unavailable', status: 'unavailable' },
    vcsResolving: vcsQuery.isFetching,
  });

  const ensureDrawer = (): void => {
    drawerLoad ??= import('./session-drawer.svelte')
      .then((module) => {
        drawerModule = module;
      })
      .catch(() => {
        drawerLoadFailed = true;
      });
  };

  const navigate = (delta: -1 | 1): void => {
    const current = selection;
    if (!current) {
      return;
    }
    if (current.query) {
      const neighbor = delta > 0 ? navigation?.next : navigation?.previous;
      if (neighbor) {
        const { target: _target, ...preserved } = current;
        onSelectionChange({ ...preserved, row: neighbor });
      }
      return;
    }
    const index = rows.findIndex((row) => row.rowId === current.row.rowId);
    const next = rows[index + delta];
    if (next) {
      onSelectionChange({ row: next });
    }
  };

  const controller: SessionDetailController = {
    close: () => onSelectionChange(null),
    current: () => snapshot,
    dispose: () => undefined,
    handleKeyDown: (event) => {
      if (!snapshot.row) {
        return;
      }
      if (escapeBelongsToActiveOverlay(event)) {
        return;
      }
      const targetElement = event.target;
      const tagName: unknown = targetElement ? Reflect.get(targetElement, 'tagName') : undefined;
      const editable: unknown = targetElement ? Reflect.get(targetElement, 'isContentEditable') : undefined;
      if ((typeof tagName === 'string' && interactiveElementTagPattern.test(tagName)) || editable === true) {
        return;
      }
      const command = drawerCommandForKey(event.key);
      if (command === 'close') {
        onSelectionChange(null);
      } else if (command === 'next') {
        event.preventDefault();
        navigate(1);
      } else if (command === 'previous') {
        event.preventDefault();
        navigate(-1);
      }
    },
    navigate,
    resolveVcs: async () => {
      vcsRequested = true;
      await tick();
      await vcsQuery.refetch();
    },
    retryAnalysis: async () => {
      await detailQuery.refetch();
    },
    select: (nextSelection) => onSelectionChange(nextSelection),
    subscribe: (listener) => {
      listener(snapshot);
      return () => undefined;
    },
    toggleAnalysis: async () => {
      analysisOpen = !analysisOpen;
      if (analysisOpen) {
        await tick();
        await detailQuery.refetch();
      }
    },
  };

  $effect(() => {
    const identity = identityFor(selection);
    if (identity === selectedIdentity) {
      return;
    }
    selectedIdentity = identity;
    analysisOpen = false;
    vcsRequested = false;
    if (selection) {
      ensureDrawer();
    }
  });

  onMount(() => {
    const keydown = (event: KeyboardEvent): void => controller.handleKeyDown(event);
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
</script>

<div data-selected-row-id={selection?.row.rowId} data-session-detail-slot>
  {#if drawerModule}
    {@const SessionDrawer = drawerModule.default}
    <SessionDrawer
      {...(campaignSlot === undefined ? {} : { campaignSlot })}
      {controller}
      {...(onFieldFilter === undefined ? {} : { onFieldFilter })}
      {rows}
      {snapshot}
    />
  {:else if selection?.row && drawerLoadFailed}
    <p role="status">Session details are temporarily unavailable.</p>
  {/if}
</div>
