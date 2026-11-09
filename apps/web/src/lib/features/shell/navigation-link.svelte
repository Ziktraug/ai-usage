<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { ShellIconName } from './navigation';
  import NavigationIcon from './navigation-icon.svelte';

  let {
    active,
    class: className,
    href,
    icon,
    label,
    preserveScroll = false,
    indicator = false,
  }: {
    active: boolean;
    class: string;
    href: string;
    icon?: ShellIconName;
    label: string;
    preserveScroll?: boolean;
    indicator?: boolean;
  } = $props();

  // The desktop rail collapses to an icon column between `md` and `xl`. `srOnly` rather than
  // `display: none` keeps the text as the natively computed accessible name at every viewport, so
  // the link still answers to "Skills" once only its icon is drawn. The condition starts at `md`
  // because the mobile manage popover reuses this class below `md` and must keep its labels.
  const linkLabel = css({ srOnly: { md: true, xl: false } });
  const activeIndicator = css({ bg: 'accentSoft' });
  // The hover label the icon rail reveals. Two constraints shape it. It cannot be an `::after` on
  // the link, because Chrome folds generated content into the accessible name and would rename the
  // link "Skills Skills" while hovered or keyboard-focused. And it cannot hold the text as a child
  // node either, because that duplicates the label in the link's `textContent`. So the text is
  // generated inside an `aria-hidden` element: invisible to the accessibility tree and absent from
  // `textContent`. The visibility rules live on the link class in `app-navigation.svelte`, next to
  // the breakpoint that decides whether the real label is drawn.
  const railTooltip = css({
    display: 'none',
    _before: { content: 'attr(data-rail-tooltip)' },
    position: 'absolute',
    insetInlineStart: 'calc(100% + 10px)',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: 50,
    p: '6px 10px',
    borderRadius: 'sm',
    bg: 'ink',
    color: 'canvas',
    fontSize: '12px',
    fontWeight: 650,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    boxShadow: 'overlay',
    pointerEvents: 'none',
  });
</script>

{#snippet body()}
  {#if active && indicator}
    <span aria-hidden="true" class={[activeIndicator, 'nav-indicator']}></span>
  {/if}
  <span class="nav-content" style:view-transition-name={active && indicator ? 'nav-active-content' : 'none'}>
    {#if icon}
      <NavigationIcon name={icon} />
    {/if}
    <span class={linkLabel}>{label}</span>
  </span>
  {#if icon}
    <span aria-hidden="true" class={railTooltip} data-rail-tooltip={label}></span>
  {/if}
{/snippet}

{#if active}
  <a
    aria-current="page"
    class={[className, !indicator && icon && activeIndicator]}
    data-ai-usage-preserve-scroll={preserveScroll ? '' : undefined}
    {href}
    >{@render body()}</a
  >
{:else}
  <a class={className} data-ai-usage-preserve-scroll={preserveScroll ? '' : undefined} {href}>{@render body()}</a>
{/if}

<style>
  .nav-content {
    display: inline-flex;
    gap: inherit;
    align-items: center;
  }
  .nav-indicator {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    border-radius: inherit;
    view-transition-name: nav-indicator;
  }
</style>
