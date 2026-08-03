<script lang="ts">
  let {
    class: className,
    controls,
    element = $bindable(),
    onToggle,
    open,
  }: {
    class: string;
    controls: string;
    element?: HTMLButtonElement | undefined;
    onToggle: () => void;
    open: boolean;
  } = $props();
</script>

{#if open}
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
