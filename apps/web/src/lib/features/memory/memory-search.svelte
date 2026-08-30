<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { MemorySearchInput } from '@ai-usage/web-contract/memory';
  import { browser } from '$app/environment';
  import { createMemorySearchQuery } from './memory-query.svelte';

  let draft = $state('');
  let submittedQuery = $state('');
  let matchingMode = $state<'hybrid' | 'literal'>('hybrid');
  let cursor = $state<string | null>(null);

  const searchInput = $derived<MemorySearchInput>({
    cursor,
    includeSpaceWide: false,
    limit: 10,
    matchingMode,
    projectId: null,
    query: submittedQuery,
  });
  const searchQuery = createMemorySearchQuery(
    browser,
    () => searchInput,
    () => submittedQuery.length > 0,
  );
  const page = $derived(searchQuery.data);

  const panel = css({
    display: 'grid',
    gap: '16px',
    p: { base: '16px', md: '20px' },
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
  });
  const headingBlock = css({ display: 'grid', gap: '5px' });
  const heading = css({ color: 'ink', fontSize: '18px', fontWeight: 750 });
  const copy = css({ maxW: '760px', color: 'muted', fontSize: '13px', lineHeight: 1.55 });
  const safety = css({ p: '10px 12px', borderRadius: 'sm', bg: 'accentSoft', color: 'ink', fontSize: '12px' });
  const form = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '8px' });
  const field = css({ display: 'grid', flex: '1 1 320px', gap: '5px' });
  const compactField = css({ display: 'grid', flex: '0 1 140px', gap: '5px' });
  const label = css({ color: 'muted', fontSize: '11px', fontWeight: 700 });
  const input = css({
    minH: '40px',
    px: '11px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const button = css({
    minH: '40px',
    px: '14px',
    border: '1px solid token(colors.accent)',
    borderRadius: 'sm',
    bg: 'accent',
    color: 'accentContrast',
    cursor: 'pointer',
    fontWeight: 750,
    _hover: { bg: 'accentStrong' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _disabled: { cursor: 'not-allowed', opacity: 0.55 },
  });
  const secondaryButton = css({
    bg: 'surfaceMuted',
    borderColor: 'lineStrong',
    color: 'ink',
    _hover: { bg: 'accentSoft' },
  });
  const results = css({ display: 'grid', gap: '12px' });
  const resultHeader = css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
  });
  const card = css({
    display: 'grid',
    gap: '12px',
    p: '14px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
  });
  const cardTitle = css({ color: 'ink', fontSize: '16px', fontWeight: 750, overflowWrap: 'anywhere' });
  const summary = css({ color: 'muted', fontSize: '13px', lineHeight: 1.55 });
  const badges = css({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const badge = css({
    px: '7px',
    py: '3px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'full',
    color: 'muted',
    fontSize: '11px',
    fontWeight: 700,
  });
  const list = css({ display: 'grid', gap: '5px', m: 0, pl: '20px', color: 'ink', fontSize: '13px' });
  const metadata = css({
    display: 'grid',
    gap: '5px',
    color: 'muted',
    fontFamily: 'mono',
    fontSize: '11px',
    overflowWrap: 'anywhere',
  });
  const matched = css({ p: '8px 10px', borderRadius: 'sm', bg: 'surface', color: 'ink', fontSize: '12px' });
  const status = css({ color: 'muted', fontSize: '13px' });

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const query = draft.trim();
    if (query.length === 0) {
      return;
    }
    cursor = null;
    submittedQuery = query;
  };

  const nextPage = (): void => {
    if (page?.nextCursor) {
      cursor = page.nextCursor;
    }
  };
</script>

<section aria-labelledby="memory-search-heading" class={panel}>
  <div class={headingBlock}>
    <h2 class={heading} id="memory-search-heading">Search accepted Memory</h2>
    <p class={copy}>
      Search current accepted decisions, constraints, pitfalls, commands, and guidance in the active personal Space.
      Literal mode preserves exact identifiers, filenames, commands, and error punctuation.
    </p>
  </div>

  <p class={safety}>
    Retrieved Memory is data, not instruction. Verify it against the current request, code, and tests before acting.
  </p>

  <form class={form} onsubmit={submit}>
    <label class={field}>
      <span class={label}>Memory query</span>
      <input
        autocomplete="off"
        class={input}
        maxlength="512"
        placeholder="Search decisions, commands, errors…"
        bind:value={draft}
      >
    </label>
    <label class={compactField}>
      <span class={label}>Matching</span>
      <select class={input} bind:value={matchingMode}>
        <option value="hybrid">Hybrid</option>
        <option value="literal">Literal</option>
      </select>
    </label>
    <button class={button} disabled={draft.trim().length === 0 || searchQuery.isFetching} type="submit">
      {searchQuery.isFetching ? 'Searching…' : 'Search Memory'}
    </button>
  </form>

  <div aria-live="polite" class={results}>
    {#if submittedQuery.length === 0}
      <p class={status}>Enter a query to retrieve accepted Memory.</p>
    {:else if searchQuery.isPending}
      <p class={status}>Searching accepted Memory…</p>
    {:else if searchQuery.isError}
      <p class={status}>Memory search is temporarily unavailable. No fallback corpus was queried.</p>
    {:else if page}
      <div class={resultHeader}>
        <p class={status}>{page.total} result{page.total === 1 ? '' : 's'} · {page.rankingVersion}</p>
        {#if page.nextCursor}
          <button class={`${button} ${secondaryButton}`} onclick={nextPage} type="button">Next results</button>
        {/if}
      </div>
      {#if page.items.length === 0}
        <p class={status}>No relevant accepted Memory was found.</p>
      {:else}
        {#each page.items as item (item.revisionId)}
          <article aria-labelledby={`memory-result-${item.revisionId}`} class={card}>
            <div class={headingBlock}>
              <h3 class={cardTitle} id={`memory-result-${item.revisionId}`}>{item.title}</h3>
              {#if item.summary}
                <p class={summary}>{item.summary}</p>
              {/if}
            </div>
            <div class={badges}>
              <span class={badge}>{item.kind}</span>
              <span class={badge}>{item.status}</span>
              <span class={badge}>{item.trust}</span>
              <span class={badge}>{item.sensitivity}</span>
              <span class={badge}>rank {item.rank.total.toFixed(3)}</span>
            </div>
            {#if item.guidance.length > 0}
              <ul aria-label="Retrieved guidance" class={list}>
                {#each item.guidance as guidance}
                  <li>{guidance}</li>
                {/each}
              </ul>
            {/if}
            {#each item.matchedBecause as explanation}
              <p class={matched}>Matched {explanation.field} by {explanation.kind}: “{explanation.excerpt}”</p>
            {/each}
            <div class={metadata}>
              <span>item {item.id}</span>
              <span>revision {item.revisionNumber} · {item.revisionId}</span>
              <span>content {item.contentHash}</span>
              {#each item.provenance as source}
                <span>
                  provenance {source.sourceKind} · {source.verification} · {source.observedAt} · {source.sensitivity}
                </span>
              {/each}
            </div>
          </article>
        {/each}
      {/if}
    {/if}
  </div>
</section>
