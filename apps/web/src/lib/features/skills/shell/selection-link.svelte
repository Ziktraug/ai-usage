<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { KnownProjectScope, SkillSelection } from '../../../../skills-page-model';
  import { skillSelectionHref } from './navigation';

  let {
    children,
    class: className,
    knownProjects,
    selected = false,
    selection,
    title,
  }: {
    children: Snippet;
    class: string;
    knownProjects: readonly KnownProjectScope[];
    selected?: boolean;
    selection: SkillSelection;
    title?: string | undefined;
  } = $props();

  const href = $derived(skillSelectionHref(selection, knownProjects));
</script>

{#if selected}
  <a aria-current="page" class={className} data-selected="true" data-sveltekit-noscroll href={String(href)} {title}>
    {@render children()}
  </a>
{:else}
  <a class={className} data-sveltekit-noscroll href={String(href)} {title}> {@render children()} </a>
{/if}
