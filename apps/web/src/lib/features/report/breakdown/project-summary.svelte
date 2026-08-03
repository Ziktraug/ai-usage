<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import { projectDataQualityLabel } from '../../../../project-presentation';
  import { fmtCompact, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';

  const desktopTableSurface = css({ display: { base: 'none', md: 'block' } });
  const mobileSummarySurface = css({ display: { base: 'grid', md: 'none' } });
  const empty = css({ p: '24px', color: 'muted', textAlign: 'center' });
  const groupKeyButton = css({ color: 'accent', textAlign: 'left', cursor: 'pointer', fontWeight: 700 });
  const tableWrap = css({ overflowX: 'auto' });
  const table = css({ w: 'full', borderCollapse: 'collapse', fontSize: '12px' });
  const projectTable = css({ minW: '840px' });
  const right = css({ textAlign: 'right' });
  const numCell = css({
    p: '8px',
    borderBottom: '1px solid token(colors.line)',
    textAlign: 'right',
    textStyle: 'numeric',
  });
  const strongCell = css({ p: '8px', borderBottom: '1px solid token(colors.line)', fontWeight: 700 });
  const statusPill = css({ px: '7px', py: '2px', borderRadius: 'full', fontSize: '10px' });
  const statusPillInfo = css({ bg: 'accentTint', color: 'accent' });
  const projectSummaryList = css({ display: 'grid', gap: '10px', listStyle: 'none', p: 0, m: 0 });
  const projectSummaryCard = css({
    display: 'grid',
    gap: '10px',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
  });
  const projectSummaryHeader = css({ display: 'flex', justifyContent: 'space-between', gap: '10px' });
  const projectSummaryHeadline = css({ display: 'grid', justifyItems: 'end', gap: '2px' });
  const projectSummaryCost = css({ fontWeight: 750, textStyle: 'numeric' });
  const projectSummarySessions = css({ color: 'muted', fontSize: '11px' });
  const projectSummaryMetrics = css({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' });
  const projectSummaryMetric = css({ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px' });

  let {
    groups,
    onManageProjectGroups,
    onProjectFilter,
  }: {
    groups: readonly ProjectGroup[];
    onManageProjectGroups: () => void;
    onProjectFilter: (value: string) => void;
  } = $props();

  const identity = css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minW: 0 });
  const qualityAction = css({
    cursor: 'pointer',
    fontFamily: 'sans',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const lineMeasurement = (project: ProjectGroup): string => {
    const { measuredSessions, totalSessions } = project.lineMeasurement;
    if (measuredSessions === 0) {
      return '—';
    }
    const measuredLines = `+${fmtNum(project.linesAdded)}/-${fmtNum(project.linesDeleted)}`;
    return measuredSessions < totalSessions
      ? `${measuredLines} · ${fmtNum(measuredSessions)}/${fmtNum(totalSessions)} measured`
      : measuredLines;
  };
  const valueFor = (project: ProjectGroup) =>
    apiValuePresentation({ costApprox: project.cost, costKnown: project.priced === project.sessions });
</script>

{#if groups.length === 0}
  <div class={empty}>No projects</div>
{:else}
  <div class={cx(tableWrap, desktopTableSurface)}>
    <table class={cx(table, projectTable)}>
      <thead>
        <tr>
          <th>Project</th>
          <th class={right}>Sessions</th>
          <th class={right}>Fresh</th>
          <th class={right}>Cache</th>
          <th class={right}>API value</th>
          <th class={right}>Lines</th>
          <th class={right}>Turns</th>
          <th class={right}>Tools</th>
        </tr>
      </thead>
      <tbody>
        {#each groups as project (project.key)}
          {@const quality = projectDataQualityLabel(project.label)}
          {@const value = valueFor(project)}
          <tr>
            <td
              class={strongCell}
              title={project.label === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
            >
              <div class={identity}>
                <button class={groupKeyButton} onclick={() => onProjectFilter(project.key)} type="button">
                  {project.label}
                </button>
                {#if quality}
                  <button
                    class={cx(statusPill, statusPillInfo, qualityAction)}
                    data-project-quality-label={quality}
                    onclick={onManageProjectGroups}
                    title="Open Manage project groups"
                    type="button"
                  >
                    {quality}
                  </button>
                {/if}
              </div>
            </td>
            <td class={numCell}>{fmtNum(project.sessions)}</td>
            <td class={numCell} title={fmtNum(project.fresh)}>{fmtCompact(project.fresh)}</td>
            <td class={numCell} title={fmtNum(project.cache)}>{fmtCompact(project.cache)}</td>
            <td class={numCell}><span title={value.title}>{value.label}</span></td>
            <td class={numCell}>{lineMeasurement(project)}</td>
            <td class={numCell}>{fmtNum(project.turns)}</td>
            <td class={numCell}>{fmtNum(project.tools)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <ul aria-label="Project summaries" class={cx(mobileSummarySurface, projectSummaryList)}>
    {#each groups as project (project.key)}
      {@const quality = projectDataQualityLabel(project.label)}
      {@const value = valueFor(project)}
      <li class={projectSummaryCard}>
        <header class={projectSummaryHeader}>
          <div class={identity}>
            <button
              class={groupKeyButton}
              onclick={() => onProjectFilter(project.key)}
              title={project.label === '(unknown)' ? 'Filter sessions without a detected project directory' : `Filter sessions by ${project.label}`}
              type="button"
            >
              {project.label}
            </button>
            {#if quality}
              <button
                class={cx(statusPill, statusPillInfo, qualityAction)}
                data-project-quality-label={quality}
                onclick={onManageProjectGroups}
                title="Open Manage project groups"
                type="button"
              >
                {quality}
              </button>
            {/if}
          </div>
          <div class={projectSummaryHeadline}>
            <span class={projectSummaryCost} title={value.title}>{value.label}</span
            ><span class={projectSummarySessions}>{fmtNum(project.sessions)} sessions</span>
          </div>
        </header>
        <dl class={projectSummaryMetrics}>
          <div class={projectSummaryMetric}>
            <dt>Fresh</dt>
            <dd title={fmtNum(project.fresh)}>{fmtCompact(project.fresh)}</dd>
          </div>
          <div class={projectSummaryMetric}>
            <dt>Cache</dt>
            <dd title={fmtNum(project.cache)}>{fmtCompact(project.cache)}</dd>
          </div>
          <div class={projectSummaryMetric}>
            <dt>Lines</dt>
            <dd>{lineMeasurement(project)}</dd>
          </div>
          <div class={projectSummaryMetric}>
            <dt>Turns</dt>
            <dd>{fmtNum(project.turns)}</dd>
          </div>
          <div class={projectSummaryMetric}>
            <dt>Tools</dt>
            <dd>{fmtNum(project.tools)}</dd>
          </div>
        </dl>
      </li>
    {/each}
  </ul>
{/if}
