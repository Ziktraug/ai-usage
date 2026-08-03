<script lang="ts">
  import { createSkillsShellViewModel } from './model';
  import SkillsWorkspace from './skills-workspace.svelte';
  import type { SkillsSnapshotUpdatePort } from './slot-context';
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
  const snapshotUpdates: SkillsSnapshotUpdatePort = {
    pendingDecision: undefined,
    registerDraft: () => undefined,
    unregisterDraft: () => undefined,
  };
</script>

{#snippet editorSlot(_context)}
  <section aria-label="Synthetic editor slot">
    <h3>Editable SKILL.md</h3>
    <pre>{_context.document?.content}</pre>
    <span data-p9-slot-contract>{_context.snapshotUpdates.pendingDecision ? 'pending' : 'settled'}</span>
  </section>
{/snippet}
{#snippet healthSlot(_context)}
  <section aria-label="Synthetic health slot">Health integration · {_context.snapshot.summary.skillCount}</section>
{/snippet}
{#snippet matrixSlot(_context)}
  <section aria-label="Synthetic matrix slot">
    Matrix integration · {_context.snapshotUpdates.pendingDecision ? 'pending' : 'settled'}
  </section>
{/snippet}

<SkillsWorkspace
  {editorSlot}
  {healthSlot}
  {matrixSlot}
  {selectedDocument}
  snapshot={view.snapshot}
  {snapshotUpdates}
  {view}
/>
