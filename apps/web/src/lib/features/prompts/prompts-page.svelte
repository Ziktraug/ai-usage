<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { page as pageClass, shell } from '@ai-usage/design-system/svelte';
  import type { PromptCorpusEntry } from '@ai-usage/report-core/prompt-corpus';
  import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';
  import { browser } from '$app/env';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    continuePromptCorpus,
    PROMPT_CORPUS_CLIENT_PAGE_LIMIT,
    promptCorpusQueryOptions,
  } from '../../query/options/prompts';
  import { optionalSessionLookupQueryOptions } from '../../query/options/session';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createSessionClientAdapter } from '../../rpc/session-client';
  import { ssrUnavailableClient } from '../../rpc/ssr-placeholder';
  import { createSyntheticCampaignClient } from '../campaigns/campaigns-synthetic';
  import { sessionDetailFixtureResponse } from '../sessions/detail/session-detail.fixtures';
  import SessionDetailQuerySlot from '../sessions/detail/session-detail-query-slot.svelte';
  import WorkspaceHeader from '../shell/workspace-header.svelte';
  import type { PromptsPageData } from './prompts-load';
  import { promptRequestForUrl } from './prompts-model';
  import { syntheticPromptCorpus } from './prompts-synthetic';
  import SessionEvidence from './session-evidence.svelte';

  let { data }: { data: PromptsPageData } = $props();
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const queryClient = useQueryClient();
  const clients = untrack(() => {
    if (data.mode !== 'live') {
      return {
        corpus: { prompts: syntheticPromptCorpus },
        session: {
          ...createSyntheticCampaignClient(),
          detail: (detailRequest: { revision: string; rowId: string }) =>
            Promise.resolve(sessionDetailFixtureResponse(detailRequest.revision, detailRequest.rowId)),
        },
      };
    }
    return {
      corpus: rpc?.session ?? ssrUnavailableClient<NonNullable<typeof rpc>['session']>('prompt corpus'),
      session: rpc
        ? createSessionClientAdapter(rpc.session)
        : ssrUnavailableClient<ReturnType<typeof createSessionClientAdapter>>('prompt detail'),
    };
  });
  const request = $derived(promptRequestForUrl(new URL(page.url.href), data.revision));
  const corpus = createInfiniteQuery(() => promptCorpusQueryOptions(clients.corpus, request, browser));
  const pages = $derived(corpus.data?.pages ?? []);
  const entries = $derived([
    ...new Map(pages.flatMap((item) => item.entries).map((entry) => [entry.id, entry])).values(),
  ]);
  const scanned = $derived(pages.reduce((sum, item) => sum + item.scannedSessions, 0));
  const unavailable = $derived(pages.reduce((sum, item) => sum + item.unavailableSessions, 0));
  const partial = $derived(pages.reduce((sum, item) => sum + item.partialSessions + item.truncatedPrompts, 0));
  const selected = $derived(page.url.searchParams.get('selectedSession'));
  const lookup = createQuery(() =>
    optionalSessionLookupQueryOptions(
      clients.session,
      selected ? { revision: data.revision, rowId: selected } : undefined,
      { browser },
    ),
  );
  const selectedRow = $derived(lookup.data?.ok ? lookup.data.data.row : null);
  const onOpen = (entry: PromptCorpusEntry) => {
    const next = new URL(page.url.href);
    next.searchParams.set('selectedSession', entry.rowId);
    return goto(next, { reset: false });
  };
  const close = () => {
    const next = new URL(page.url.href);
    next.searchParams.delete('selectedSession');
    return goto(next, { reset: false });
  };
  const exportJson = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            revision: data.revision,
            filters: request,
            coverage: { scanned, unavailable, partial, continuation: corpus.hasNextPage },
            entries,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'prompts.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const formClass = css({ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'end', mb: '24px' });
  const labelClass = css({ display: 'grid', gap: '6px', color: 'muted', fontSize: '12px', minW: 0, maxW: '100%' });
  const inputClass = css({
    border: '1px solid token(colors.line)',
    bg: 'surface',
    color: 'ink',
    p: '8px',
    borderRadius: 'sm',
    maxW: '100%',
    minW: 0,
  });
  const listClass = css({ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: '12px' });
  const entryClass = css({
    borderTop: '1px solid token(colors.line)',
    py: '16px',
    display: 'grid',
    gap: '10px',
    minW: 0,
  });
  const muted = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6 });
  const promptClass = css({
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: 'ink',
    fontSize: '14px',
    lineHeight: 1.6,
    m: 0,
  });
</script>
<main class={pageClass} data-route-shell="prompts">
  <div class={shell}>
    <WorkspaceHeader
      description="Find your requests across local sessions, then inspect their recorded rounds. Human origin follows the harness declaration."
      eyebrow="Empreintes"
      heading="Prompts"
    />
    {#if data.mode !== 'live'}
      <p class={muted}>Synthetic example corpus. No local histories are read.</p>
    {/if}
    <form action="/prompts" class={formClass} method="GET">
      <label class={labelClass}
        >Search prompt text<input
          class={inputClass}
          maxlength="200"
          name="q"
          type="search"
          value={page.url.searchParams.get('q') ?? ''}
        ></label
      >
      <label class={labelClass}
        >Project label (exact)<input
          class={inputClass}
          name="project"
          value={page.url.searchParams.get('project') ?? ''}
        ></label
      >
      <label class={labelClass}
        >Harness<select class={inputClass} name="harness" value={page.url.searchParams.get('harness') ?? ''}>
          <option value="">All harnesses</option>
          <option>Codex</option>
          <option value="Claude">Claude Code</option>
          <option>OpenCode</option>
        </select></label
      >
      <label class={labelClass}
        >From (UTC)<input
          class={inputClass}
          name="from"
          type="date"
          value={page.url.searchParams.get('from') ?? ''}
        ></label
      >
      <label class={labelClass}
        >Through (UTC)<input
          class={inputClass}
          name="to"
          type="date"
          value={page.url.searchParams.get('to') ?? ''}
        ></label
      >
      <label class={labelClass}
        ><span
          ><input checked={request.includeUndeclared} name="includeUndeclared" type="checkbox" value="1">
          Include sessions without declared origin</span
        ></label
      >
      <button class={ghostButton} type="submit">Search</button>
    </form>
    {#if corpus.isError}
      <p role="alert">Prompt history could not be read. {corpus.error?.message}</p>
      <button class={ghostButton} onclick={() => corpus.refetch()} type="button">Retry</button>
      <a class={ghostButton} href={page.url.href}>Reload current publication</a>
    {/if}
    <p aria-live="polite" class={muted}>
      {entries.length}
      prompts shown · {scanned} session reads · {unavailable} unavailable histories · {partial} partial histories or
      excerpts.
      {#if corpus.isError}
        Coverage is unavailable for the failed request.
      {:else if corpus.hasNextPage}
        More history remains to be searched.
      {:else if pages.length}
        End of this report corpus.
      {:else}
        Reading the first corpus page.
      {/if}
    </p>
    <p class={muted}>
      Up to 12 session histories per request and 100 prompts per page. Excerpts are limited to 2,000 characters; search
      examines the available full prompt bodies. Native files may change between reads.
    </p>
    <button class={ghostButton} disabled={!(mounted && entries.length)} onclick={exportJson} type="button">
      Export loaded prompts
    </button>
    {#if corpus.isPending}
      <p role="status">Reading prompt histories…</p>
    {:else if !(entries.length || corpus.isError)}
      <p>
        {corpus.hasNextPage
          ? 'No matches in the histories examined so far. Continue the search below.'
          : 'No matching prompts in the available histories examined.'}
      </p>
    {/if}
    <ol class={listClass}>
      {#each entries as entry (entry.id)}
        <li class={entryClass}>
          <div class={muted}>
            {entry.project}
            · {entry.harness} · <time datetime={entry.at}>{entry.at.slice(0, 16).replace('T', ' ')} UTC</time> ·
            {entry.origin === 'human' ? 'Declared human origin' : 'Origin not declared'}{entry.partial
              ? ' · Partial history or excerpt'
              : ''}
          </div>
          <p class={promptClass}>{entry.text}</p>
          <div>
            <button class={ghostButton} disabled={!mounted} onclick={() => onOpen(entry)} type="button">
              Read session rounds
            </button>
          </div>
          <SessionEvidence revision={data.revision} rowId={entry.rowId} synthetic={data.mode !== 'live'} />
        </li>
      {/each}
    </ol>
    {#if corpus.hasNextPage}
      <button
        class={ghostButton}
        disabled={corpus.isFetchingNextPage || pages.length >= PROMPT_CORPUS_CLIENT_PAGE_LIMIT}
        onclick={() => continuePromptCorpus(corpus)}
        type="button"
      >
        {corpus.isFetchingNextPage ? 'Searching…' : 'Continue searching histories'}
      </button>
    {/if}
    {#if pages.length >= PROMPT_CORPUS_CLIENT_PAGE_LIMIT}
      <p class={muted}>
        This view reached its 40-page memory budget. Narrow the project, harness or period before starting another
        search.
      </p>
    {/if}
    {#if lookup.isError}
      <p role="alert">The selected session could not be read.</p>
    {/if}
    <SessionDetailQuerySlot
      client={clients.session}
      onSelectionChange={(next) => {
        if (next === null && selectedRow) {
          close();
        }
      }}
      {queryClient}
      rows={selectedRow ? [selectedRow] : []}
      selection={selectedRow ? { row: selectedRow, revision: data.revision } : null}
    />
  </div>
</main>
