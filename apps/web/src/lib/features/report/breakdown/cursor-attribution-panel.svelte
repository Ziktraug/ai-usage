<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { MetricTile } from '@ai-usage/design-system/svelte';
  import type { SessionQueryRange } from '@ai-usage/report-core/session-query';
  import type { CursorCommitAttributionFacet } from '../../../../report-data';
  import { fmtDate, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import { type CursorCommitGroup, cursorRowsInRange, groupCursorCommits, summarizeCursorAiPercentage } from './cursor';

  const empty = css({ p: '24px', color: 'muted', textAlign: 'center' });
  const meta = css({ color: 'muted', fontSize: '11px' });
  const tableNote = css({ color: 'muted', fontSize: '11px', mb: '8px' });
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
  const CURSOR_ATTRIBUTION_TABLE_MIN_WIDTH_PX = 1120;
  const COMMIT_HASH_PREVIEW_LENGTH = 10;
  const TABLE_DESCRIPTION_ID = 'cursor-attribution-table-description';

  let { range, rows }: { range: SessionQueryRange; rows: readonly CursorCommitAttributionFacet[] } = $props();
  const visibleRows = $derived(cursorRowsInRange(rows, range));
  const groups = $derived(groupCursorCommits(visibleRows));
  const aiPercentage = $derived(summarizeCursorAiPercentage(visibleRows));
  const humanLines = $derived(
    visibleRows.reduce((total, row) => total + row.humanLinesAdded + row.humanLinesDeleted, 0),
  );
  const outsideCommits = $derived(summarizeCursorAiPercentage(rows).totalCommits);
  const periodEmptyMessage = $derived(
    `No Cursor commits in this period · ${fmtNum(outsideCommits)} scored ${outsideCommits === 1 ? 'commit' : 'commits'} outside it`,
  );
  const componentHint =
    "Component counters are vendor fields; zero may mean no attributed lines. AI % is Cursor's v2 score.";
  const branchRowsHint =
    'Cursor stores one row per branch a commit was seen on. The table folds those into one row per commit, and keeps a commit on separate rows only when its stored numbers disagree.';
  const tableDescription =
    'Committed is the git commit date, and it is the date the report period filters on. A commit falls back to its scoring time, marked · scored, only when no stored row carries a commit date. Each row lists a commit with the branches Cursor saw it on, and its scoring times under the date; a commit whose stored numbers disagree between branches stays on separate rows rather than being averaged.';
  const scoringTimeLabel = (group: CursorCommitGroup): string => {
    const scored =
      group.scoredAt.length === 0
        ? 'No scoring time recorded'
        : `Scored ${group.scoredAt.map((value) => fmtDate(value)).join(' · ')}`;
    return group.dateSource === 'scored' ? `No commit date recorded — ${scored}` : scored;
  };
</script>

{#if rows.length === 0}
  <div class={empty} data-cursor-empty-state="payload">No Cursor commit attribution data in this payload</div>
{:else if visibleRows.length === 0}
  <div class={empty} data-cursor-empty-state="period">{periodEmptyMessage}</div>
{:else}
  <div class={metricGrid}>
    <MetricTile
      hint="Unique commit hashes Cursor scored, in this period"
      label="Scored commits"
      value={fmtNum(aiPercentage.totalCommits)}
    />
    <MetricTile hint={branchRowsHint} label="Branch rows" value={fmtNum(visibleRows.length)} />
    <MetricTile
      hint={componentHint}
      label={`AI line share · ${fmtNum(aiPercentage.measuredCommits)}/${fmtNum(aiPercentage.totalCommits)} measured`}
      value={aiPercentage.percentage === null ? '—' : fmtPct(aiPercentage.percentage)}
    />
    <MetricTile hint="Lines Cursor classified as human-authored" label="Human lines" value={fmtNum(humanLines)} />
  </div>
  <div class={tableWrap}>
    <p class={tableNote} id={TABLE_DESCRIPTION_ID}>{tableDescription}</p>
    <table
      aria-describedby={TABLE_DESCRIPTION_ID}
      class={table}
      style:min-width={`${CURSOR_ATTRIBUTION_TABLE_MIN_WIDTH_PX}px`}
    >
      <thead>
        <tr>
          <th scope="col">Commit</th>
          <th scope="col">Branches</th>
          <th class={right} scope="col" title={componentHint}>AI %</th>
          <th class={right} scope="col">Composer</th>
          <th class={right} scope="col">Tab</th>
          <th class={right} scope="col">Human</th>
          <th class={right} scope="col">Total +/-</th>
          <th scope="col">Committed</th>
        </tr>
      </thead>
      <tbody>
        {#each groups as group (group.key)}
          <tr data-cursor-commit={group.commitHash}>
            <td class={strongCell} title={group.commitHash}>
              <div>{group.commitMessage || group.commitHash.slice(0, COMMIT_HASH_PREVIEW_LENGTH)}</div>
              <div class={meta}>{group.commitHash.slice(0, COMMIT_HASH_PREVIEW_LENGTH)}</div>
            </td>
            <td data-cursor-branch-count={group.branches.length}>{group.branches.join(', ')}</td>
            <td class={numCell}>
              {group.metrics.v2AiPercentage === null ? '—' : fmtPct(group.metrics.v2AiPercentage)}
            </td>
            <td class={numCell}>
              +{fmtNum(group.metrics.composerLinesAdded)}/-{fmtNum(group.metrics.composerLinesDeleted)}
            </td>
            <td class={numCell}>+{fmtNum(group.metrics.tabLinesAdded)}/-{fmtNum(group.metrics.tabLinesDeleted)}</td>
            <td class={numCell}>+{fmtNum(group.metrics.humanLinesAdded)}/-{fmtNum(group.metrics.humanLinesDeleted)}</td>
            <td class={numCell}>+{fmtNum(group.metrics.linesAdded)}/-{fmtNum(group.metrics.linesDeleted)}</td>
            <td data-cursor-date-source={group.dateSource}>
              <div>
                <span>{fmtDate(group.date)}</span>
                {#if group.dateSource === 'scored'}
                  <span class={meta}>· scored</span>
                {/if}
              </div>
              <div class={meta} data-cursor-scored-at>{scoringTimeLabel(group)}</div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
