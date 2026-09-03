<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { meta } from '@ai-usage/design-system/svelte';
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import RouteFrame from '$lib/features/shell/route-frame.svelte';
  import SkillsEditorSlot from '$lib/features/skills/editor/skills-editor-slot.svelte';
  import SkillsHealthSlot from '$lib/features/skills/management/skills-health-slot.svelte';
  import SkillsShell from '$lib/features/skills/shell/skills-shell.svelte';
  import type { SkillsShellSlotContext } from '$lib/features/skills/shell/slot-context';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  let skillsSource = $state(untrack(() => data.source));
  let refreshAction = $state<(() => Promise<void>) | undefined>();
  let reconcileAction = $state<(() => Promise<void>) | undefined>();
  let refreshPending = $state(false);
  let refreshButtonElement = $state<HTMLButtonElement>();
  const refreshBusyAttributes = $derived({ 'aria-busy': refreshPending ? 'true' : 'false' } as const);
  const headerButton = css({
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
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _disabled: { cursor: 'default', opacity: 0.5 },
  });
  const primaryHeaderButton = css({ borderColor: 'accent', color: 'accent' });
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
    class={headerButton}
    disabled={refreshPending || refreshAction === undefined}
    onclick={() => refreshAction?.()}
    type="button"
    bind:this={refreshButtonElement}
  >
    Refresh skills
  </button>
  <button
    class={[headerButton, primaryHeaderButton]}
    data-management-operation="preview-reconcile"
    disabled={refreshPending || reconcileAction === undefined}
    onclick={() => reconcileAction?.()}
    type="button"
  >
    Reconcile links…
  </button>
{/snippet}

{#snippet healthSlot(_context: SkillsShellSlotContext)}
  <SkillsHealthSlot
    context={_context}
    onReconcileReady={(action) => (reconcileAction = action)}
    onRefreshFocus={() => refreshButtonElement?.focus()}
    onRefreshPendingChange={(pending) => (refreshPending = pending)}
    onRefreshReady={(action) => (refreshAction = action)}
  />
{/snippet}

<RouteFrame eyebrow={null} {headerActions} {headerMeta} heading="Skills">
  <SkillsShell
    {editorSlot}
    {healthSlot}
    hydrationState={data.queryState}
    navigationState={page.state}
    onSourceChange={(source) => (skillsSource = source)}
    pathname={page.url.pathname}
    runtimeMode={data.runtimeMode}
  />
</RouteFrame>

{@render children()}
