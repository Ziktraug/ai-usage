<script lang="ts" module>
  let atmosphereDrawn = false;
</script>

<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { onMount, type Snippet } from 'svelte';
  import { atmosphereContours } from './header-atmosphere';

  let {
    heading,
    eyebrow = null,
    description,
    meta,
    actions,
    variant,
  }: {
    heading: string;
    eyebrow?: string | null;
    description?: string;
    meta?: Snippet | undefined;
    actions?: Snippet | undefined;
    variant?: string;
  } = $props();

  const header = css.raw({
    position: 'relative',
    isolation: 'isolate',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '20px',
    minW: 0,
    pb: '12px',
  });
  const copy = css({ position: 'relative', zIndex: 1, display: 'grid', gap: '6px', minW: 0, maxW: '100%' });
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
    '& svg': { w: 'full', h: 'full' },
    _print: { display: 'none' },
    _highContrast: { display: 'none' },
  });
  const contours = $derived(atmosphereContours(variant ?? heading));
  const draw = !atmosphereDrawn;
  onMount(() => {
    atmosphereDrawn = true;
  });
</script>

<header class={css(header)} data-workspace-header>
  <div aria-hidden="true" class={[atmosphere, draw && 'draw']} data-workspace-atmosphere>
    <div class="atmosphere-motion">
      <svg aria-hidden="true" fill="none" preserveAspectRatio="none" viewBox="0 -140 720 560">
        {#each contours as path, index}
          <path
            d={path}
            pathLength="1"
            stroke="currentColor"
            stroke-width="1"
            style:animation-delay={`${index * 12}ms`}
          />
        {/each}
      </svg>
    </div>
  </div>
  <div class={copy} style:view-transition-name="workspace-copy">
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
    <div class={actionRow} style:view-transition-name="workspace-actions">{@render actions()}</div>
  {/if}
</header>

<style>
  h1 {
    view-transition-name: workspace-title;
  }
  [data-workspace-atmosphere] {
    view-transition-name: workspace-atmosphere;
  }
  .atmosphere-motion {
    width: 100%;
    height: 100%;
    mask-image: linear-gradient(to right, transparent, black 35%);
    transform-origin: center;
    animation: drift 50s ease-in-out infinite alternate;
    will-change: transform;
  }
  .draw path {
    animation: draw-in 780ms ease-out both;
  }
  @keyframes drift {
    from {
      transform: translate(-8px, 3px) scale(1);
    }
    to {
      transform: translate(12px, -5px) scale(1.025);
    }
  }
  @keyframes draw-in {
    from {
      stroke-dasharray: 1;
      stroke-dashoffset: 1;
    }
    to {
      stroke-dasharray: 1;
      stroke-dashoffset: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .atmosphere-motion,
    .draw path {
      animation: none;
    }
    .atmosphere-motion {
      will-change: auto;
    }
  }
  @media print {
    .atmosphere-motion,
    .draw path {
      animation: none;
    }
  }
</style>
