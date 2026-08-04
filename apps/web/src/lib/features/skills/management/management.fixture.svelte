<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import { createSkillsManagementPlanController } from '../shell/management-plan-controller';
  import { createSkillsShellViewModel } from '../shell/model';
  import type { SkillsShellSlotContext, SkillsSnapshotUpdatePort } from '../shell/slot-context';
  import { syntheticInventories, syntheticKnownPaths } from '../shell/synthetic-fixture.test-helper';
  import SkillsHealthSlot from './skills-health-slot.svelte';
  import SkillsMatrixSlot from './skills-matrix-slot.svelte';
  import { syntheticManagementSnapshot } from './synthetic-fixture.test-helper';

  let { pathname = '/skills/global/alpha-skill' }: { pathname?: string } = $props();
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
  const managementPlan = createSkillsManagementPlanController();
  const context = $derived<SkillsShellSlotContext>({ document: undefined, snapshot, snapshotUpdates, view });
</script>

<WebQueryProvider>
  {#if pathname === '/skills/matrix'}
    <SkillsMatrixSlot {context} {managementPlan} />
  {:else}
    <SkillsHealthSlot {context} {managementPlan} />
  {/if}
</WebQueryProvider>
