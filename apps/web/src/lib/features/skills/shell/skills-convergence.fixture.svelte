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
  import type { SkillsHealthSlotPlacement, SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';
  import {
    syntheticInventories,
    syntheticKnownPaths,
    syntheticManagedDocument,
    syntheticObservations,
    syntheticProjectDocument,
    syntheticProvisionalObservations,
    syntheticSnapshot,
  } from './synthetic-fixture.test-helper';

  let {
    healthSnapshot,
    observationsError,
    producerCompletenessMissing = false,
    observationsProvisional = false,
    pathname = '/skills/global/alpha-skill',
  }: {
    healthSnapshot?: 'management';
    observationsError?: string;
    producerCompletenessMissing?: boolean;
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
    if (producerCompletenessMissing) {
      return {
        ...syntheticProvisionalObservations,
        producerCompletenessMissing: true,
      };
    }
    return observationsProvisional ? syntheticProvisionalObservations : syntheticObservations;
  });
  // Mirrors the shell, which resolves a managed document for a global selection and a read-only
  // project document for a project one. A fixture that always handed over the managed document made
  // the project branch render its "preview unavailable" placeholder in every test.
  const selectedDocument = $derived(
    view.selectionDetail.kind === 'project-skill' ? syntheticProjectDocument : syntheticManagedDocument,
  );
  const snapshotUpdates: SkillsSnapshotUpdatePort = {
    pendingDecision: undefined,
    registerDraft: () => undefined,
    unregisterDraft: () => undefined,
  };
</script>

{#snippet editorSlot(_context: SkillsShellSlotContext)}
  <SkillsEditorSlot context={_context} />
{/snippet}
{#snippet healthSlot(
  _context: SkillsShellSlotContext,
  _managementPlan: SkillsManagementPlanController,
  _placement: SkillsHealthSlotPlacement,
)}
  <SkillsHealthSlot context={_context} managementPlan={_managementPlan} placement={_placement} />
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
    {selectedDocument}
    snapshot={view.snapshot}
    {snapshotUpdates}
    {view}
  />
</WebQueryProvider>
