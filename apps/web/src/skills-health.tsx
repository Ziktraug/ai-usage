import { css, cx } from '@ai-usage/design-system/css';
import { metricDelta, metricGrid, metricLabel, metricTile, metricValue } from '@ai-usage/design-system/report';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type { SkillHealthSummary } from './skills-page-model';

const dangerValue = css({ color: 'status.danger' });
const warnValue = css({ color: 'status.warn' });

const Tile = (props: { label: string; sublabel: string; tone?: 'danger' | 'warn'; value: string }) => (
  <div class={metricTile}>
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
  </div>
);

export const SkillsHealth = (props: { snapshot: SkillManagementSnapshot; summary: SkillHealthSummary }) => {
  const activeSkillCount = () =>
    props.snapshot.skills.filter((skill) => skill.enabled && skill.validationStatus !== 'invalid').length;
  const activeRuntimeCount = () => props.snapshot.targets.filter((target) => target.enabled).length;
  const repairSublabel = () =>
    props.summary.blockedCount > 0
      ? `${props.summary.toLinkCount} to link · ${props.summary.blockedCount} blocked`
      : `${props.summary.toLinkCount} to link`;

  return (
    <section class={metricGrid}>
      <Tile
        label="Healthy links"
        sublabel={`${activeSkillCount()} active skills · ${activeRuntimeCount()} runtimes`}
        value={`${props.summary.healthyLinkCount}/${props.summary.expectedLinkCount}`}
      />
      <Tile
        label="To repair"
        sublabel={repairSublabel()}
        value={String(props.summary.toRepairCount)}
        {...(props.summary.toRepairCount > 0 ? { tone: 'danger' as const } : {})}
      />
      <Tile
        label="To consolidate"
        sublabel="Grouped by runtime"
        value={String(props.summary.consolidateCount)}
        {...(props.summary.consolidateCount > 0 ? { tone: 'warn' as const } : {})}
      />
      <Tile label="Disabled" sublabel="Kept in source" value={String(props.summary.disabledCount)} />
    </section>
  );
};
