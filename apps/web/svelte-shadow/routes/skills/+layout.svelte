<script lang="ts">
  import { page } from '$app/state';
  import RouteFrame from '$lib/features/shell/route-frame.svelte';
  import SkillsEditorSlot from '$lib/features/skills/editor/skills-editor-slot.svelte';
  import SkillsHealthSlot from '$lib/features/skills/management/skills-health-slot.svelte';
  import SkillsMatrixSlot from '$lib/features/skills/management/skills-matrix-slot.svelte';
  import SkillsShell from '$lib/features/skills/shell/skills-shell.svelte';
  import type { SkillsShellSlotContext } from '$lib/features/skills/shell/slot-context';
  import type { LayoutProps } from './$types';

  let { data }: LayoutProps = $props();
</script>

{#snippet editorSlot(_context: SkillsShellSlotContext)}
  <SkillsEditorSlot context={_context} />
{/snippet}
{#snippet healthSlot(_context: SkillsShellSlotContext)}
  <SkillsHealthSlot context={_context} />
{/snippet}
{#snippet matrixSlot(_context: SkillsShellSlotContext)}
  <SkillsMatrixSlot context={_context} />
{/snippet}

<RouteFrame heading="Skill management">
  <SkillsShell {editorSlot} {healthSlot} {matrixSlot} pathname={page.url.pathname} runtimeMode={data.runtimeMode} />
</RouteFrame>
