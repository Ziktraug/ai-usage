<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from '../../shell/dirty-navigation-context';
  import SkillsEditorSlot from '../editor/skills-editor-slot.svelte';
  import SkillsHealthSlot from '../management/skills-health-slot.svelte';
  import SkillsMatrixSlot from '../management/skills-matrix-slot.svelte';
  import { createSkillsShellViewModel } from './model';
  import SkillsWorkspace from './skills-workspace.svelte';
  import type { SkillsSnapshotUpdatePort } from './slot-context';
  import {
    syntheticInventories,
    syntheticKnownPaths,
    syntheticManagedDocument,
    syntheticSnapshot,
  } from './synthetic-fixture.test-helper';

  let { pathname = '/skills/global/alpha-skill' }: { pathname?: string } = $props();

  provideDirtyGuardRegistry(createDirtyGuardRegistry());
  const snapshot = syntheticSnapshot();
  const view = $derived(
    createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname,
      snapshot,
    }),
  );
  const snapshotUpdates: SkillsSnapshotUpdatePort = {
    pendingDecision: undefined,
    registerDraft: () => undefined,
    unregisterDraft: () => undefined,
  };
</script>

{#snippet editorSlot(_context)}
  <SkillsEditorSlot context={_context} />
{/snippet}
{#snippet healthSlot(_context)}
  <SkillsHealthSlot context={_context} />
{/snippet}
{#snippet matrixSlot(_context)}
  <SkillsMatrixSlot context={_context} />
{/snippet}

<WebQueryProvider>
  <SkillsWorkspace
    {editorSlot}
    {healthSlot}
    {matrixSlot}
    selectedDocument={syntheticManagedDocument}
    {snapshot}
    {snapshotUpdates}
    {view}
  />
</WebQueryProvider>
