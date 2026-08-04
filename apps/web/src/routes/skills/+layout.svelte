<script lang="ts">
  import { page } from '$app/state';
  import RouteFrame from '$lib/features/shell/route-frame.svelte';
  import SkillsEditorSlot from '$lib/features/skills/editor/skills-editor-slot.svelte';
  import SkillsHealthSlot from '$lib/features/skills/management/skills-health-slot.svelte';
  import SkillsMatrixSlot from '$lib/features/skills/management/skills-matrix-slot.svelte';
  import type { SkillsManagementPlanController } from '$lib/features/skills/shell/management-plan-controller';
  import SkillsShell from '$lib/features/skills/shell/skills-shell.svelte';
  import type { SkillsShellSlotContext } from '$lib/features/skills/shell/slot-context';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
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

<RouteFrame heading="Skill management">
  <SkillsShell
    {editorSlot}
    {healthSlot}
    hydrationState={data.queryState}
    {matrixSlot}
    navigationState={page.state}
    pathname={page.url.pathname}
    runtimeMode={data.runtimeMode}
  />
</RouteFrame>

{@render children()}
