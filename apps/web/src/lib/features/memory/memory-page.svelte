<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed aria-current enum values for these navigation links. -->
<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { page, shell } from '@ai-usage/design-system/svelte';
  import type { MemoryContractClient, MemoryProposalReviewAction } from '@ai-usage/web-contract/memory';
  import type {
    SessionDistillationBrowseRequest,
    SessionDistillationContractClient,
  } from '@ai-usage/web-contract/session-distillation';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { acknowledgeMemoryProposalReview, memoryProposalReviewsKey } from '../../query/options/memory';
  import { memoryWorkspaceProjectsOptions } from '../../query/options/memory-workspace';
  import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import { createLazyModuleLoader } from '../report/composition/lazy-module-loader';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import MemoryAnalysisList from './memory-analysis-list.svelte';
  import MemoryDiscovery from './memory-discovery.svelte';
  import { memoryAnalysisError } from './memory-errors';
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
  import { memoryDateBound, memoryHref, memoryLocation } from './memory-url';
  import ProposalReviewCard from './proposal-review-card.svelte';

  let {
    data,
    address = '/memory',
    onNavigate,
  }: { data: MemoryPageData; address?: string; onNavigate?: (href: string) => Promise<void> } = $props();
  const location = $derived(memoryLocation(address));
  let draft = $state(untrack(() => memoryLocation(address).query));
  let since = $state(untrack(() => memoryLocation(address).since));
  let until = $state(untrack(() => memoryLocation(address).until));
  let project = $state(untrack(() => memoryLocation(address).projectId ?? ''));
  let filterError = $state('');
  let projectsCursor = $state<string | null>(null);
  $effect(() => {
    draft = location.query;
    since = location.since;
    until = location.until;
    project = location.projectId ?? '';
  });
  const queryClient = useQueryClient();
  const sessionClient = browser
    ? useWebQueryRpcContext().rpc.sessionDistillation
    : ssrUnavailableClient<SessionDistillationContractClient>('session-distillation');
  const projectsQuery = createQuery(() => memoryWorkspaceProjectsOptions(sessionClient, browser, projectsCursor));
  const proposalsQuery = createHydratedMemoryProposalQuery(
    browser,
    () => (location.view === 'review' ? location.cursor : null),
    () => location.view === 'review',
  );
  const applyProposalAction = createMemoryProposalActor(browser);
  const snapshot = $derived(proposalsQuery.data);
  const browseInput = $derived<SessionDistillationBrowseRequest>({
    kind: 'browse',
    projectId: location.projectId,
    query: location.query,
    since: memoryDateBound(location.since),
    until: memoryDateBound(location.until),
    cursor: location.cursor,
    limit: 20,
  });
  const filterIdentity = $derived(JSON.stringify([location.projectId, location.query, location.since, location.until]));
  const layout = css({
    display: 'grid',
    gap: '24px',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
    alignItems: 'start',
  });
  const navigation = css({
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    borderBottom: '1px solid token(colors.line)',
    pb: '12px',
  });
  let detailModule = $state<typeof import('./memory-analysis-detail.svelte')>();
  let detailFailed = $state(false);
  const detailLoader = createLazyModuleLoader({
    importModule: () => import('./memory-analysis-detail.svelte'),
    onLoaded: (module) => {
      detailModule = module;
    },
    onFailureChange: (failed) => {
      detailFailed = failed;
    },
  });
  $effect(() => {
    if (browser && location.analysisId && !detailModule && !detailFailed) {
      detailLoader.start();
    }
  });
  const filter = async (event: SubmitEvent) => {
    event.preventDefault();
    filterError = '';
    if (since && until && since >= until) {
      filterError = 'The end date must be after the start date.';
      return;
    }
    await onNavigate?.(memoryHref(address, { q: draft.trim(), project: project || null, since, until, cursor: null }));
  };
  const onAction = async (action: MemoryProposalReviewAction): Promise<boolean> => {
    if (!applyProposalAction) {
      return false;
    }
    try {
      await applyProposalAction(action);
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
      description="Read what happened across your sessions. Propose the lessons worth reusing, then decide explicitly which become accepted knowledge."
      eyebrow="Experience and knowledge"
      heading="Memory"
    />
    <div class={memoryStack}>
      <nav aria-label="Memory views" class={navigation}>
        <a
          aria-current={location.view==='analyses' ? 'page':undefined}
          class={location.view==='analyses' ? memoryCurrentButton : memoryButton}
          data-sveltekit-noscroll
          href={memoryHref(address,{view:'analyses',cursor:null})}
          >Analysed sessions</a
        >
        <a
          aria-current={location.view==='review' ? 'page':undefined}
          class={location.view==='review' ? memoryCurrentButton : memoryButton}
          data-sveltekit-noscroll
          href={memoryHref(address,{view:'review',cursor:null})}
          >Pending review</a
        >
        <a
          aria-current={location.view==='knowledge' ? 'page':undefined}
          class={location.view==='knowledge' ? memoryCurrentButton : memoryButton}
          data-sveltekit-noscroll
          href={memoryHref(address,{view:'knowledge',cursor:null})}
          >Knowledge</a
        >
      </nav>
      {#if location.view!=='review'}
        <form class={memoryRow} onsubmit={filter}>
          <label class={memoryField}
            >Project filter<select class={memoryInput} bind:value={project}>
              <option value="">All accessible Projects</option>
              {#each projectsQuery.data?.items ?? [] as known (known.projectId)}
                <option value={known.projectId}>{known.displayName}</option>
              {/each}
            </select></label
          >
          {#if location.view==='analyses'}
            <label class={memoryField}
              >Search session accounts<input
                class={memoryInput}
                maxlength="512"
                placeholder="Investigations, decisions, errors…"
                bind:value={draft}
              ></label
            >
            <label class={memoryField}
              >From (UTC, inclusive)<input class={memoryInput} type="date" bind:value={since}></label
            >
            <label class={memoryField}
              >Before (UTC, exclusive)<input class={memoryInput} type="date" bind:value={until}></label
            >
          {/if}
          <button class={memoryButton} type="submit">Apply filters</button>
          {#if projectsQuery.data?.nextCursor}
            <button
              class={memoryButton}
              onclick={()=>{projectsCursor=projectsQuery.data?.nextCursor ?? null;}}
              type="button"
            >
              More Projects
            </button>
          {/if}
        </form>
        {#if filterError}
          <p class={memoryCopy} role="alert">{filterError}</p>
        {/if}
      {/if}
      {#if location.view==='analyses'}
        <div class={location.analysisId ? layout : memoryStack}>
          <div class={memoryStack}>
            {#if location.periodError}
              <p class={memoryCopy} role="alert">{location.periodError}</p>
            {:else}
              {#key filterIdentity}
                <MemoryAnalysisList {address} input={browseInput} selectedAnalysisId={location.analysisId} />
              {/key}
            {/if}
            {#if projectsQuery.error}
              <p class={memoryCopy} role="alert">
                {memoryAnalysisError(projectsQuery.error,'Recognized Projects could not be read. Retry after checking the local Memory service.')}
              </p>
            {:else if projectsQuery.data}
              <MemoryDiscovery projectId={location.projectId} projects={projectsQuery.data.items} />
            {:else}
              <p class={memoryCopy} role="status">Reading recognized Projects…</p>
            {/if}
          </div>
          {#if location.analysisId && location.analysisProjectId}
            {#if detailModule}
              {@const Detail=detailModule.default}
              {#key location.analysisId}
                <Detail
                  {address}
                  analysisId={location.analysisId}
                  elementKey={location.elementKey}
                  episodeId={location.episodeId}
                  projectId={location.analysisProjectId}
                  projectName={projectsQuery.data?.items.find(item=>item.projectId===location.analysisProjectId)?.displayName ?? 'Selected Project'}
                />
              {/key}
            {:else if detailFailed}
              <p class={memoryCopy}>The account reader could not load.</p>
              <button class={memoryButton} onclick={()=>detailLoader.retry()} type="button">Retry reader</button>
            {:else}
              <p class={memoryCopy} role="status">Opening account reader…</p>
            {/if}
          {:else if location.analysisId}
            <p class={memoryCopy} role="alert">
              This link needs its Project scope. Open an account from the library to get a complete durable link.
            </p>
          {/if}
        </div>
      {:else if location.view==='review'}
        <p class={memoryCopy}>
          Only voluntarily submitted proposals appear here. Review their source and edit the guidance before accepting
          it. Saved session accounts need no acceptance.
        </p>
        {#if snapshot}
          {#if snapshot.proposals.length===0}
            <section aria-live="polite" class={memoryPanel}>No Memory proposals need review.</section>
          {:else}
            {#each snapshot.proposals as proposal (proposal.proposalId)}
              <ProposalReviewCard {onAction} {proposal} spaceId={snapshot.spaceId} />
            {/each}
          {/if}
          <div class={memoryRow}>
            {#if location.cursor}
              <a class={memoryButton} href={memoryHref(address,{cursor:null})}>Newest proposals</a>
            {/if}
            {#if snapshot.nextCursor}
              <a class={memoryButton} data-sveltekit-noscroll href={memoryHref(address,{cursor:snapshot.nextCursor})}
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
        {#key location.projectId}
          <MemoryKnowledge projectId={location.projectId} />
        {/key}
      {/if}
    </div>
  </main>
</div>
