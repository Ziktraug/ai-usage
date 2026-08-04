<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import type { Snippet } from 'svelte';
  import { buildSkillHealthSummary, count } from '../../../../skills-page-model';
  import type { SkillsManagementPlanController } from './management-plan-controller';
  import type { SkillsShellViewModel } from './model';
  import type { SkillsShellSlotContext } from './slot-context';

  let {
    healthSlot,
    managementPlan,
    slotContext,
    snapshot,
    view,
  }: {
    healthSlot?: Snippet<[SkillsShellSlotContext, SkillsManagementPlanController]>;
    managementPlan: SkillsManagementPlanController;
    slotContext: SkillsShellSlotContext;
    snapshot: SkillManagementSnapshot;
    view: SkillsShellViewModel;
  } = $props();

  const health = $derived(buildSkillHealthSummary(snapshot));
  const contextPanel = css({ alignSelf: 'start', position: { base: 'static', xl: 'sticky' }, top: '16px' });
  const panelHeader = css({ display: 'grid', gap: '4px', mb: '12px' });
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
    <div class={row}><span class={muted}>Selection</span><strong>{view.selectionLabel}</strong></div>
    {#if view.selectionDetail.kind === 'global-scope'}
      <div class={section}>
        <div class={row}><span class={muted}>Skills</span><span>{snapshot.summary.skillCount}</span></div>
        <div class={row}><span class={muted}>Active</span><span>{snapshot.summary.activeSkillCount}</span></div>
        <div class={row}><span class={muted}>Not linked</span><span>{health.toLinkCount}</span></div>
      </div>
    {:else if view.selectionDetail.kind === 'global-skill'}
      <div class={section}>
        <div class={row}>
          <span class={muted}>Status</span><span class={status}>{view.selectionDetail.skill.validationStatus}</span>
        </div>
        <div class={row}>
          <span class={muted}>Invocation</span>
          <span
            >{view.selectionDetail.skill.manifest.fields.some((field) => field.key === 'disable-model-invocation' && field.value === true) ? 'Manual' : 'Automatic'}</span
          >
        </div>
        <div class={row}>
          <span class={muted}>Tokens</span><span>{view.selectionDetail.skill.tokenCount?.total ?? 'Unknown'}</span>
        </div>
        <span class={path}>{view.selectionDetail.skill.skillMdPath}</span>
      </div>
    {:else if view.selectionDetail.kind === 'project-scope'}
      <div class={section}>
        <span class={path}>{view.selectionDetail.project.path}</span>
        <div class={row}>
          <span class={muted}>Inventories</span><span>{view.selectionDetail.inventories.length}</span>
        </div>
      </div>
    {:else}
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
      <div class={section} data-skills-health-slot>{@render healthSlot(slotContext, managementPlan)}</div>
    {/if}
  </div>
</aside>
