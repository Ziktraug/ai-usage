<script lang="ts">
  let {
    active,
    class: className,
    href,
    label,
    preserveScroll = false,
  }: {
    active: boolean;
    class: string;
    href: string;
    label: string;
    preserveScroll?: boolean;
  } = $props();
</script>

{#if active}
  <!-- biome-ignore lint/a11y/useValidAnchor: `href` is a required typed Svelte prop and is emitted on this anchor. -->
  <a aria-current="page" class={className} data-sveltekit-noscroll={preserveScroll ? '' : undefined} {href}>{label}</a>
{:else}
  <!-- biome-ignore lint/a11y/useValidAnchor: `href` is a required typed Svelte prop and is emitted on this anchor. -->
  <a class={className} data-sveltekit-noscroll={preserveScroll ? '' : undefined} {href}>{label}</a>
{/if}
