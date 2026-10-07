<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed aria-current enum values for these navigation links. -->
<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { MemoryContractClient } from '@ai-usage/web-contract/memory';
  import type { SessionDistillationBrowseRequest } from '@ai-usage/web-contract/session-distillation';
  import { createInfiniteQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { finiteSwrKey } from '../../query/keys';
  import { browserMemoryClient, continueMemoryAnalysisWindow } from '../../query/options/memory-workspace';
  import { webQueryPolicies } from '../../query/policies';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { memoryAnalysisError } from './memory-errors';
  import { memoryButton, memoryCopy, memoryHeading } from './memory-styles';
  import { analysisTitle, memoryHref } from './memory-url';

  const ROW_HEIGHT = 148;
  const PAGE_SIZE = 20;
  const OVERSCAN = 3;
  let {
    input,
    address,
    selectedAnalysisId = null,
  }: { input: SessionDistillationBrowseRequest; address: string; selectedAnalysisId?: string | null } = $props();
  const rpc = useOptionalWebQueryRpcContext()?.rpc.sessionDistillation;
  const initialCursor = untrack(() => input.cursor);
  const firstPage = 'first-page';
  const initialPageParam = initialCursor ?? firstPage;
  const cursors: string[] = [initialPageParam];
  const pageStarts = new Map<string, number>([[initialPageParam, 0]]);
  let scrollTop = $state(0);
  let height = $state(560);
  let viewport = $state<HTMLElement>();
  let highestCount = $state(0);
  const query = createInfiniteQuery(() => ({
    ...webQueryPolicies.finiteSwr,
    refetchOnMount: false,
    enabled: rpc !== undefined,
    queryKey: finiteSwrKey('memory', 'analysis-library', JSON.stringify({ ...input, cursor: initialCursor })),
    initialPageParam,
    maxPages: 5,
    queryFn: async ({ signal, pageParam }) =>
      await browserMemoryClient(rpc).browse(
        { ...input, cursor: pageParam === firstPage ? null : pageParam, limit: PAGE_SIZE },
        { signal },
      ),
    getNextPageParam: (last, _pages, lastParam) => {
      if (!last.nextCursor) {
        return;
      }
      const index = cursors.indexOf(lastParam);
      pageStarts.set(last.nextCursor, (pageStarts.get(lastParam) ?? 0) + last.items.length);
      if (index >= 0 && cursors[index + 1] !== last.nextCursor) {
        cursors.splice(index + 1, 0, last.nextCursor);
      }
      return last.nextCursor;
    },
    getPreviousPageParam: (_first, _pages, firstParam) => {
      const index = cursors.indexOf(firstParam);
      return index > 0 ? cursors[index - 1] : undefined;
    },
  }));
  const pages = $derived(query.data?.pages ?? []);
  const firstIndex = $derived(
    pageStarts.get(typeof query.data?.pageParams[0] === 'string' ? query.data.pageParams[0] : initialPageParam) ?? 0,
  );
  const rows = $derived(pages.flatMap((page) => page.items));
  const visibleStart = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const visibleEnd = $derived(Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = $derived(
    rows
      .map((item, index) => ({ item, index: index + firstIndex }))
      .filter(({ index }) => index >= visibleStart && index <= visibleEnd),
  );
  $effect(() => {
    highestCount = Math.max(highestCount, firstIndex + rows.length);
  });
  $effect(() => {
    continueMemoryAnalysisWindow(query, {
      active: browser,
      firstIndex,
      rowCount: rows.length,
      visibleStart,
      visibleEnd,
      overscan: OVERSCAN,
    });
  });
  const scroller = css({
    position: 'relative',
    overflowY: 'auto',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    minW: 0,
    overscrollBehavior: 'contain',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const row = css({
    position: 'absolute',
    left: 0,
    right: 0,
    p: '14px 16px',
    display: 'grid',
    gap: '6px',
    alignContent: 'start',
    borderBottom: '1px solid token(colors.line)',
    textDecoration: 'none',
    color: 'ink',
    overflow: 'hidden',
    _hover: { bg: 'surfaceMuted' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
  const selectedRow = css({ bg: 'accentSoft' });
  const title = css({ fontSize: '14px', fontWeight: 650, lineHeight: 1.5, lineClamp: 2 });
  const summary = css({ fontSize: '12px', lineHeight: 1.5, color: 'muted', lineClamp: 1 });
  const metadata = css({
    fontSize: '11px',
    lineHeight: 1.5,
    color: 'muted',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const handleKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const index = Number(target.closest('[data-analysis-index]')?.getAttribute('data-analysis-index'));
    if (!Number.isSafeInteger(index)) {
      return;
    }
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= highestCount) {
      return;
    }
    event.preventDefault();
    viewport?.scrollTo({ top: Math.max(0, next * ROW_HEIGHT - height / 2) });
    requestAnimationFrame(() =>
      viewport?.querySelector<HTMLElement>(`[data-analysis-index="${next}"]`)?.focus({ preventScroll: true }),
    );
  };
</script>
{#if query.isError}
  <p class={memoryCopy} role="alert">
    {memoryAnalysisError(query.error,'The analysis library could not be read. Retry after checking the local Memory service.')}
  </p>
  <button class={memoryButton} onclick={()=>query.refetch()} type="button">Retry library</button>
{:else if query.isPending}
  <p class={memoryCopy} role="status">Reading saved analyses…</p>
{:else if rows.length===0}
  <section>
    <h2 class={memoryHeading}>
      {input.query || input.projectId || input.since || input.until ? 'No analyses match these filters' : 'Your session library starts here'}
    </h2>
    <p class={memoryCopy}>
      Saved accounts appear here without review. Discover a Project below and give its selected sessions to the
      distillation skill. Only lessons you explicitly propose appear in Pending review.
    </p>
  </section>
{:else}
  <nav
    aria-label="Analysed sessions"
    class={`${scroller} analysis-list`}
    data-memory-analysis-list
    onscroll={(event)=>{scrollTop=event.currentTarget.scrollTop;}}
    bind:this={viewport}
    bind:clientHeight={height}
  >
    <div style={`height:${(highestCount+(query.hasNextPage ? 1:0))*ROW_HEIGHT}px;position:relative`}>
      {#each visibleRows as { item, index } (item.id)}
        <a
          aria-current={item.id===selectedAnalysisId ? 'true':undefined}
          class={`${row} ${item.id===selectedAnalysisId ? selectedRow : ''}`}
          data-analysis-index={index}
          data-memory-analysis={item.id}
          data-sveltekit-keepfocus
          data-sveltekit-noscroll
          href={memoryHref(address,{view:'analyses',analysis:item.id,analysisProject:item.projectId,episode:null,element:null})}
          onkeydown={handleKey}
          style={`top:${index*ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
        >
          <span class={metadata}
            >{item.projectName}
            ·
            {item.sessionDate ? new Date(item.sessionDate).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}) : 'Session date unknown'}</span
          >
          <strong class={title}>{analysisTitle(item.summary)}</strong>
          <span class={summary}>{item.summary}</span>
          <span class={metadata}
            >{item.episodeIds.length}
            episode{item.episodeIds.length===1 ? '' : 's'}
            · {item.coverage==='partial' ? 'Partial source coverage' : 'Snapshot covered'} · Generated
            {new Date(item.createdAt).toLocaleDateString()}</span
          >
        </a>
      {/each}
    </div>
  </nav>
  {#if query.isFetching}
    <p class={memoryCopy} role="status">Loading more saved accounts…</p>
  {/if}
  <p class={memoryCopy}>
    Scroll to continue. One current interpretation per session; opening a saved revision keeps it stable. Arrow keys
    move between visible accounts.
  </p>
{/if}

<style>
  /* These viewport bounds belong to Memory and load with its route. */
  .analysis-list {
    height: 440px;
  }

  @media screen and (width >= 48rem) {
    .analysis-list {
      height: 560px;
    }
  }
</style>
