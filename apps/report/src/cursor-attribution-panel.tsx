import { empty, meta, metricGrid, numCell, right, strongCell, table, tableWrap } from '@ai-usage/design-system';
import { createMemo, For, Show } from 'solid-js';
import { MetricTile } from './dashboard-metrics';
import type { CursorCommitAttributionFacet } from './report-data';
import { fmtDate, fmtNum, fmtPct } from './shared';

const cursorAiLineTotal = (row: CursorCommitAttributionFacet) =>
  row.composerLinesAdded + row.composerLinesDeleted + row.tabLinesAdded + row.tabLinesDeleted;

const uniqueCursorCommits = (rows: CursorCommitAttributionFacet[]) => new Set(rows.map((row) => row.commitHash)).size;

export const CursorAttributionPanel = (props: { rows: CursorCommitAttributionFacet[] }) => {
  const totals = createMemo(() =>
    props.rows.reduce(
      (acc, row) => ({
        aiLines: acc.aiLines + cursorAiLineTotal(row),
        blankLines: acc.blankLines + row.blankLinesAdded + row.blankLinesDeleted,
        humanLines: acc.humanLines + row.humanLinesAdded + row.humanLinesDeleted,
        totalLines: acc.totalLines + row.linesAdded + row.linesDeleted,
      }),
      { aiLines: 0, blankLines: 0, humanLines: 0, totalLines: 0 },
    ),
  );
  const aiPct = () => (totals().totalLines ? (totals().aiLines / totals().totalLines) * 100 : 0);

  return (
    <Show
      when={props.rows.length}
      fallback={<div class={empty}>No Cursor commit attribution data in this payload</div>}
    >
      <div class={metricGrid}>
        <MetricTile
          label="Scored commits"
          value={fmtNum(uniqueCursorCommits(props.rows))}
          hint="Unique commit hashes scored by Cursor"
        />
        <MetricTile
          label="Branch rows"
          value={fmtNum(props.rows.length)}
          hint="Cursor stores attribution per branch, so commits can repeat"
        />
        <MetricTile
          label="AI line share"
          value={fmtPct(aiPct())}
          hint="Composer + Tab lines over scored added/deleted lines"
        />
        <MetricTile
          label="Human lines"
          value={fmtNum(totals().humanLines)}
          hint="Lines Cursor classified as human-authored"
        />
      </div>

      <div class={tableWrap}>
        <table class={table} style={{ 'min-width': '1120px' }}>
          <thead>
            <tr>
              <th>Commit</th>
              <th style={{ width: '150px' }}>Branch</th>
              <th style={{ width: '110px' }} class={right}>
                AI %
              </th>
              <th style={{ width: '120px' }} class={right}>
                Composer
              </th>
              <th style={{ width: '100px' }} class={right}>
                Tab
              </th>
              <th style={{ width: '110px' }} class={right}>
                Human
              </th>
              <th style={{ width: '130px' }} class={right}>
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
