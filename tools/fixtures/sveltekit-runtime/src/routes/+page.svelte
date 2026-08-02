<script lang="ts">
// biome-ignore lint/correctness/noUnusedVariables: Svelte consumes this value in the template.
const fixtureTitle = 'Meaningful server-rendered content';
</script>

<svelte:head>
  <title>SvelteKit Bun runtime fixture</title>
</svelte:head>

<main data-runtime-fixture="sveltekit-bun">
  <h1>{fixtureTitle}</h1>
</main>
