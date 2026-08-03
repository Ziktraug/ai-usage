<script lang="ts">
  import { createSkillsShellViewModel } from './model';
  import SkillsWorkspace from './skills-workspace.svelte';
  import {
    syntheticInventories,
    syntheticKnownPaths,
    syntheticManagedDocument,
    syntheticProjectDocument,
    syntheticSnapshot,
  } from './synthetic-fixture.test-helper';

  let {
    pathname = '/skills/global/alpha-skill',
  }: {
    pathname?: string;
  } = $props();

  const wireSnapshot = syntheticSnapshot();
  const view = $derived(
    createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname,
      snapshot: wireSnapshot,
    }),
  );
  const selectedDocument = $derived(
    view.selectionDetail.kind === 'project-skill' ? syntheticProjectDocument : syntheticManagedDocument,
  );
</script>

{#snippet editorSlot(_context)}
  <section aria-label="Synthetic editor slot">
    <h3>Editable SKILL.md</h3>
    <pre>{_context.document?.content}</pre>
  </section>
{/snippet}
{#snippet healthSlot()}
  <section aria-label="Synthetic health slot">Health integration</section>
{/snippet}
{#snippet matrixSlot()}
  <section aria-label="Synthetic matrix slot">Matrix integration</section>
{/snippet}

<SkillsWorkspace {editorSlot} {healthSlot} {matrixSlot} {selectedDocument} snapshot={view.snapshot} {view} />
