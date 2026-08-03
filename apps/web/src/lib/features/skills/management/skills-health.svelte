<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import { count, type SkillCellStateFilter, type SkillHealthSummary } from '../../../../skills-page-model';
  import { dangerValue, metricButton, metricGrid, metricValue, muted, warningValue } from './styles';

  let {
    activeFilter,
    onFilterChange,
    snapshot,
    summary,
  }: {
    activeFilter?: SkillCellStateFilter;
    onFilterChange: (filter: SkillCellStateFilter) => void;
    snapshot: SkillManagementSnapshot;
    summary: SkillHealthSummary;
  } = $props();

  const activeSkillCount = $derived(
    snapshot.skills.filter((skill) => skill.enabled && skill.validationStatus !== 'invalid').length,
  );
  const activeRuntimeCount = $derived(snapshot.targets.filter((target) => target.enabled).length);
</script>

<section class={metricGrid}>
  <button
    class={metricButton}
    data-active={activeFilter === 'linked' ? 'true' : undefined}
    disabled={summary.healthyLinkCount === 0}
    onclick={() => onFilterChange('linked')}
    type="button"
  >
    <span class={muted}>Healthy links</span><strong class={metricValue}>{summary.healthyLinkCount}</strong>
    <span class={muted}
      >{count(activeSkillCount, 'active skill')}
      · {activeRuntimeCount} enabled / {snapshot.targets.length} configured</span
    >
  </button>
  <button
    class={metricButton}
    data-active={activeFilter === 'not-linked' ? 'true' : undefined}
    disabled={summary.toLinkCount === 0}
    onclick={() => onFilterChange('not-linked')}
    type="button"
  >
    <span class={muted}>To link</span><strong class={metricValue}>{summary.toLinkCount}</strong
    ><span class={muted}>Missing runtime links</span>
  </button>
  <button
    class={metricButton}
    data-active={activeFilter === 'broken' ? 'true' : undefined}
    disabled={summary.toRepairCount === 0}
    onclick={() => onFilterChange('broken')}
    type="button"
  >
    <span class={muted}>Broken</span
    ><strong class={cx(metricValue, summary.toRepairCount > 0 ? dangerValue : undefined)}
      >{summary.toRepairCount}</strong
    ><span class={muted}>Links to repair</span>
  </button>
  <button
    class={metricButton}
    data-active={activeFilter === 'blocked' ? 'true' : undefined}
    disabled={summary.blockedCount === 0}
    onclick={() => onFilterChange('blocked')}
    type="button"
  >
    <span class={muted}>Blocked</span
    ><strong class={cx(metricValue, summary.blockedCount > 0 ? dangerValue : undefined)}>{summary.blockedCount}</strong
    ><span class={muted}>Copies in place of links</span>
  </button>
  <div class={metricButton}>
    <span class={muted}>To consolidate</span
    ><strong class={cx(metricValue, summary.consolidateCount > 0 ? warningValue : undefined)}
      >{summary.consolidateCount}</strong
    >
    <span class={muted}
      >{count(summary.consolidateCopies, 'copy', 'copies')}
      · {count(summary.consolidateSymlinks, 'symlink')}</span
    >
  </div>
  <button
    class={metricButton}
    data-active={activeFilter === 'disabled' ? 'true' : undefined}
    disabled={summary.disabledCount === 0}
    onclick={() => onFilterChange('disabled')}
    type="button"
  >
    <span class={muted}>Disabled</span><strong class={metricValue}>{summary.disabledCount}</strong
    ><span class={muted}>Kept in source</span>
  </button>
</section>
