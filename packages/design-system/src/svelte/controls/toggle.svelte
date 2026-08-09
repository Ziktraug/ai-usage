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

  const handleClick = (event: MouseEvent): void => {
    onClick?.(event);
    if (disabled || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    onPressedChange(!pressed);
  };
  const controlledStateAttributes = $derived({
    'aria-pressed': pressed,
    'data-pressed': pressed ? '' : undefined,
    'data-state': pressed ? 'on' : 'off',
  });
</script>

<Toggle.Root
  {...controlledStateAttributes}
  aria-label={ariaLabel}
  class={className}
  {disabled}
  onclick={handleClick}
  {pressed}
  {title}
>
  {@render children()}
</Toggle.Root>
