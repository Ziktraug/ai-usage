<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed aria-current enum values for these navigation links. -->
<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { MemoryProposalReviewAction, MemoryProposalReviewInput } from '@ai-usage/web-contract/memory';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { acknowledgeMemoryProposalReview, memoryProposalReviewsKey } from '../../query/options/memory';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import { isMemoryProposalUnavailable } from './memory-errors';
  import MemoryKnowledge from './memory-knowledge.svelte';
  import type { MemoryPageData } from './memory-load';
  import { createHydratedMemoryProposalQuery, createMemoryProposalActor } from './memory-query.svelte';
  import {
    memoryButton,
    memoryCopy,
    memoryCurrentButton,
    memoryField,
    memoryInput,
    memoryPanel,
    memoryRow,
    memoryStack,
  } from './memory-styles';
  import { isMemoryProposalId, memoryHref, memoryLocation, memoryProjectError } from './memory-url';
  import ProposalReviewCard from './proposal-review-card.svelte';

  let {
    data,
    address = '/memory',
    onNavigate,
  }: { data: MemoryPageData; address?: string; onNavigate?: (href: string) => Promise<void> } = $props();
  const location = $derived(memoryLocation(address));
  let project = $state(untrack(() => memoryLocation(address).projectId ?? ''));
  let filterError = $state<string | null>(null);
  $effect(() => {
    project = location.projectId ?? '';
    filterError = null;
  });
  const queryClient = useQueryClient();
  const targetProposalId = $derived(location.view === 'review' ? location.proposalId : null);
  const targetMalformed = $derived(targetProposalId !== null && !isMemoryProposalId(targetProposalId));
  const proposalPosition = $derived<MemoryProposalReviewInput>(
    targetProposalId === null
      ? { cursor: location.view === 'review' ? location.cursor : null }
      : { proposalId: targetProposalId },
  );
  const proposalsQuery = createHydratedMemoryProposalQuery(
    browser,
    () => proposalPosition,
    () => location.view === 'review' && !targetMalformed,
  );
  const targetRefused = $derived(
    targetMalformed || (targetProposalId !== null && isMemoryProposalUnavailable(proposalsQuery.error)),
  );
  const applyProposalAction = createMemoryProposalActor(browser);
  const snapshot = $derived(proposalsQuery.data);
  const projectError = $derived(memoryProjectError(location.projectId));
  const navigation = css({
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    borderBottom: '1px solid token(colors.line)',
    pb: '12px',
  });
  const filter = async (event: SubmitEvent) => {
    event.preventDefault();
    const projectId = project.trim();
    filterError = memoryProjectError(projectId);
    if (filterError) {
      return;
    }
    await onNavigate?.(memoryHref(address, { project: projectId || null, cursor: null }));
  };
  const onAction = async (action: MemoryProposalReviewAction): Promise<boolean> => {
    if (!applyProposalAction) {
      return false;
    }
    try {
      await applyProposalAction(action);
      if (action.proposalId === targetProposalId) {
        // The reviewed proposal can no longer start a page; continue with the queue itself.
        await onNavigate?.(memoryHref(address, { proposal: null, cursor: null }));
      }
      await acknowledgeMemoryProposalReview(queryClient, action.proposalId);
      await queryClient.invalidateQueries({ queryKey: memoryProposalReviewsKey() });
      return true;
    } catch {
      return false;
    }
  };
</script>
<div class={shell} data-query-state={data.queryState.dehydratedState.queries.length>0 ? 'hydrated':'deferred'}>
  <main class={page} data-route-shell="memory">
    <WorkspaceHeader
      description="Read accepted guidance and review proposals before adding them to Memory."
      eyebrow="Accepted knowledge"
      heading="Memory"
    />
    <div class={memoryStack}>
      <nav aria-label="Memory views" class={navigation}>
        <a
          aria-current={location.view==='knowledge' ? 'page':undefined}
          class={location.view==='knowledge' ? memoryCurrentButton : memoryButton}
          data-sveltekit-noscroll
          href={memoryHref(address,{view:'knowledge',cursor:null,proposal:null})}
          >Knowledge</a
        >
        <a
          aria-current={location.view==='review' ? 'page':undefined}
          class={location.view==='review' ? memoryCurrentButton : memoryButton}
          data-sveltekit-noscroll
          href={memoryHref(address,{view:'review',cursor:null,proposal:null})}
          >Pending review</a
        >
      </nav>
      {#if location.view==='review'}
        <p class={memoryCopy}>
          Review each proposal's source and edit the guidance before explicitly accepting or rejecting it.
        </p>
        {#if targetRefused}
          <section class={memoryPanel}>
            <p class={memoryCopy} role="alert">
              This Memory proposal is not pending review or is not accessible. It may already have been accepted or
              rejected.
            </p>
            <a class={memoryButton} href={memoryHref(address,{proposal:null,cursor:null})}>Open the review queue</a>
          </section>
        {:else if snapshot}
          {#if targetProposalId}
            <p class={memoryCopy} role="status">The requested proposal is shown first, followed by later proposals.</p>
          {/if}
          {#if snapshot.proposals.length===0}
            <section aria-live="polite" class={memoryPanel}>No Memory proposals need review.</section>
          {:else}
            {#each snapshot.proposals as proposal (proposal.proposalId)}
              <ProposalReviewCard
                {onAction}
                {proposal}
                spaceId={snapshot.spaceId}
                targeted={proposal.proposalId===targetProposalId}
              />
            {/each}
          {/if}
          <div class={memoryRow}>
            {#if location.cursor || targetProposalId}
              <a class={memoryButton} href={memoryHref(address,{cursor:null,proposal:null})}>Newest proposals</a>
            {/if}
            {#if snapshot.nextCursor}
              <a
                class={memoryButton}
                data-sveltekit-noscroll
                href={memoryHref(address,{cursor:snapshot.nextCursor,proposal:null})}
                >More proposals</a
              >
            {/if}
          </div>
        {:else if proposalsQuery.isPending}
          <p class={memoryCopy} role="status">Loading Memory proposals…</p>
        {:else}
          <p class={memoryCopy} role="alert">Memory proposals could not be read safely. Check the Memory service.</p>
        {/if}
      {:else}
        <form class={memoryRow} onsubmit={filter}>
          <label class={memoryField}
            >Project ID (optional)<input
              class={memoryInput}
              maxlength="36"
              placeholder="All accessible Projects"
              bind:value={project}
            ></label
          >
          <button class={memoryButton} type="submit">Apply filters</button>
        </form>
        {#if filterError || projectError}
          <p class={memoryCopy} role="alert">{filterError ?? projectError}</p>
        {/if}
        {#if !projectError}
          {#key location.projectId}
            <MemoryKnowledge projectId={location.projectId} />
          {/key}
        {/if}
      {/if}
    </div>
  </main>
</div>
