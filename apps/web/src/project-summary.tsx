import { cx } from '@ai-usage/design-system/css';
import {
  empty,
  groupKeyButton,
  numCell,
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
    <div class={tableWrap}>
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
  </Show>
);
