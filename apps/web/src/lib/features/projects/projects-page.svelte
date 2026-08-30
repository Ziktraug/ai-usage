<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { header, meta, page, shell, title, titleBlock } from '@ai-usage/design-system/svelte';
  import type { ProjectResolutionAction } from '@ai-usage/web-contract/projects';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { browser } from '$app/environment';
  import { acknowledgeProjectResolutionReview } from '../../query/options/projects';
  import type { ProjectsPageData } from './projects-load';
  import { createHydratedProjectResolutionQuery, createProjectResolutionActor } from './projects-query.svelte';
  import ResolutionReviewCard from './resolution-review-card.svelte';

  let { data }: { data: ProjectsPageData } = $props();
  const queryClient = useQueryClient();
  const reviewsQuery = createHydratedProjectResolutionQuery(browser);
  const applyResolution = createProjectResolutionActor(browser);
  const snapshot = $derived(reviewsQuery.data);

  const pageStack = css({ display: 'grid', gap: '16px', maxW: '1040px' });
  const intro = css({ maxW: '720px', color: 'muted', fontSize: '14px', lineHeight: 1.6 });
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
  <header class={header}>
    <div class={titleBlock}>
      <p class={meta}>Repository identity</p>
      <h1 class={title}>Projects</h1>
      <p class={intro}>
        Review Checkouts that cannot be assigned safely. Paths stay private; each choice applies only to the displayed
        personal Space.
      </p>
    </div>
  </header>
  <main class={page} data-route-shell="projects">
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
