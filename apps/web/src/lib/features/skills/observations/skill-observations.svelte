<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    meta,
    muted,
    panel,
    panelSub,
    panelTitle,
    strongCell,
    table,
    tableWrap,
  } from '@ai-usage/design-system/report';
  import type { SkillObservations } from '@ai-usage/web-contract/skills';
  import {
    buildSkillObservationsView,
    deletionCandidateText,
    formatObservedAt,
    NOT_OBSERVABLE_TEXT,
    SKILL_OBSERVATION_TIER_DESCRIPTIONS,
    skillObservationRow,
    verdictText,
  } from './model';

  let {
    errorMessage,
    observations,
    skillName,
    variant = 'overview',
  }: {
    errorMessage?: string | undefined;
    observations?: SkillObservations | undefined;
    skillName?: string | undefined;
    variant?: 'overview' | 'skill';
  } = $props();

  const view = $derived(observations === undefined ? undefined : buildSkillObservationsView(observations));
  const row = $derived(
    view === undefined || skillName === undefined ? undefined : skillObservationRow(view, skillName),
  );

  const stack = css({ display: 'grid', gap: '12px' });
  const section = css({ display: 'grid', gap: '8px' });
  const sectionHeader = css({ display: 'grid', gap: '2px' });
  const coverageList = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 14px',
    m: 0,
    p: 0,
    listStyle: 'none',
    color: 'muted',
    fontSize: '12px',
  });
  const definitionList = css({ display: 'grid', gap: '6px', m: 0 });
  const definitionRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'baseline',
    p: '6px 0',
    borderTop: '1px solid token(colors.line)',
    fontSize: '13px',
  });
  // `declared 3` is one phrase and must never break across lines into `declare` / `d 3`. The table
  // sits in an `overflow-x: auto` wrapper, so a wide row scrolls rather than shredding its words.
  const observationCell = css({ whiteSpace: 'nowrap' });
  const detailObservationCell = css({ overflowWrap: 'anywhere' });
  // The shared table style renders every `th` as an uppercase column label. A skill name is data,
  // not a label, so the row header opts out rather than shouting the inventory back at the reader.
  const skillRowHeader = css({
    textTransform: 'none',
    letterSpacing: 'normal',
    color: 'ink',
    fontSize: '13px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  });
  const managedTag = css({ color: 'muted', fontSize: '11px', fontWeight: 500, textTransform: 'none' });
  const observedAt = css({ whiteSpace: 'nowrap' });
  const candidateList = css({ display: 'grid', gap: '4px', m: 0, pl: '18px', fontSize: '13px' });
  const pathText = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  // Tighter than the exposure matrix on purpose: six columns of short phrases fit the 1280 band
  // beside the tree, so the "not observable" column stays on screen instead of behind a scroll.
  const observationsTableWrap = css({
    minH: 'auto',
    '& > table': { tableLayout: 'auto', minW: 0, fontSize: '12px' },
    '& th, & td': { px: '8px' },
  });
</script>

{#if errorMessage}
  <p class={muted} data-skill-observations-state="unavailable" role="status">
    Skill observations are unavailable. {errorMessage}
  </p>
{:else if view === undefined}
  <p aria-busy="true" class={muted} data-skill-observations-state="loading">Loading skill observations…</p>
{:else if variant === 'skill'}
  <section aria-label="Observed usage" class={section} data-skill-observations="skill">
    <div class={sectionHeader}>
      <h3 class={panelTitle}>Observed usage</h3>
      <p class={panelSub}>
        Each count carries the tier of evidence behind it and the harness that recorded it. Tiers are never added
        together.
      </p>
    </div>
    <dl class={definitionList}>
      {#each row?.harnesses ?? [] as cell (cell.harnessKey)}
        <div class={definitionRow}>
          <dt class={strongCell}>{cell.label}</dt>
          <dd class={detailObservationCell} data-harness={cell.harnessKey} data-observation-state={cell.state}>
            {cell.summary}
          </dd>
        </div>
      {/each}
    </dl>
    <p class={meta} data-skill-observations-last-observed>
      {#if row?.lastObservedAt}
        Last observed <time datetime={row.lastObservedAt}>{formatObservedAt(row.lastObservedAt)}</time>
      {:else if view.observationsComplete}
        Never observed.
      {:else}
        No observation within the read bound.
      {/if}
    </p>
    <p
      class={meta}
      data-skill-observations-verdict={row?.verdict ?? 'never-observed'}
      data-verdict-provisional={(row?.verdictProvisional ?? !view.observationsComplete) ? 'true' : 'false'}
    >
      {verdictText(row ?? { verdict: 'never-observed', verdictProvisional: !view.observationsComplete })}
    </p>
    {#if row?.deletionCandidate}
      <p
        class={meta}
        data-skill-observations-deletion-candidate
        data-verdict-provisional={row.verdictProvisional ? 'true' : 'false'}
      >
        {deletionCandidateText(row)}
      </p>
    {/if}
    {#if (row?.resolvedPaths.length ?? 0) > 0}
      {#each row?.resolvedPaths ?? [] as resolvedPath (resolvedPath)}
        <p class={pathText}>{resolvedPath}</p>
      {/each}
    {:else if row?.lastObservedAt}
      <p class={meta}>No harness disclosed a directory for this skill.</p>
    {/if}
  </section>
{:else}
  <section aria-label="Skill observations" class={cx(panel, stack)} data-skill-observations="overview">
    <div class={sectionHeader}>
      <h2 class={panelTitle}>Observed skill usage</h2>
      <p class={panelSub}>
        Every count below carries its tier and its harness. A declared invocation and an inferred read are different
        evidence and are never summed.
      </p>
    </div>

    <ul aria-label="Harness observability" class={coverageList}>
      {#each view.harnesses as harness (harness.harnessKey)}
        <li data-harness-observability={harness.observability}>
          {harness.label}
          — {harness.observability === 'observable' ? 'can report skill usage' : NOT_OBSERVABLE_TEXT}
        </li>
      {/each}
    </ul>

    <ul aria-label="Observation tiers" class={coverageList}>
      {#each Object.entries(SKILL_OBSERVATION_TIER_DESCRIPTIONS) as [ tier, description ] (tier)}
        <li>{tier} — {description}</li>
      {/each}
    </ul>

    {#if view.lowerBound}
      <p class={meta} data-skill-observations-lower-bound role="status">
        The observation read reached its bound, so every count below is a lower bound.
      </p>
    {/if}
    {#if view.skipped > 0}
      <p class={meta} data-skill-observations-skipped role="status">
        {view.skipped}
        stored observations could not be read and are not counted.
      </p>
    {/if}

    <!-- The wrapper scrolls when the harness columns exceed the panel, so it is a named, focusable
         region: a keyboard user must be able to reach the columns a pointer user can drag to. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-reachable -->
    <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
    <section aria-label="Observed skill usage by harness" class={cx(tableWrap, observationsTableWrap)} tabindex="0">
      <table class={table}>
        <thead>
          <tr>
            <th scope="col">Skill</th>
            {#each view.harnesses as harness (harness.harnessKey)}
              <th scope="col">{harness.label}</th>
            {/each}
            <th scope="col">Last observed</th>
          </tr>
        </thead>
        <tbody>
          {#if view.rows.length === 0}
            <tr>
              <td class={muted} colspan={view.harnesses.length + 2}>No skills to report.</td>
            </tr>
          {:else}
            {#each view.rows as observationRow (observationRow.skillName)}
              <tr data-observation-verdict={observationRow.verdict}>
                <th class={cx(strongCell, skillRowHeader)} scope="row">
                  {observationRow.skillName}
                  <span class={managedTag}>{observationRow.managed ? ' managed' : ' unmanaged'}</span>
                </th>
                {#each observationRow.harnesses as cell (cell.harnessKey)}
                  <td class={observationCell} data-harness={cell.harnessKey} data-observation-state={cell.state}>
                    {cell.summary}
                  </td>
                {/each}
                <td class={cx(observationCell, observedAt)}>
                  {#if observationRow.lastObservedAt}
                    <time datetime={observationRow.lastObservedAt}
                      >{formatObservedAt(observationRow.lastObservedAt)}</time
                    >
                  {:else}
                    never
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </section>

    <section
      aria-label="Projected everywhere but never invoked"
      class={section}
      data-provisional={view.observationsComplete ? 'false' : 'true'}
      data-skill-observations-group="deletion"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Projected everywhere but never invoked</h3>
        <p class={panelSub}>
          Managed skills installed in every enabled runtime that no harness recorded being used. Deletion candidates.
          Being offered to a model does not count as use, and Cursor cannot report, so its projections are not evidence
          either way.
        </p>
        {#if !view.observationsComplete}
          <p class={panelSub} data-skill-observations-provisional-note role="status">
            Provisional: this read was bounded or could not read every stored row, so absence here is not proof.
          </p>
        {/if}
      </div>
      {#if view.deletionCandidates.length === 0}
        <p class={meta}>
          {view.observationsComplete
            ? 'Every managed skill installed everywhere has been invoked at least once.'
            : 'Nothing qualifies within the read bound.'}
        </p>
      {:else}
        <ul class={candidateList}>
          {#each view.deletionCandidates as candidate (candidate.skillName)}
            <li>
              {candidate.skillName}
              <span class={meta}>{verdictText(candidate)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-label="Invoked but unmanaged" class={section} data-skill-observations-group="adoption">
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Invoked but unmanaged</h3>
        <p class={panelSub}>
          Skills a harness recorded being <em>used</em> that resolve to no entry in the managed inventory —
          harness-bundled and plugin-provided skills. Adoption candidates for the source repository. A skill that was
          only offered to a model is listed separately: a catalogue lists everything, so being in one is not use.
        </p>
      </div>
      {#if view.adoptionCandidates.length === 0}
        <p class={meta}>Every invoked skill resolves to a managed inventory entry.</p>
      {:else}
        <ul class={candidateList}>
          {#each view.adoptionCandidates as candidate (candidate.skillName)}
            <li>
              {candidate.skillName}
              <span class={meta}>
                {candidate.harnesses
                  .filter((cell) => cell.state === 'observed')
                  .map((cell) => `${cell.label} ${cell.summary}`)
                  .join(' · ')}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-label="Offered but never invoked" class={section} data-skill-observations-group="offered">
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Offered but never invoked</h3>
        <p class={panelSub}>
          Skills a harness put in front of a model with no evidence any of them was used. This is a fact about offering,
          not about use, so it proposes nothing on its own.
        </p>
      </div>
      {#if view.offeredOnly.length === 0}
        <p class={meta}>No skill was offered without also being invoked.</p>
      {:else}
        <ul class={candidateList}>
          {#each view.offeredOnly as candidate (candidate.skillName)}
            <li>
              {candidate.skillName}
              <span class={meta}>
                {candidate.harnesses
                  .filter((cell) => cell.state === 'observed')
                  .map((cell) => `${cell.label} ${cell.summary}`)
                  .join(' · ')}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </section>
{/if}
