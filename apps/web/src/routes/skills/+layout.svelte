<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { meta } from '@ai-usage/design-system/svelte';
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import RouteFrame from '$lib/features/shell/route-frame.svelte';
  import SkillsEditorSlot from '$lib/features/skills/editor/skills-editor-slot.svelte';
  import SkillsHealthSlot from '$lib/features/skills/management/skills-health-slot.svelte';
  import SkillsMatrixSlot from '$lib/features/skills/management/skills-matrix-slot.svelte';
  import SkillsShell from '$lib/features/skills/shell/skills-shell.svelte';
  import type { SkillsHealthSlotPlacement, SkillsShellSlotContext } from '$lib/features/skills/shell/slot-context';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  let skillsSource = $state(untrack(() => data.source));
  let refreshAction = $state<(() => Promise<void>) | undefined>();
  let refreshPending = $state(false);
  let refreshButtonElement = $state<HTMLButtonElement>();
  const refreshBusyAttributes = $derived({ 'aria-busy': refreshPending ? 'true' : 'false' } as const);
  const refreshButton = css({
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    h: '36px',
    px: '12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'muted',
    fontSize: '12px',
    fontWeight: 650,
    whiteSpace: 'nowrap',
  });
</script>

{#snippet editorSlot(_context: SkillsShellSlotContext)}
  <SkillsEditorSlot context={_context} />
{/snippet}
{#snippet headerMeta()}
  <p class={meta}>Source {skillsSource}</p>
{/snippet}
{#snippet headerActions()}
  <button
    {...refreshBusyAttributes}
    class={refreshButton}
    disabled={refreshPending || refreshAction === undefined}
    onclick={() => refreshAction?.()}
    type="button"
    bind:this={refreshButtonElement}
  >
    Refresh skills
  </button>
{/snippet}

{#snippet healthSlot(
  _context: SkillsShellSlotContext,
  _placement: SkillsHealthSlotPlacement,
)}
  <SkillsHealthSlot
    context={_context}
    onRefreshFocus={() => refreshButtonElement?.focus()}
    onRefreshPendingChange={(pending) => (refreshPending = pending)}
    onRefreshReady={(action) => (refreshAction = action)}
    placement={_placement}
  />
{/snippet}
{#snippet matrixSlot(_context: SkillsShellSlotContext)}
  <SkillsMatrixSlot context={_context} />
{/snippet}

<RouteFrame eyebrow={null} {headerActions} {headerMeta} heading="Skill management">
  <SkillsShell
    {editorSlot}
    {healthSlot}
    hydrationState={data.queryState}
    {matrixSlot}
    navigationState={page.state}
    onSourceChange={(source) => (skillsSource = source)}
    pathname={page.url.pathname}
    runtimeMode={data.runtimeMode}
  />
</RouteFrame>

{@render children()}
