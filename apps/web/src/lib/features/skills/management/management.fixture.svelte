<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import { createSkillsPresentationProjection } from '../presentation';
  import { createSkillsShellViewModel } from '../shell/model';
  import type { SkillsShellSlotContext, SkillsSnapshotUpdatePort } from '../shell/slot-context';
  import {
    syntheticInventories,
    syntheticKnownPaths,
    syntheticObservations,
    syntheticProvisionalObservations,
  } from '../shell/synthetic-fixture.test-helper';
  import SkillsHealthSlot from './skills-health-slot.svelte';
  import { syntheticManagementOperationEpisode, syntheticManagementSnapshot } from './synthetic-fixture.test-helper';

  let {
    observationsProvisional = false,
    pathname = '/skills/global/alpha-skill',
  }: { observationsProvisional?: boolean; pathname?: string } = $props();
  const snapshot = syntheticManagementSnapshot();
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
  const management = syntheticManagementOperationEpisode();
  const context = $derived<SkillsShellSlotContext>({
    document: undefined,
    management,
    presentation: createSkillsPresentationProjection({
      observations: observationsProvisional ? syntheticProvisionalObservations : syntheticObservations,
      observationsError: undefined,
      view,
    }),
    snapshot,
    snapshotUpdates,
    view,
  });
</script>

<WebQueryProvider>
  <SkillsHealthSlot {context} />
</WebQueryProvider>
