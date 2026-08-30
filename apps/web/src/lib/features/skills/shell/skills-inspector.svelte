<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { Snippet } from 'svelte';
  import { count } from '../../../../skills-page-model';
  import type { SkillsManagementPlanController } from './management-plan-controller';
  import type { SkillsShellViewModel } from './model';
  import type { SkillsHealthSlotPlacement, SkillsShellSlotContext } from './slot-context';

  let {
    healthSlot,
    managementPlan,
    slotContext,
    view,
  }: {
    healthSlot?: Snippet<[SkillsShellSlotContext, SkillsManagementPlanController, SkillsHealthSlotPlacement]>;
    managementPlan: SkillsManagementPlanController;
    slotContext: SkillsShellSlotContext;
    view: SkillsShellViewModel;
  } = $props();

  const contextPanel = css({ alignSelf: 'start', position: { base: 'static', xl: 'sticky' }, top: '16px' });
  const panelHeader = css({ display: 'grid', gap: '2px' });
  const stack = css({ display: 'grid', gap: '12px' });
  const section = css({ display: 'grid', gap: '7px', pt: '12px', borderTop: '1px solid token(colors.line)' });
  const row = css({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px', fontSize: '13px' });
  const muted = css({ color: 'muted' });
  const path = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  const status = css({ fontWeight: 700, textTransform: 'capitalize' });
</script>

<aside
  aria-label={view.selectionDetail.kind === 'global-skill' ? 'Inspector' : 'Selection actions'}
  class={cx(panel, contextPanel)}
>
  <div class={panelHeader}>
    <h2 class={panelTitle}>{view.selectionDetail.kind === 'global-skill' ? 'Inspector' : 'Context'}</h2>
    <p class={panelSub}>
      {#if view.selectionDetail.kind === 'global-scope'}
        Global source
      {:else if view.selectionDetail.kind === 'global-skill'}
        Global skill
      {:else if view.selectionDetail.kind === 'project-scope'}
        Project scope
      {:else}
        Project skill · read-only
      {/if}
    </p>
  </div>
  <div class={stack}>
    {#if view.selectionDetail.kind === 'project-scope' || view.selectionDetail.kind === 'project-skill'}
      <div class={row}><span class={muted}>Selection</span><strong>{view.selectionLabel}</strong></div>
    {/if}
    {#if view.selectionDetail.kind === 'project-scope'}
      <div class={section}>
        <span class={path}>{view.selectionDetail.project.path}</span>
      </div>
    {:else if view.selectionDetail.kind === 'project-skill'}
      <div class={section}>
        <span class={path}>{view.selectionDetail.project.path}</span>
        <div class={row}>
          <span class={muted}>Observed in</span>
          <span>{count(view.selectionDetail.skill.observations.length, 'runtime')}</span>
        </div>
        <div class={row}>
          <span class={muted}>Status</span><span class={status}>{view.selectionDetail.skill.validationStatus}</span>
        </div>
      </div>
    {/if}
    {#if healthSlot}
      {#if view.selectionDetail.kind === 'global-skill' || view.selectionDetail.kind === 'global-scope'}
        <div data-skills-health-slot>{@render healthSlot(slotContext, managementPlan, 'inspector')}</div>
      {:else}
        <div class={section} data-skills-health-slot>
          {@render healthSlot(slotContext, managementPlan, 'inspector')}
        </div>
      {/if}
    {/if}
  </div>
</aside>
