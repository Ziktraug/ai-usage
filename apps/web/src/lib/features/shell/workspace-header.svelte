<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';

  let {
    heading,
    eyebrow = null,
    description,
    meta,
    actions,
    atmospheric = false,
  }: {
    heading: string;
    eyebrow?: string | null;
    description?: string;
    meta?: Snippet | undefined;
    actions?: Snippet | undefined;
    atmospheric?: boolean;
  } = $props();

  const header = css({
    position: 'relative',
    isolation: 'isolate',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '20px',
    minW: 0,
    minH: { base: '136px', md: '160px' },
    pb: { base: '24px', md: '32px' },
  });
  const atmosphericHeader = css({ minH: { base: '178px', md: '208px' } });
  const copy = css({ position: 'relative', zIndex: 1, display: 'grid', gap: '10px', minW: 0, maxW: '100%' });
  const label = css({
    color: 'muted',
    fontSize: '10px',
    fontWeight: 550,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
  });
  const title = css({
    color: 'ink',
    fontSize: { base: '30px', md: '42px' },
    fontWeight: 450,
    letterSpacing: '-0.045em',
    lineHeight: 1.15,
    overflowWrap: 'anywhere',
  });
  const subtitle = css({ color: 'muted', fontSize: '13px', lineHeight: 1.6, maxW: '65ch' });
  const actionRow = css({
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    maxW: '100%',
    _print: { display: 'none' },
  });
  const atmosphere = css({
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: { base: '25%', md: '38%' },
    insetInlineEnd: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: 0,
    color: 'accent',
    opacity: { base: 0.16, md: 0.2 },
    maskImage: 'linear-gradient(to right, transparent, black 35%)',
    '& svg': { w: 'full', h: 'full' },
    _print: { display: 'none' },
  });
  const contours = Array.from(
    { length: 36 },
    (_, line) =>
      `M ${-140 + line * 10} 350 C ${100 + line * 5} ${300 - line * 8}, ${215 + line * 4} ${-105 + line * 4}, ${405 + line * 5} ${54 + line * 5} S ${530 + line * 8} ${250 - line * 3}, 860 ${-50 + line * 10}`,
  );
</script>

<header class={cx(header, atmospheric && atmosphericHeader)} data-workspace-header>
  {#if atmospheric}
    <div aria-hidden="true" class={atmosphere} data-workspace-atmosphere>
      <svg aria-hidden="true" fill="none" preserveAspectRatio="xMidYMid slice" viewBox="0 0 720 320">
        {#each contours as path}
          <path d={path} stroke="currentColor" stroke-width="1" />
        {/each}
      </svg>
    </div>
  {/if}
  <div class={copy}>
    {#if eyebrow}
      <p class={label}>{eyebrow}</p>
    {/if}
    <h1 class={title}>{heading}</h1>
    {#if description}
      <p class={subtitle}>{description}</p>
    {/if}
    {#if meta}
      {@render meta()}
    {/if}
  </div>
  {#if actions}
    <div class={actionRow}>{@render actions()}</div>
  {/if}
</header>
