<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import { harnessFamily } from '../passive/harness-fill';
  import ProviderMark, { hasProviderMark } from '../passive/provider-mark.svelte';

  const badge = css({
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 'full',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  });
  // Sizes share no atom with `badge`: `cx()` resolves conflicting atoms by stylesheet order, not call
  // order. `md` keeps the footprint the dot had, so the badge still fits the 100px table column.
  const badgeSizes = {
    md: css({ gap: '5px', h: '22px', px: '8px', fontSize: '11px' }),
    lg: css({ gap: '7px', h: '30px', px: '12px', fontSize: '13px' }),
  } as const;
  const markSizes = { md: 10, lg: 15 } as const;
  // A harness without a published mark keeps the plain dot, so an unknown tool still reads as a badge.
  const badgeDot = css({
    _before: {
      content: '""',
      w: '6px',
      h: '6px',
      borderRadius: 'full',
      bg: 'currentColor',
    },
  });

  const badgeButton = css({
    appearance: 'none',
    border: '0',
    cursor: 'pointer',
    transition: 'box-shadow 0.15s, transform 0.15s',
    _hover: { boxShadow: '0 0 0 1px token(colors.accent)' },
    _focusVisible: {
      outline: '2px solid token(colors.accent)',
      outlineOffset: '2px',
    },
  });

  const badgeActive = css({ boxShadow: '0 0 0 1.5px token(colors.accent)' });
  const badgeTones: Readonly<Record<string, string>> = {
    claude: css({ bg: 'harness.claude.bg', color: 'harness.claude.fg' }),
    codex: css({ bg: 'harness.codex.bg', color: 'harness.codex.fg' }),
    cursor: css({ bg: 'harness.cursor.bg', color: 'harness.cursor.fg' }),
    opencode: css({ bg: 'harness.opencode.bg', color: 'harness.opencode.fg' }),
    gemini: css({ bg: 'harness.gemini.bg', color: 'harness.gemini.fg' }),
  };
  const badgeNeutral = css({ bg: 'surfaceMuted', color: 'muted' });

  const badgeToneFor = (name: string): string => badgeTones[harnessFamily(name)] ?? badgeNeutral;

  export interface HarnessBadgeProps {
    active?: boolean;
    name: string;
    onClick?: () => void;
    size?: 'lg' | 'md';
    title?: string;
  }
</script>

<script lang="ts">
  import Toggle from './toggle.svelte';

  let { active = false, name, onClick, size = 'md', title }: HarnessBadgeProps = $props();
  const marked = $derived(hasProviderMark(name));
  const className = $derived(
    cx(
      badge,
      badgeSizes[size],
      badgeToneFor(name),
      marked ? undefined : badgeDot,
      onClick ? badgeButton : undefined,
      active ? badgeActive : undefined,
    ),
  );
  const markSize = $derived(markSizes[size]);
  const accessibleTitle = $derived(title ?? `Filter by ${name}`);
</script>

{#if onClick === undefined}
  <span class={className}><ProviderMark {name} size={markSize} />{name}</span>
{:else}
  <Toggle
    ariaLabel={accessibleTitle}
    class={className}
    onClick={(event: MouseEvent) => event.stopPropagation()}
    onPressedChange={() => onClick?.()}
    pressed={active}
    title={accessibleTitle}
  >
    <ProviderMark {name} size={markSize} />{name}
  </Toggle>
{/if}
