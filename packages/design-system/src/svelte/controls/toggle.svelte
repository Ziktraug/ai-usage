<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export interface ToggleProps {
    ariaLabel: string;
    children: Snippet;
    class?: string;
    disabled?: boolean;
    onClick?: (event: MouseEvent) => void;
    onPressedChange: (pressed: boolean) => void;
    pressed: boolean;
    title?: string;
  }
</script>

<script lang="ts">
  import { Toggle } from '@ark-ui/svelte/toggle';

  let {
    ariaLabel,
    children,
    class: className,
    disabled = false,
    onClick,
    onPressedChange,
    pressed,
    title,
  }: ToggleProps = $props();
</script>

<Toggle.Root aria-label={ariaLabel} class={className} {disabled} onclick={onClick} {onPressedChange} {pressed} {title}>
  {@render children()}
</Toggle.Root>
