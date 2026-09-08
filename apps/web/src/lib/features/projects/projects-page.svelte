<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { ProjectResolutionAction } from '@ai-usage/web-contract/projects';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { browser } from '$app/environment';
  import { acknowledgeProjectResolutionReview } from '../../query/options/projects';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import type { ProjectsPageData } from './projects-load';
  import { createHydratedProjectResolutionQuery, createProjectResolutionActor } from './projects-query.svelte';
  import ResolutionReviewCard from './resolution-review-card.svelte';

  let { data }: { data: ProjectsPageData } = $props();
  const queryClient = useQueryClient();
  const reviewsQuery = createHydratedProjectResolutionQuery(browser);
  const applyResolution = createProjectResolutionActor(browser);
  const snapshot = $derived(reviewsQuery.data);

  const pageStack = css({ display: 'grid', gap: '16px', maxW: '1040px' });
  const panel = css({
    p: '18px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
  });

  const onAction = async (action: ProjectResolutionAction): Promise<boolean> => {
    if (!applyResolution) {
      return false;
    }
    try {
      await applyResolution(action);
      await acknowledgeProjectResolutionReview(queryClient, action.checkoutId);
      return true;
    } catch {
      return false;
    }
  };
</script>

<div class={shell} data-query-state={data.queryState.dehydratedState.queries.length > 0 ? 'hydrated' : 'deferred'}>
  <main class={page} data-route-shell="projects">
    <WorkspaceHeader
      description="Review Checkouts that cannot be assigned safely. Paths stay private; each choice applies only to the displayed personal Space."
      eyebrow="Repository identity"
      heading="Projects"
    />
    <div class={pageStack}>
      {#if snapshot}
        {#if snapshot.reviews.length === 0}
          <section aria-live="polite" class={panel}>No Project assignments need review.</section>
        {:else}
          {#each snapshot.reviews as review (review.checkoutId)}
            <ResolutionReviewCard {onAction} {review} />
          {/each}
        {/if}
      {:else if reviewsQuery.isPending}
        <section aria-live="polite" class={panel}>Loading Project assignments…</section>
      {:else}
        <section aria-live="polite" class={panel}>Project assignments could not be read safely.</section>
      {/if}
    </div>
  </main>
</div>
