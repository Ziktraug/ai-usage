<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { MemoryProposalReviewAction } from '@ai-usage/web-contract/memory';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { browser } from '$app/environment';
  import { acknowledgeMemoryProposalReview } from '../../query/options/memory';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import type { MemoryPageData } from './memory-load';
  import { createHydratedMemoryProposalQuery, createMemoryProposalActor } from './memory-query.svelte';
  import MemorySearch from './memory-search.svelte';
  import ProposalReviewCard from './proposal-review-card.svelte';

  let { data }: { data: MemoryPageData } = $props();
  const queryClient = useQueryClient();
  const proposalsQuery = createHydratedMemoryProposalQuery(browser);
  const applyProposalAction = createMemoryProposalActor(browser);
  const snapshot = $derived(proposalsQuery.data);

  const pageStack = css({ display: 'grid', gap: '16px', maxW: '1040px' });
  const panel = css({
    p: '18px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
  });
  const continuation = css({ color: 'muted', fontSize: '12px' });

  const onAction = async (action: MemoryProposalReviewAction): Promise<boolean> => {
    if (!applyProposalAction) {
      return false;
    }
    try {
      await applyProposalAction(action);
      await acknowledgeMemoryProposalReview(queryClient, action.proposalId);
      return true;
    } catch {
      return false;
    }
  };
</script>

<div class={shell} data-query-state={data.queryState.dehydratedState.queries.length > 0 ? 'hydrated' : 'deferred'}>
  <main class={page} data-route-shell="memory">
    <WorkspaceHeader
      description="Review generated knowledge before it becomes durable guidance. Every proposal keeps its evidence, trust, and sensitivity visible; acceptance is always an explicit Person action."
      eyebrow="Reviewed knowledge"
      heading="Memory"
    />
    <div class={pageStack}>
      <MemorySearch />
      {#if snapshot}
        {#if snapshot.proposals.length === 0}
          <section aria-live="polite" class={panel}>No Memory proposals need review.</section>
        {:else}
          {#each snapshot.proposals as proposal (proposal.proposalId)}
            <ProposalReviewCard {onAction} {proposal} spaceId={snapshot.spaceId} />
          {/each}
          {#if snapshot.nextCursor}
            <p class={continuation}>More proposals remain queued and will appear after this review batch.</p>
          {/if}
        {/if}
      {:else if proposalsQuery.isPending}
        <section aria-live="polite" class={panel}>Loading Memory proposals…</section>
      {:else}
        <section aria-live="polite" class={panel}>Memory proposals could not be read safely.</section>
      {/if}
    </div>
  </main>
</div>
