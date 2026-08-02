import { empty, meta, metricGrid, numCell, right, strongCell, table, tableWrap } from '@ai-usage/design-system/report';
import { createMemo, For, Show } from 'solid-js';
import { MetricTile } from './dashboard-metrics';
import type { CursorCommitAttributionFacet } from './report-data';
import { fmtDate, fmtNum, fmtPct } from './shared';

const CURSOR_COMPONENT_COUNTER_HINT =
  "Component counters are vendor fields; zero may mean no attributed lines. AI % is Cursor's v2 score.";

export interface CursorAiPercentageSummary {
  measuredCommits: number;
  percentage: number | null;
  totalCommits: number;
}

const formatCursorAiPercentage = (percentage: number | null): string =>
  percentage === null ? '—' : fmtPct(percentage);

export const summarizeCursorAiPercentage = (
  rows: readonly CursorCommitAttributionFacet[],
): CursorAiPercentageSummary => {
  const commits = new Map<string, { lineTotals: Set<number>; percentages: Set<number> }>();
  for (const row of rows) {
    const commit = commits.get(row.commitHash) ?? {
      lineTotals: new Set<number>(),
      percentages: new Set<number>(),
    };
    if (row.v2AiPercentage !== null) {
      commit.percentages.add(row.v2AiPercentage);
    }
    commit.lineTotals.add(row.linesAdded + row.linesDeleted);
    commits.set(row.commitHash, commit);
  }

  let measuredCommits = 0;
  let totalWeight = 0;
  let weightedPercentage = 0;
  for (const commit of commits.values()) {
    if (commit.percentages.size !== 1 || commit.lineTotals.size !== 1) {
      continue;
    }
    const percentage = commit.percentages.values().next().value;
    const weight = commit.lineTotals.values().next().value;
    if (percentage === undefined || weight === undefined || weight <= 0) {
      continue;
    }
    measuredCommits++;
    totalWeight += weight;
    weightedPercentage += percentage * weight;
  }

  return {
    measuredCommits,
    percentage: totalWeight > 0 ? weightedPercentage / totalWeight : null,
    totalCommits: commits.size,
  };
};

export const CursorAttributionPanel = (props: { rows: CursorCommitAttributionFacet[] }) => {
  const aiPercentage = createMemo(() => summarizeCursorAiPercentage(props.rows));
  const humanLines = createMemo(() =>
    props.rows.reduce((total, row) => total + row.humanLinesAdded + row.humanLinesDeleted, 0),
  );

  return (
    <Show
      fallback={<div class={empty}>No Cursor commit attribution data in this payload</div>}
      when={props.rows.length}
    >
      <div class={metricGrid}>
        <MetricTile
          hint="Unique commit hashes scored by Cursor"
          label="Scored commits"
          value={fmtNum(aiPercentage().totalCommits)}
        />
        <MetricTile
          hint="Cursor stores attribution per branch, so commits can repeat"
          label="Branch rows"
          value={fmtNum(props.rows.length)}
        />
        <MetricTile
          hint={CURSOR_COMPONENT_COUNTER_HINT}
          label={`AI line share · ${fmtNum(aiPercentage().measuredCommits)}/${fmtNum(aiPercentage().totalCommits)} measured`}
          value={formatCursorAiPercentage(aiPercentage().percentage)}
        />
        <MetricTile hint="Lines Cursor classified as human-authored" label="Human lines" value={fmtNum(humanLines())} />
      </div>

      <div class={tableWrap}>
        <table class={table} style={{ 'min-width': '1120px' }}>
          <thead>
            <tr>
              <th>Commit</th>
              <th style={{ width: '150px' }}>Branch</th>
              <th class={right} style={{ width: '110px' }} title={CURSOR_COMPONENT_COUNTER_HINT}>
                AI %
              </th>
              <th class={right} style={{ width: '120px' }}>
                Composer
              </th>
              <th class={right} style={{ width: '100px' }}>
                Tab
              </th>
              <th class={right} style={{ width: '110px' }}>
                Human
              </th>
              <th class={right} style={{ width: '130px' }}>
                Total +/-
              </th>
              <th style={{ width: '150px' }}>Scored</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row) => (
                <tr>
                  <td class={strongCell} title={row.commitHash}>
                    <div>{row.commitMessage || row.commitHash.slice(0, 10)}</div>
                    <div class={meta}>{row.commitHash.slice(0, 10)}</div>
                  </td>
                  <td>{row.branchName}</td>
                  <td class={numCell}>{row.v2AiPercentage == null ? '—' : fmtPct(row.v2AiPercentage)}</td>
                  <td class={numCell}>
                    +{fmtNum(row.composerLinesAdded)}/-{fmtNum(row.composerLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.tabLinesAdded)}/-{fmtNum(row.tabLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.humanLinesAdded)}/-{fmtNum(row.humanLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.linesAdded)}/-{fmtNum(row.linesDeleted)}
                  </td>
                  <td>{fmtDate(row.scoredAt)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
};
