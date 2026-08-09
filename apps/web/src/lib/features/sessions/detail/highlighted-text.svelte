<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const highlightMark = css({ bg: 'accentSoft', color: 'inherit', borderRadius: '2px' });
</script>

<script lang="ts">
  import { boundedSessionListLabel, caseInsensitiveLiteralMatches } from '../../../../session-list-label';

  let { query, text }: { query: string; text: string } = $props();
  const bounded = $derived(boundedSessionListLabel(text, query));
  const segments = $derived.by(() => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [{ match: false, text: bounded }];
    }
    const matches = caseInsensitiveLiteralMatches(bounded, normalizedQuery);
    if (matches.length === 0) {
      return [{ match: false, text: bounded }];
    }
    const parts: { readonly match: boolean; readonly text: string }[] = [];
    let index = 0;
    for (const match of matches) {
      if (match.start > index) {
        parts.push({ match: false, text: bounded.slice(index, match.start) });
      }
      parts.push({ match: true, text: bounded.slice(match.start, match.end) });
      index = match.end;
    }
    if (index < bounded.length) {
      parts.push({ match: false, text: bounded.slice(index) });
    }
    return parts;
  });
</script>

{#each segments as segment, index (`${index}:${segment.match}:${segment.text}`)}
  {#if segment.match}
    <mark class={highlightMark}>{segment.text}</mark>
  {:else}
    {segment.text}
  {/if}
{/each}
