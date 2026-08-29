<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from '../../shell/dirty-navigation-context';
  import SkillsEditorSlot from '../editor/skills-editor-slot.svelte';
  import SkillsHealthSlot from '../management/skills-health-slot.svelte';
  import SkillsMatrixSlot from '../management/skills-matrix-slot.svelte';
  import { syntheticManagementSnapshot } from '../management/synthetic-fixture.test-helper';
  import type { SkillsManagementPlanController } from './management-plan-controller';
  import { createSkillsShellViewModel } from './model';
  import SkillsWorkspace from './skills-workspace.svelte';
  import type { SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';
  import {
    syntheticInventories,
    syntheticKnownPaths,
    syntheticManagedDocument,
    syntheticObservations,
    syntheticProvisionalObservations,
    syntheticSnapshot,
  } from './synthetic-fixture.test-helper';

  let {
    healthSnapshot,
    observationsError,
    observationsProvisional = false,
    pathname = '/skills/global/alpha-skill',
  }: {
    healthSnapshot?: 'management';
    observationsError?: string;
    observationsProvisional?: boolean;
    pathname?: string;
  } = $props();

  provideDirtyGuardRegistry(createDirtyGuardRegistry());
  const snapshot = $derived(healthSnapshot === 'management' ? syntheticManagementSnapshot() : syntheticSnapshot());
  const view = $derived(
    createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname,
      snapshot,
    }),
  );
  const observations = $derived.by(() => {
    if (observationsError !== undefined) {
      return;
    }
    return observationsProvisional ? syntheticProvisionalObservations : syntheticObservations;
  });
  const snapshotUpdates: SkillsSnapshotUpdatePort = {
    pendingDecision: undefined,
    registerDraft: () => undefined,
    unregisterDraft: () => undefined,
  };
</script>

{#snippet editorSlot(_context: SkillsShellSlotContext)}
  <SkillsEditorSlot context={_context} />
{/snippet}
{#snippet healthSlot(_context: SkillsShellSlotContext, _managementPlan: SkillsManagementPlanController)}
  <SkillsHealthSlot context={_context} managementPlan={_managementPlan} />
{/snippet}
{#snippet matrixSlot(_context: SkillsShellSlotContext, _managementPlan: SkillsManagementPlanController)}
  <SkillsMatrixSlot context={_context} managementPlan={_managementPlan} />
{/snippet}

<WebQueryProvider>
  <SkillsWorkspace
    {editorSlot}
    {healthSlot}
    {matrixSlot}
    {observations}
    {observationsError}
    selectedDocument={syntheticManagedDocument}
    snapshot={view.snapshot}
    {snapshotUpdates}
    {view}
  />
</WebQueryProvider>
