<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { muted, table, tableWrap } from '@ai-usage/design-system/report';
  import { statusPill, statusPillWarn, strongCell } from '@ai-usage/design-system/svelte';
  import type { KnownProjectScope } from '../../../../skills-page-model';
  import { count } from '../../../../skills-page-model';
  import {
    formatObservedAt,
    formatObservedDate,
    NAME_SCOPED_COUNTS_TEXT,
    observationRecency,
    observationRecencyNote,
    observedHarnessSummary,
    type SkillObservationRow,
  } from '../observations/model';
  import SelectionLink from './selection-link.svelte';

  export interface ProjectScopeSkillRow {
    description: string;
    name: string;
    observationRow: SkillObservationRow | undefined;
    placements: readonly string[];
    validationStatus: string;
  }

  let {
    knownProjects,
    observationsState,
    projectPath,
    rows,
  }: {
    knownProjects: readonly KnownProjectScope[];
    /** Keeps loading, unavailable, and a complete empty result distinct. */
    observationsState: 'loading' | 'ready' | 'unavailable';
    projectPath: string;
    rows: readonly ProjectScopeSkillRow[];
  } = $props();

  const projectTableWrap = css({
    minH: 'auto',
    '& > table': { tableLayout: 'auto', minW: 0, fontSize: '12px' },
    '& th, & td': { px: '8px' },
  });
  const skillNameCell = css({
    textTransform: 'none',
    letterSpacing: 'normal',
    color: 'ink',
    fontSize: '13px',
    fontWeight: 600,
  });
  const skillNameLink = css({
    color: 'ink',
    textDecoration: 'none',
    _hover: { color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const descriptionText = css({ color: 'muted', fontSize: '11.5px', fontWeight: 400, maxW: '48ch' });
  const observedCell = css({ fontSize: '12px' });
  const observedAtCell = css({ whiteSpace: 'nowrap' });
  const staleMark = css({ color: 'status.warn', fontSize: '11px', fontWeight: 650 });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-reachable -->
<!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
<section aria-label="Project skills with observed use" class={cx(tableWrap, projectTableWrap)} tabindex="0">
  <p class={muted} data-skill-observations-name-scope>{NAME_SCOPED_COUNTS_TEXT}</p>
  <table class={table} data-project-skills-table>
    <thead>
      <tr>
        <th scope="col">Skill · {count(rows.length, 'owned by this repo', 'owned by this repo')}</th>
        <th scope="col">Placement</th>
        <th scope="col">Observed use</th>
        <th scope="col">Last</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.name)}
        <tr data-project-skill-row={row.name}>
          <th class={cx(strongCell, skillNameCell)} scope="row">
            <SelectionLink
              class={skillNameLink}
              {knownProjects}
              selection={{ projectPath, skillName: row.name, type: 'project-skill' }}
            >
              {row.name}
            </SelectionLink>
            {#if row.validationStatus !== 'valid'}
              <span class={cx(statusPill, statusPillWarn)}>{row.validationStatus}</span>
            {/if}
            <div class={descriptionText}>{row.description}</div>
          </th>
          <td class={observedCell}>{row.placements.join(' · ')}</td>
          <td class={observedCell}>
            {#if observationsState === 'unavailable'}
              <span class={muted} data-project-observations-state="unavailable">unavailable</span>
            {:else if observationsState === 'loading'}
              <span class={muted} data-project-observations-state="loading">…</span>
            {:else if row.observationRow !== undefined && observedHarnessSummary(row.observationRow).length > 0}
              {observedHarnessSummary(row.observationRow)}
            {:else}
              <span class={muted}>—</span>
            {/if}
          </td>
          <td
            class={observedAtCell}
            data-observation-recency={row.observationRow?.lastObservedAt
              ? observationRecency(row.observationRow.lastObservedAt)
              : undefined}
          >
            {#if observationsState === 'unavailable'}
              <span class={muted} data-project-observations-state="unavailable">unavailable</span>
            {:else if observationsState === 'loading'}
              <span class={muted} data-project-observations-state="loading">…</span>
            {:else if row.observationRow?.lastObservedAt}
              <time
                datetime={row.observationRow.lastObservedAt}
                title={formatObservedAt(row.observationRow.lastObservedAt)}
                >{formatObservedDate(row.observationRow.lastObservedAt)}</time
              >
              {#if observationRecencyNote(row.observationRow.lastObservedAt)}
                <span class={staleMark}> · {observationRecencyNote(row.observationRow.lastObservedAt)}</span>
              {/if}
            {:else}
              <span class={muted}>—</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
