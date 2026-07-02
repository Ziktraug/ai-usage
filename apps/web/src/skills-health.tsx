import { css, cx } from '@ai-usage/design-system/css';
import { metricDelta, metricGrid, metricLabel, metricTile, metricValue } from '@ai-usage/design-system/report';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { count, type SkillCellStateFilter, type SkillHealthSummary } from './skills-page-model';

const dangerValue = css({ color: 'status.danger' });
const warnValue = css({ color: 'status.warn' });

const tileButton = css({
  appearance: 'none',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: {
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
  _disabled: {
    cursor: 'default',
    _hover: {
      borderColor: 'line',
    },
  },
  '&[data-active=true]': {
    borderColor: 'accent',
    boxShadow: '0 0 0 1px token(colors.accent)',
  },
});

const Tile = (props: {
  active?: boolean;
  filter?: SkillCellStateFilter;
  label: string;
  onFilterChange: (filter: SkillCellStateFilter) => void;
  sublabel: string;
  tone?: 'danger' | 'warn';
  value: number;
}) => (
  <button
    class={cx(metricTile, tileButton)}
    data-active={props.active ? 'true' : undefined}
    disabled={props.filter === undefined || props.value === 0}
    onClick={() => {
      if (props.filter !== undefined) {
        props.onFilterChange(props.filter);
      }
    }}
    type="button"
  >
    <div class={metricLabel}>{props.label}</div>
    <div>
      <div
        class={cx(
          metricValue,
          props.tone === 'danger' ? dangerValue : undefined,
          props.tone === 'warn' ? warnValue : undefined,
        )}
      >
        {props.value}
      </div>
      <div class={metricDelta}>{props.sublabel}</div>
    </div>
  </button>
);

export const SkillsHealth = (props: {
  activeFilter: SkillCellStateFilter | undefined;
  onFilterChange: (filter: SkillCellStateFilter) => void;
  snapshot: SkillManagementSnapshot;
  summary: SkillHealthSummary;
}) => {
  const activeSkillCount = () =>
    props.snapshot.skills.filter((skill) => skill.enabled && skill.validationStatus !== 'invalid').length;
  const activeRuntimeCount = () => props.snapshot.targets.filter((target) => target.enabled).length;

  return (
    <section class={metricGrid}>
      <Tile
        active={props.activeFilter === 'linked'}
        filter="linked"
        label="Healthy links"
        onFilterChange={props.onFilterChange}
        sublabel={`${count(activeSkillCount(), 'active skill')} · ${activeRuntimeCount()} enabled / ${
          props.snapshot.targets.length
        } configured`}
        value={props.summary.healthyLinkCount}
      />
      <Tile
        active={props.activeFilter === 'not-linked'}
        filter="not-linked"
        label="To link"
        onFilterChange={props.onFilterChange}
        sublabel="Missing runtime links"
        value={props.summary.toLinkCount}
      />
      <Tile
        active={props.activeFilter === 'broken'}
        filter="broken"
        label="Broken"
        onFilterChange={props.onFilterChange}
        sublabel="Links to repair"
        value={props.summary.toRepairCount}
        {...(props.summary.toRepairCount > 0 ? { tone: 'danger' as const } : {})}
      />
      <Tile
        active={props.activeFilter === 'blocked'}
        filter="blocked"
        label="Blocked"
        onFilterChange={props.onFilterChange}
        sublabel="Copies in place of links"
        value={props.summary.blockedCount}
        {...(props.summary.blockedCount > 0 ? { tone: 'danger' as const } : {})}
      />
      <Tile
        label="To consolidate"
        onFilterChange={props.onFilterChange}
        sublabel={`${count(props.summary.consolidateCopies, 'copy', 'copies')} · ${count(
          props.summary.consolidateSymlinks,
          'symlink',
        )}`}
        value={props.summary.consolidateCount}
        {...(props.summary.consolidateCount > 0 ? { tone: 'warn' as const } : {})}
      />
      <Tile
        active={props.activeFilter === 'disabled'}
        filter="disabled"
        label="Disabled"
        onFilterChange={props.onFilterChange}
        sublabel="Kept in source"
        value={props.summary.disabledCount}
      />
    </section>
  );
};
