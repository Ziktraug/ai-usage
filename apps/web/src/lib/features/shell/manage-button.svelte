<script lang="ts">
  let {
    active = false,
    class: className,
    controls,
    element = $bindable(),
    onToggle,
    open,
  }: {
    active?: boolean;
    class: string;
    controls: string;
    element?: HTMLButtonElement | undefined;
    onToggle: () => void;
    open: boolean;
  } = $props();
</script>

{#if active && open}
  <button
    aria-controls={controls}
    aria-current="page"
    aria-expanded="true"
    class={className}
    onclick={onToggle}
    type="button"
    bind:this={element}
  >
    Manage
  </button>
{:else if active}
  <button
    aria-controls={controls}
    aria-current="page"
    aria-expanded="false"
    class={className}
    onclick={onToggle}
    type="button"
    bind:this={element}
  >
    Manage
  </button>
{:else if open}
  <button
    aria-controls={controls}
    aria-expanded="true"
    class={className}
    onclick={onToggle}
    type="button"
    bind:this={element}
  >
    Manage
  </button>
{:else}
  <button
    aria-controls={controls}
    aria-expanded="false"
    class={className}
    onclick={onToggle}
    type="button"
    bind:this={element}
  >
    Manage
  </button>
{/if}
