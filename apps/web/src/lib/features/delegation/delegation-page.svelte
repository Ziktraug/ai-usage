<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { page, shell } from '@ai-usage/design-system/svelte';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/env';
  import { goto } from '$app/navigation';
  import { invalidateDelegationSettings } from '../../query/options/delegation';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import type { DelegationPageData } from './delegation-load';
  import { DELEGATION_DESCRIPTION, type DelegationSection, delegationSectionHref } from './delegation-model';
  import {
    createDelegationPageClientForBrowser,
    createHydratedDelegationSettingsQuery,
  } from './delegation-query.svelte';
  import DelegationWorkbench from './delegation-workbench.svelte';

  let { data }: { data: DelegationPageData } = $props();
  const queryClient = useQueryClient();
  const settingsQuery = createHydratedDelegationSettingsQuery(browser);
  const client = createDelegationPageClientForBrowser(browser);
  const settings = $derived(settingsQuery.data?.ok ? settingsQuery.data.data : undefined);
  // A defined failure (demo boundary, incompatible store) keeps its message; a transport failure
  // carries no safe detail for the page.
  const failure = $derived.by<string | null>(() => {
    if (settingsQuery.data && !settingsQuery.data.ok) {
      return settingsQuery.data.error.message;
    }
    return settingsQuery.error ? 'The request did not complete.' : null;
  });

  // The active section lives in the URL: the server reads it for the first render, and a tab change
  // replaces the address (no history entry, focus kept), so a reload or a shared link lands on it. Not a
  // shallow goto: the shell re-replaces the history entry from `page.url`, which a shallow goto leaves
  // unchanged, so the address would revert.
  let section = $state<DelegationSection>(untrack(() => data.section));
  $effect(() => {
    section = data.section;
  });
  const changeSection = async (next: DelegationSection): Promise<void> => {
    if (next === section) {
      return;
    }
    section = next;
    await goto(delegationSectionHref(next), { replace: true, reset: false });
  };
  const reload = async (): Promise<void> => {
    await invalidateDelegationSettings(queryClient);
  };

  const pageStack = css({ display: 'grid', gap: '16px', maxW: '1280px', minW: 0 });
  const panel = css({
    p: '18px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
  });
</script>

<div class={shell} data-query-state={data.queryState.dehydratedState.queries.length > 0 ? 'hydrated' : 'deferred'}>
  <main
    class={page}
    data-delegation-hydrated={browser ? 'true' : 'false'}
    data-delegation-revision={settings?.revision ?? ''}
    data-route-shell="delegation"
  >
    <WorkspaceHeader description={DELEGATION_DESCRIPTION} eyebrow="Read-only reviews" heading="Delegation" />
    <div class={pageStack}>
      {#if settings}
        <DelegationWorkbench {client} onReload={reload} onSectionChange={changeSection} {section} {settings} />
      {:else if failure !== null}
        <section aria-live="polite" class={panel} role="alert">
          Delegation settings could not be read: {failure}
        </section>
      {:else}
        <section aria-live="polite" class={panel}>Loading delegation settings…</section>
      {/if}
    </div>
  </main>
</div>
