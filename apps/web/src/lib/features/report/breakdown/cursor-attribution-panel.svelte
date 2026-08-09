<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { MetricTile } from '@ai-usage/design-system/svelte/passive';
  import type { CursorCommitAttributionFacet } from '../../../../report-data';
  import { fmtDate, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import { summarizeCursorAiPercentage } from './cursor';

  const empty = css({ p: '24px', color: 'muted', textAlign: 'center' });
  const meta = css({ color: 'muted', fontSize: '11px' });
  const metricGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
    gap: '10px',
  });
  const tableWrap = css({ overflowX: 'auto' });
  const table = css({
    w: 'full',
    borderCollapse: 'collapse',
    fontSize: '12px',
    '& th, & td': { p: '7px', borderBottom: '1px solid token(colors.line)', textAlign: 'left' },
  });
  const right = css({ textAlign: 'right' });
  const numCell = css({ textAlign: 'right', textStyle: 'numeric' });
  const strongCell = css({ fontWeight: 700 });

  let { rows }: { rows: readonly CursorCommitAttributionFacet[] } = $props();
  const aiPercentage = $derived(summarizeCursorAiPercentage(rows));
  const humanLines = $derived(rows.reduce((total, row) => total + row.humanLinesAdded + row.humanLinesDeleted, 0));
  const componentHint =
    "Component counters are vendor fields; zero may mean no attributed lines. AI % is Cursor's v2 score.";
</script>

{#if rows.length === 0}
  <div class={empty}>No Cursor commit attribution data in this payload</div>
{:else}
  <div class={metricGrid}>
    <MetricTile
      hint="Unique commit hashes scored by Cursor"
      label="Scored commits"
      value={fmtNum(aiPercentage.totalCommits)}
    />
    <MetricTile
      hint="Cursor stores attribution per branch, so commits can repeat"
      label="Branch rows"
      value={fmtNum(rows.length)}
    />
    <MetricTile
      hint={componentHint}
      label={`AI line share · ${fmtNum(aiPercentage.measuredCommits)}/${fmtNum(aiPercentage.totalCommits)} measured`}
      value={aiPercentage.percentage === null ? '—' : fmtPct(aiPercentage.percentage)}
    />
    <MetricTile hint="Lines Cursor classified as human-authored" label="Human lines" value={fmtNum(humanLines)} />
  </div>
  <div class={tableWrap}>
    <table class={table} style:min-width="1120px">
      <thead>
        <tr>
          <th>Commit</th>
          <th>Branch</th>
          <th class={right} title={componentHint}>AI %</th>
          <th class={right}>Composer</th>
          <th class={right}>Tab</th>
          <th class={right}>Human</th>
          <th class={right}>Total +/-</th>
          <th>Scored</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (`${row.commitHash}:${row.branchName}`)}
          <tr>
            <td class={strongCell} title={row.commitHash}>
              <div>{row.commitMessage || row.commitHash.slice(0, 10)}</div>
              <div class={meta}>{row.commitHash.slice(0, 10)}</div>
            </td>
            <td>{row.branchName}</td>
            <td class={numCell}>{row.v2AiPercentage === null ? '—' : fmtPct(row.v2AiPercentage)}</td>
            <td class={numCell}>+{fmtNum(row.composerLinesAdded)}/-{fmtNum(row.composerLinesDeleted)}</td>
            <td class={numCell}>+{fmtNum(row.tabLinesAdded)}/-{fmtNum(row.tabLinesDeleted)}</td>
            <td class={numCell}>+{fmtNum(row.humanLinesAdded)}/-{fmtNum(row.humanLinesDeleted)}</td>
            <td class={numCell}>+{fmtNum(row.linesAdded)}/-{fmtNum(row.linesDeleted)}</td>
            <td>{fmtDate(row.scoredAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
