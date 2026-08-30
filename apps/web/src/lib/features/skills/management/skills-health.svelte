<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { metricDelta, metricLabel, metricTile, metricValue } from '@ai-usage/design-system/report';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import {
    count,
    healthyLinkTone,
    type SkillCellStateFilter,
    type SkillHealthSummary,
    type SkillHealthTone,
  } from '../../../../skills-page-model';

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
  const dangerValue = css({ color: 'status.danger' });
  const warningValue = css({ color: 'status.warn' });
  const okValue = css({ color: 'status.ok' });
  const healthGrid = css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: '10px',
  });
  const linkTone = $derived(healthyLinkTone(summary));
  const healthToneClass = (tone: SkillHealthTone): string | undefined => {
    if (tone === 'danger') {
      return dangerValue;
    }
    if (tone === 'warn') {
      return warningValue;
    }
    return tone === 'ok' ? okValue : undefined;
  };
  const tileButton = css({
    appearance: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _disabled: {
      cursor: 'default',
      _hover: { borderColor: 'line' },
    },
    '&[data-active=true]': {
      borderColor: 'accent',
      boxShadow: '0 0 0 1px token(colors.accent)',
    },
  });
</script>

<section class={healthGrid} data-skills-health-tiles>
  <button
    class={cx(metricTile, tileButton)}
    data-active={activeFilter === 'linked' ? 'true' : undefined}
    disabled={summary.healthyLinkCount === 0}
    onclick={() => onFilterChange('linked')}
    type="button"
  >
    <div class={metricLabel}>Healthy links</div>
    <div>
      <div class={cx(metricValue, healthToneClass(linkTone))} data-health-tone={linkTone}>
        {summary.healthyLinkCount}
      </div>
      <div class={metricDelta}>
        {count(activeSkillCount, 'active skill')}
        · {activeRuntimeCount} enabled / {snapshot.targets.length} configured
      </div>
    </div>
  </button>
  <button
    class={cx(metricTile, tileButton)}
    data-active={activeFilter === 'not-linked' ? 'true' : undefined}
    disabled={summary.toLinkCount === 0}
    onclick={() => onFilterChange('not-linked')}
    type="button"
  >
    <div class={metricLabel}>To link</div>
    <div>
      <div class={metricValue}>{summary.toLinkCount}</div>
      <div class={metricDelta}>Missing runtime links</div>
    </div>
  </button>
  <button
    class={cx(metricTile, tileButton)}
    data-active={activeFilter === 'broken' ? 'true' : undefined}
    disabled={summary.toRepairCount === 0}
    onclick={() => onFilterChange('broken')}
    type="button"
  >
    <div class={metricLabel}>To repair</div>
    <div>
      <div class={cx(metricValue, summary.toRepairCount > 0 ? dangerValue : undefined)}>
        {summary.toRepairCount}
      </div>
      <div class={metricDelta}>Links to repair</div>
    </div>
  </button>
  <button
    class={cx(metricTile, tileButton)}
    data-active={activeFilter === 'blocked' ? 'true' : undefined}
    disabled={summary.blockedCount === 0}
    onclick={() => onFilterChange('blocked')}
    type="button"
  >
    <div class={metricLabel}>Blocked</div>
    <div>
      <div class={cx(metricValue, summary.blockedCount > 0 ? dangerValue : undefined)}>
        {summary.blockedCount}
      </div>
      <div class={metricDelta}>Copies in place of links</div>
    </div>
  </button>
  <button class={cx(metricTile, tileButton)} disabled type="button">
    <div class={metricLabel}>To consolidate</div>
    <div>
      <div class={cx(metricValue, summary.consolidateCount > 0 ? warningValue : undefined)}>
        {summary.consolidateCount}
      </div>
      <div class={metricDelta}>
        {count(summary.consolidateCopies, 'copy', 'copies')}
        · {count(summary.consolidateSymlinks, 'symlink')}
      </div>
    </div>
  </button>
  <button
    class={cx(metricTile, tileButton)}
    data-active={activeFilter === 'disabled' ? 'true' : undefined}
    disabled={summary.disabledCount === 0}
    onclick={() => onFilterChange('disabled')}
    type="button"
  >
    <div class={metricLabel}>Disabled</div>
    <div>
      <div class={metricValue}>{summary.disabledCount}</div>
      <div class={metricDelta}>Kept in source</div>
    </div>
  </button>
</section>
