<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';

  const badge = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    h: '22px',
    px: '9px',
    borderRadius: 'full',
    fontSize: '11px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
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
  const harnessNameSeparator = /[\s-]/;

  const harnessFamily = (name: string): string => {
    const lowerName = name.toLowerCase();
    return badgeTones[lowerName] ? lowerName : (lowerName.split(harnessNameSeparator)[0] ?? '');
  };

  const badgeToneFor = (name: string): string => badgeTones[harnessFamily(name)] ?? badgeNeutral;

  export interface HarnessBadgeProps {
    active?: boolean;
    name: string;
    onClick?: () => void;
    title?: string;
  }
</script>

<script lang="ts">
  import Toggle from './toggle.svelte';

  let { active = false, name, onClick, title }: HarnessBadgeProps = $props();
  const className = $derived(
    cx(badge, badgeToneFor(name), onClick ? badgeButton : undefined, active ? badgeActive : undefined),
  );
  const accessibleTitle = $derived(title ?? `Filter by ${name}`);
</script>

{#if onClick === undefined}
  <span class={className}>{name}</span>
{:else}
  <Toggle
    ariaLabel={accessibleTitle}
    class={className}
    onClick={(event: MouseEvent) => event.stopPropagation()}
    onPressedChange={() => onClick?.()}
    pressed={active}
    title={accessibleTitle}
  >
    {name}
  </Toggle>
{/if}
