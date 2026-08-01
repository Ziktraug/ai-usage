import { css, cx } from '@ai-usage/design-system/css';
import {
  desktopTableSurface,
  empty,
  groupKeyButton,
  mobileSummarySurface,
  numCell,
  projectSummaryCard,
  projectSummaryCost,
  projectSummaryHeader,
  projectSummaryHeadline,
  projectSummaryList,
  projectSummaryMetric,
  projectSummaryMetrics,
  projectSummarySessions,
  projectTable,
  right,
  statusPill,
  statusPillInfo,
  strongCell,
  table,
  tableWrap,
} from '@ai-usage/design-system/report';
import { For, type JSX, Show } from 'solid-js';
import type { ProjectGroup } from './dashboard-analytics';
import { projectDataQualityLabel } from './project-presentation';
import { apiValuePresentation, fmtCompact, fmtNum } from './shared';

const projectIdentity = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '6px',
  minW: 0,
});

const projectQualityAction = css({
  cursor: 'pointer',
  fontFamily: 'sans',
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

interface ProjectIdentityProps {
  filterTitle?: string;
  onManageProjectGroups: () => void;
  onProjectFilter: (value: string) => void;
  project: ProjectGroup;
}

const ProjectIdentity = (props: ProjectIdentityProps) => {
  const qualityLabel = () => projectDataQualityLabel(props.project.label);
  return (
    <div class={projectIdentity}>
      <button
        class={groupKeyButton}
        onClick={() => props.onProjectFilter(props.project.key)}
        title={props.filterTitle}
        type="button"
      >
        {props.project.label}
      </button>
      <Show when={qualityLabel()}>
        {(label) => (
          <button
            class={cx(statusPill, statusPillInfo, projectQualityAction)}
            data-project-quality-label={label()}
            onClick={props.onManageProjectGroups}
            title="Open Manage project groups"
            type="button"
          >
            {label()}
          </button>
        )}
      </Show>
    </div>
  );
};

const formatProjectLineMeasurement = (project: ProjectGroup): string => {
  const { measuredSessions, totalSessions } = project.lineMeasurement;
  if (measuredSessions === 0) {
    return '—';
  }
  const measuredLines = `+${fmtNum(project.linesAdded)}/-${fmtNum(project.linesDeleted)}`;
  if (measuredSessions < totalSessions) {
    return `${measuredLines} · ${fmtNum(measuredSessions)}/${fmtNum(totalSessions)} measured`;
  }
  return measuredLines;
};

const projectApiValuePresentation = (project: ProjectGroup) =>
  apiValuePresentation({
    costApprox: project.cost,
    costKnown: project.priced === project.sessions,
  });

interface ProjectSummaryProps {
  actions?: JSX.Element;
  groups: ProjectGroup[];
  onManageProjectGroups: () => void;
  onProjectFilter: (value: string) => void;
}

export const ProjectSummary = (props: ProjectSummaryProps) => (
  <>
    {props.actions}
    <Show fallback={<div class={empty}>No projects</div>} when={props.groups.length}>
      <div class={cx(tableWrap, desktopTableSurface)}>
        <table class={cx(table, projectTable)}>
          <thead>
            <tr>
              <th>Project</th>
              <th class={right} style={{ width: '88px' }}>
                Sessions
              </th>
              <th class={right} style={{ width: '110px' }}>
                Fresh
              </th>
              <th class={right} style={{ width: '110px' }}>
                Cache
              </th>
              <th class={right} style={{ width: '96px' }}>
                API value
              </th>
              <th class={right} style={{ width: '110px' }}>
                Lines
              </th>
              <th class={right} style={{ width: '96px' }}>
                Turns
              </th>
              <th class={right} style={{ width: '96px' }}>
                Tools
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.groups}>
              {(project) => (
                <tr>
                  <td
                    class={strongCell}
                    title={project.label === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
                  >
                    <ProjectIdentity
                      onManageProjectGroups={props.onManageProjectGroups}
                      onProjectFilter={props.onProjectFilter}
                      project={project}
                    />
                  </td>
                  <td class={numCell}>{fmtNum(project.sessions)}</td>
                  <td class={numCell} title={fmtNum(project.fresh)}>
                    {fmtCompact(project.fresh)}
                  </td>
                  <td class={numCell} title={fmtNum(project.cache)}>
                    {fmtCompact(project.cache)}
                  </td>
                  <td class={numCell}>
                    <span title={projectApiValuePresentation(project).title}>
                      {projectApiValuePresentation(project).label}
                    </span>
                  </td>
                  <td class={numCell}>{formatProjectLineMeasurement(project)}</td>
                  <td class={numCell}>{fmtNum(project.turns)}</td>
                  <td class={numCell}>{fmtNum(project.tools)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <ul aria-label="Project summaries" class={cx(mobileSummarySurface, projectSummaryList)}>
        <For each={props.groups}>
          {(project) => (
            <li class={projectSummaryCard}>
              <header class={projectSummaryHeader}>
                <ProjectIdentity
                  filterTitle={
                    project.label === '(unknown)'
                      ? 'Filter sessions without a detected project directory'
                      : `Filter sessions by ${project.label}`
                  }
                  onManageProjectGroups={props.onManageProjectGroups}
                  onProjectFilter={props.onProjectFilter}
                  project={project}
                />
                <div class={projectSummaryHeadline}>
                  <span class={projectSummaryCost}>
                    <span title={projectApiValuePresentation(project).title}>
                      {projectApiValuePresentation(project).label}
                    </span>
                  </span>
                  <span class={projectSummarySessions}>{fmtNum(project.sessions)} sessions</span>
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
                  <dd>{formatProjectLineMeasurement(project)}</dd>
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
          )}
        </For>
      </ul>
    </Show>
  </>
);
