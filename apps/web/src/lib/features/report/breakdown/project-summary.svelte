<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import type { UsageReportProjectGroup } from '@ai-usage/report-core/report-data';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import {
    projectDataQualityLabel,
    projectIdentityPresentation,
    projectLinesPresentation,
  } from '../../../../project-presentation';
  import { fmtCompact, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import {
    modelEmpty,
    modelNameButton,
    modelNumericCell,
    modelTable,
    modelTableCell,
    modelTableHeaderCell,
    modelTableViewport,
    modelTextCell,
  } from './styles';

  const mobileSummarySurface = css({ display: { base: 'grid', md: 'none' } });
  const projectTable = css({ minW: '840px' });
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
  const projectSummaryMetrics = css({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '8px',
  });
  const projectSummaryMetric = css({ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px' });
  const identityRow = css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minW: 0 });
  const projectMachine = css({
    display: 'block',
    mt: '2px',
    color: 'muted',
    fontSize: '11px',
    overflowWrap: 'anywhere',
  });
  const qualityAction = css({
    cursor: 'pointer',
    fontFamily: 'sans',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });

  let {
    catalogue,
    emptyMessage,
    groups,
    onManageProjectGroups,
    onProjectFilter,
    showMachines = true,
  }: {
    catalogue?: readonly UsageReportProjectGroup[];
    emptyMessage: string;
    groups: readonly ProjectGroup[];
    onManageProjectGroups: () => void;
    onProjectFilter: (value: string) => void;
    /** False when the whole store is known to hold one machine: the qualifier would repeat itself. */
    showMachines?: boolean;
  } = $props();

  const valueFor = (project: ProjectGroup) =>
    apiValuePresentation({ costApprox: project.cost, costKnown: project.priced === project.sessions });
</script>

<div class={modelTableViewport}>
  <table class={cx(modelTable, projectTable)}>
    <thead>
      <tr>
        <th class={cx(modelTableHeaderCell, modelTextCell)} scope="col">Project</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Sessions</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Fresh</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Cache</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">API value</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Lines changed</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Turns</th>
        <th class={cx(modelTableHeaderCell, modelNumericCell)} scope="col">Tools</th>
      </tr>
    </thead>
    <tbody>
      {#if groups.length === 0}
        <tr>
          <td class={modelEmpty} colspan="8"><span role="status">{emptyMessage}</span></td>
        </tr>
      {:else}
        {#each groups as project (project.key)}
          {@const quality = projectDataQualityLabel(project.label)}
          {@const value = valueFor(project)}
          {@const identity = projectIdentityPresentation(project, catalogue)}
          {@const lines = projectLinesPresentation(project)}
          <tr>
            <th
              class={cx(modelTableCell, modelTextCell)}
              scope="row"
              title={identity.name === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
            >
              <div class={identityRow}>
                <button
                  aria-label={`Filter sessions by project ${identity.name}`}
                  class={modelNameButton}
                  data-project-name
                  onclick={() => onProjectFilter(project.key)}
                  type="button"
                >
                  {identity.name}
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
              {#if showMachines && identity.machines.length > 0}
                <span class={projectMachine} data-project-machine>{identity.machines.join(' · ')}</span>
              {/if}
            </th>
            <td class={cx(modelTableCell, modelNumericCell)}>{fmtNum(project.sessions)}</td>
            <td class={cx(modelTableCell, modelNumericCell)} title={fmtNum(project.fresh)}>
              {fmtCompact(project.fresh)}
            </td>
            <td class={cx(modelTableCell, modelNumericCell)} title={fmtNum(project.cache)}>
              {fmtCompact(project.cache)}
            </td>
            <td class={cx(modelTableCell, modelNumericCell)}><span title={value.title}>{value.label}</span></td>
            <td class={cx(modelTableCell, modelNumericCell)} data-project-lines={lines.status}>
              <span title={lines.title}>{lines.label}</span>
              {#if lines.coverage}
                <span class={projectMachine} data-project-lines-coverage>{lines.coverage}</span>
              {/if}
            </td>
            <td class={cx(modelTableCell, modelNumericCell)}>{fmtNum(project.turns)}</td>
            <td class={cx(modelTableCell, modelNumericCell)}>{fmtNum(project.tools)}</td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<ul aria-label="Project summaries" class={cx(mobileSummarySurface, projectSummaryList)}>
  {#if groups.length === 0}
    <li class={modelEmpty}><span role="status">{emptyMessage}</span></li>
  {:else}
    {#each groups as project (project.key)}
      {@const quality = projectDataQualityLabel(project.label)}
      {@const value = valueFor(project)}
      {@const identity = projectIdentityPresentation(project, catalogue)}
      {@const lines = projectLinesPresentation(project)}
      <li class={projectSummaryCard}>
        <header class={projectSummaryHeader}>
          <div>
            <div class={identityRow}>
              <button
                aria-label={`Filter sessions by project ${identity.name}`}
                class={modelNameButton}
                data-project-name
                onclick={() => onProjectFilter(project.key)}
                type="button"
              >
                {identity.name}
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
            {#if showMachines && identity.machines.length > 0}
              <span class={projectMachine} data-project-machine>{identity.machines.join(' · ')}</span>
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
            <dt>Lines changed</dt>
            <dd data-project-lines={lines.status}>
              <span title={lines.title}>{lines.label}</span>
              {#if lines.coverage}
                <span class={projectMachine} data-project-lines-coverage>{lines.coverage}</span>
              {/if}
            </dd>
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
  {/if}
</ul>
