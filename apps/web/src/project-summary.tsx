import { cx } from '@ai-usage/design-system/css';
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
  strongCell,
  table,
  tableWrap,
} from '@ai-usage/design-system/report';
import { For, Show } from 'solid-js';
import type { ProjectGroup } from './dashboard-analytics';
import { fmtCompact, fmtMoney, fmtNum, UNKNOWN_PRICE_HINT } from './shared';

export const ProjectSummary = (props: { groups: ProjectGroup[]; onProjectFilter: (value: string) => void }) => (
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
              $API
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
                  title={project.key === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
                >
                  <button class={groupKeyButton} onClick={() => props.onProjectFilter(project.key)} type="button">
                    {project.key}
                  </button>
                </td>
                <td class={numCell}>{fmtNum(project.sessions)}</td>
                <td class={numCell} title={fmtNum(project.fresh)}>
                  {fmtCompact(project.fresh)}
                </td>
                <td class={numCell} title={fmtNum(project.cache)}>
                  {fmtCompact(project.cache)}
                </td>
                <td class={numCell}>
                  <Show fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>} when={project.priced}>
                    {fmtMoney(project.cost)}
                  </Show>
                </td>
                <td class={numCell}>
                  +{fmtNum(project.linesAdded)}/-{fmtNum(project.linesDeleted)}
                </td>
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
              <button
                class={groupKeyButton}
                onClick={() => props.onProjectFilter(project.key)}
                title={
                  project.key === '(unknown)'
                    ? 'Filter sessions without a detected project directory'
                    : `Filter sessions by ${project.key}`
                }
                type="button"
              >
                {project.key}
              </button>
              <div class={projectSummaryHeadline}>
                <span class={projectSummaryCost}>
                  <Show fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>} when={project.priced}>
                    {fmtMoney(project.cost)}
                  </Show>
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
                <dd>
                  +{fmtNum(project.linesAdded)}/-{fmtNum(project.linesDeleted)}
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
        )}
      </For>
    </ul>
  </Show>
);
