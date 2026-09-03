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
  import type { SkillsObservationPresentation, SkillsSelectedPresentation } from '../presentation';
  import {
    ADOPTION_GROUP_COPY,
    deletionCandidateText,
    formatObservationCount,
    formatObservedAt,
    formatObservedDate,
    NAME_SCOPED_COUNTS_TEXT,
    NOT_OBSERVABLE_TEXT,
    noSignalsText,
    OBSERVATION_ROW_OMITTED_TEXT,
    observationRecency,
    observationRecencyNote,
    observationSignalLabel,
    observedHarnessSummary,
    resolvedPathsNote,
    SKILL_OBSERVATION_TIER_DESCRIPTIONS,
    SKILL_OBSERVATION_TIER_ORDER,
    verdictText,
  } from './model';
  import ObservationReadQualification from './observation-read-qualification.svelte';

  let {
    observationPresentation,
    selectedPresentation,
    variant = 'overview',
  }: {
    observationPresentation: SkillsObservationPresentation;
    selectedPresentation?: SkillsSelectedPresentation | undefined;
    variant?: 'overview' | 'skill';
  } = $props();

  const view = $derived(observationPresentation.view);
  const errorMessage = $derived(observationPresentation.errorMessage);
  const row = $derived(selectedPresentation?.observationRow);
  const rowOmitted = $derived(selectedPresentation?.observationRowOmitted ?? false);
  const managedClaimApplies = $derived(selectedPresentation?.managedClaimApplies ?? true);
  const homonym = $derived(selectedPresentation?.homonym);
  const detailVerdict = $derived(selectedPresentation?.verdict);
  const signalLabel = $derived(observationSignalLabel(view?.lowerBound ?? false));

  const cataloguePopulationCount = (count: number): string =>
    view?.invocationEvidenceComplete === false
      ? `${count} provisional`
      : formatObservationCount(count, view?.lowerBound ?? false);

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
    minW: 0,
    textTransform: 'none',
    letterSpacing: 'normal',
    color: 'ink',
    fontSize: '13px',
    fontWeight: 600,
    overflowWrap: 'anywhere',
    whiteSpace: 'normal',
  });
  const managedTag = css({ color: 'muted', fontSize: '11px', fontWeight: 500, textTransform: 'none' });
  const observedAt = css({ whiteSpace: 'nowrap' });
  const candidateList = css({ display: 'grid', gap: '4px', m: 0, pl: '18px', fontSize: '13px' });
  const pathText = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  const visuallyHidden = css({
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
  });
  const emptyCellMark = css({ color: 'muted' });
  const staleMark = css({ color: 'status.warn', fontSize: '11px', fontWeight: 650 });
  const subGroup = css({ display: 'grid', gap: '6px', pt: '10px', borderTop: '1px solid token(colors.line)' });
  const subGroupHeader = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 8px' });
  const subGroupTitle = css({ fontSize: '13px', fontWeight: 700 });
  const rollupSummary = css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '4px 10px',
    p: '7px 0',
    cursor: 'pointer',
    fontSize: '13px',
    _hover: { color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const rollupPanel = css({ borderTop: '1px solid token(colors.line)' });
  const rollupNames = css({
    m: 0,
    p: '0 0 8px',
    listStyle: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 14px',
    color: 'muted',
    fontSize: '12px',
  });
  // Tighter than the exposure matrix on purpose: six columns of short phrases fit the 1280 band
  // beside the tree, so the "not observable" column stays on screen instead of behind a scroll.
  const observationsTableWrap = css({
    contain: 'inline-size paint',
    maxW: 'full',
    minH: 'auto',
    minW: 0,
    '& > table': { tableLayout: 'auto', minW: 0, fontSize: '12px' },
    '& th, & td': { px: '8px' },
  });
</script>

{#if view === undefined}
  {#if errorMessage}
    <p class={muted} data-skill-observations-state="unavailable" role="status">
      Skill observations are unavailable. {errorMessage}
    </p>
  {:else}
    <p aria-busy="true" class={muted} data-skill-observations-state="loading">Loading skill observations…</p>
  {/if}
{:else if variant === 'skill'}
  <section aria-label="Skill observations" class={section} data-skill-observations="skill">
    <div class={sectionHeader}>
      <h3 class={panelTitle}>Skill observations</h3>
      <p class={panelSub}>
        Each count carries the tier of evidence behind it and the harness that recorded it. Tiers are never added
        together.
      </p>
    </div>
    <ObservationReadQualification {view} />
    {#if errorMessage}
      <p class={meta} data-skill-observations-refresh-error role="status">
        Current observation proof is unavailable. Retained positive evidence remains visible; absence-based verdicts are
        provisional. {errorMessage}
      </p>
    {/if}
    {#if rowOmitted}
      <p class={meta} data-skill-observation-row-omitted role="status">{OBSERVATION_ROW_OMITTED_TEXT}</p>
    {:else}
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
    {/if}
    <p class={meta} data-skill-observations-last-signal>
      {#if rowOmitted}
        {signalLabel}
        — {OBSERVATION_ROW_OMITTED_TEXT}
      {:else if row?.lastObservedAt}
        {signalLabel} <time datetime={row.lastObservedAt}>{formatObservedAt(row.lastObservedAt)}</time>
      {:else}
        {signalLabel}
        — {noSignalsText(view.signalsComplete)}.
      {/if}
    </p>
    {#if detailVerdict !== undefined}
      <p
        class={meta}
        data-skill-observations-verdict={row?.verdict ?? 'never-observed'}
        data-verdict-provisional={(row?.verdictProvisional ?? !view.invocationEvidenceComplete) ? 'true' : 'false'}
      >
        {detailVerdict}
      </p>
    {/if}
    <!-- A name that is installed twice has one set of counts, and the managed-derived verdict was
         decided from the other install. Naming the collision beats dropping the sentence in
         silence: an absent verdict reads as "nothing to say" rather than "ask a different
         question". -->
    {#if homonym !== undefined}
      <p class={meta} data-skill-observations-homonym role="status">{homonym}</p>
    {/if}
    {#if row?.deletionCandidate && managedClaimApplies}
      <p
        class={meta}
        data-skill-observations-deletion-candidate
        data-verdict-provisional={row.verdictProvisional ? 'true' : 'false'}
      >
        {deletionCandidateText(row)}
      </p>
    {/if}
    <!-- Per-metric provenance, beside the numbers rather than as a page banner. The resolved-path
         list below corroborates it whenever a name really did resolve to more than one directory. -->
    {#if !rowOmitted}
      <p class={meta} data-skill-observations-name-scope>{NAME_SCOPED_COUNTS_TEXT}</p>
      {#if (row?.resolvedPaths.length ?? 0) > 0}
        {#each row?.resolvedPaths ?? [] as resolvedPath (resolvedPath)}
          <p class={pathText}>{resolvedPath}</p>
        {/each}
        {#if row?.resolvedPathsTruncated}
          <p class={meta} data-skill-observations-resolved-paths-truncated>
            {resolvedPathsNote(row)}
          </p>
        {/if}
      {:else if row?.lastObservedAt}
        <p class={meta}>No harness disclosed a directory for this skill.</p>
      {/if}
    {/if}
  </section>
{:else}
  <section
    aria-label="Skill observations"
    class={cx(panel, stack)}
    data-skill-observations="overview"
    id="observed-usage"
  >
    <div class={sectionHeader}>
      <h2 class={panelTitle}>Skill observations</h2>
      <p class={panelSub}>
        Every count below carries its tier and its harness. A declared invocation and an inferred read are different
        evidence and are never summed.
      </p>
    </div>

    <ul aria-label="Harness observability" class={coverageList}>
      {#each view.harnesses as harness (harness.harnessKey)}
        <li data-harness-observability={harness.observability}>
          {harness.label}
          — {harness.observability === 'observable' ? 'can report skill observations' : NOT_OBSERVABLE_TEXT}
        </li>
      {/each}
    </ul>

    <ul aria-label="Observation tiers" class={coverageList}>
      {#each SKILL_OBSERVATION_TIER_ORDER as tier (tier)}
        <li>{tier} — {SKILL_OBSERVATION_TIER_DESCRIPTIONS[tier]}</li>
      {/each}
    </ul>

    <ObservationReadQualification {view} />
    {#if errorMessage}
      <p class={meta} data-skill-observations-refresh-error role="status">
        Current observation proof is unavailable. Retained positive evidence remains visible; absence-based verdicts are
        provisional. {errorMessage}
      </p>
    {/if}

    <p class={meta} data-skill-observations-table-note>
      Rows are ordered by evidence strength, then most recent signal. — means {noSignalsText(view.signalsComplete)}
      for an observable harness. Skills only seen in a catalogue are folded into the availability section below.
    </p>
    <!-- The wrapper scrolls when the harness columns exceed the panel, so it is a named, focusable
         region: a keyboard user must be able to reach the columns a pointer user can drag to. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-reachable -->
    <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
    <section aria-label="Skill observations by harness" class={cx(tableWrap, observationsTableWrap)} tabindex="0">
      <table class={table}>
        <thead>
          <tr>
            <th scope="col">Skill</th>
            {#each view.observableHarnesses as harness (harness.harnessKey)}
              <th scope="col">{harness.label}</th>
            {/each}
            <th scope="col">{signalLabel}</th>
          </tr>
        </thead>
        <tbody>
          {#if view.invocationRows.length === 0}
            <tr>
              <td class={muted} colspan={view.observableHarnesses.length + 2}>
                {view.invocationLowerBound
                  ? 'No managed or invocation-evidence row appears in this response.'
                  : 'No skills to report.'}
              </td>
            </tr>
          {:else}
            {#each view.invocationRows as observationRow (observationRow.skillName)}
              <tr data-observation-verdict={observationRow.verdict}>
                <th class={cx(strongCell, skillRowHeader)} scope="row">
                  {observationRow.skillName}
                  <span class={managedTag}>{observationRow.managed ? ' managed' : ' unmanaged'}</span>
                </th>
                {#each observationRow.harnesses.filter((cell) => cell.state !== 'not-observable') as cell (cell.harnessKey)}
                  <td class={observationCell} data-harness={cell.harnessKey} data-observation-state={cell.state}>
                    {#if cell.state === 'no-observations'}
                      <span aria-hidden="true" class={emptyCellMark}>—</span>
                      <span class={visuallyHidden}>{cell.summary}</span>
                    {:else}
                      {cell.summary}
                    {/if}
                  </td>
                {/each}
                <td
                  class={cx(observationCell, observedAt)}
                  data-observation-recency={observationRow.lastObservedAt
                    ? observationRecency(observationRow.lastObservedAt)
                    : undefined}
                >
                  {#if observationRow.lastObservedAt}
                    <time
                      datetime={observationRow.lastObservedAt}
                      title={formatObservedAt(observationRow.lastObservedAt)}
                      >{formatObservedDate(observationRow.lastObservedAt)}</time
                    >
                    {#if observationRecencyNote(observationRow.lastObservedAt)}
                      <span class={staleMark}> · {observationRecencyNote(observationRow.lastObservedAt)}</span>
                    {/if}
                  {:else}
                    {noSignalsText(view.signalsComplete)}
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </section>

    <section
      aria-label={view.invocationEvidenceComplete
        ? 'Projected everywhere, no invocation recorded'
        : 'Projected everywhere, no invocation in loaded history'}
      class={section}
      data-provisional={view.invocationEvidenceComplete ? 'false' : 'true'}
      data-skill-observations-group="deletion"
      id="observations-deletion"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>
          {view.invocationEvidenceComplete
            ? 'Projected everywhere, no invocation recorded'
            : 'Projected everywhere, no invocation in loaded history'}
        </h3>
        <p class={panelSub}>
          Managed skills installed in every enabled runtime with no invocation evidence in the history available here.
          Deletion candidates only when invocation history is complete. Being offered to a model does not count as use,
          and Cursor cannot report, so its projections are not evidence either way.
        </p>
        {#if !view.invocationEvidenceComplete}
          <p class={panelSub} data-skill-observations-provisional-note role="status">
            Provisional: invocation history is incomplete, so absence here is not proof.
          </p>
        {/if}
      </div>
      {#if view.deletionCandidates.length === 0}
        <p class={meta}>
          {view.invocationEvidenceComplete
            ? 'No managed skill installed everywhere lacks invocation evidence.'
            : 'Nothing qualifies within the retained history.'}
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

    <section
      aria-label="Invocation evidence, unmanaged"
      class={section}
      data-skill-observations-group="adoption"
      id="observations-adoption"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Invocation evidence, unmanaged</h3>
        <p class={panelSub}>
          Skills with declared or inferred invocation evidence that resolve to no entry in the managed inventory. Three
          very different situations, so they are listed apart. A skill that was only available to a model is listed
          under its catalogue further down: a catalogue lists everything, so availability is not invocation.
        </p>
      </div>
      {#if view.adoptionCandidates.length === 0}
        <p class={meta}>
          {view.invocationLowerBound
            ? 'No unmanaged invocation-evidence row appears in this response.'
            : 'Every skill with invocation evidence resolves to a managed inventory entry.'}
        </p>
      {:else}
        {#each view.adoptionGroups as group (group.residence)}
          <div class={subGroup} data-skill-observations-residence={group.residence}>
            <div class={subGroupHeader}>
              <h4 class={subGroupTitle}>
                {ADOPTION_GROUP_COPY[group.residence].heading}
                ·
                <span data-adoption-group-count={group.residence}
                  >{formatObservationCount(group.rows.length, view.invocationLowerBound)}</span
                >
              </h4>
              <p class={cx(panelSub, meta)}>{ADOPTION_GROUP_COPY[group.residence].description}</p>
            </div>
            <ul class={candidateList}>
              {#each group.rows as candidate (candidate.skillName)}
                <li>
                  {candidate.skillName}
                  <span class={meta}>
                    {observedHarnessSummary(candidate)}
                    {#if candidate.lastObservedAt}
                      · {signalLabel.toLowerCase()}
                      <time datetime={candidate.lastObservedAt}>{formatObservedDate(candidate.lastObservedAt)}</time>
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    </section>

    <section
      aria-label={view.invocationEvidenceComplete
        ? 'Available to a model, no invocation recorded'
        : 'Available to a model, no invocation in loaded history'}
      class={section}
      data-skill-observations-group="offered"
      id="observations-offered"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>
          {view.invocationEvidenceComplete
            ? 'Available to a model, no invocation recorded'
            : 'Available to a model, no invocation in loaded history'}
        </h3>
        <p class={panelSub}>
          Skills a harness made available to a model without invocation evidence. Availability proposes nothing on its
          own — and it is folded by catalogue, because every entry of one catalogue carries the same fact.
        </p>
      </div>
      {#if view.catalogueRollups.length === 0}
        <p class={meta}>
          {#if view.invocationLowerBound}
            No catalogue-only row appears in this response; invocation history is incomplete.
          {:else if view.lowerBound}
            No catalogue-only row was retained in this incomplete response.
          {:else}
            No skill was available to a model without an invocation also being recorded.
          {/if}
        </p>
      {:else}
        {#each view.catalogueRollups as rollup (rollup.key)}
          <details class={rollupPanel} data-skill-observations-catalogue={rollup.key}>
            <summary class={rollupSummary}>
              <span class={strongCell}>{rollup.label}</span>
              <span class={meta} data-catalogue-entry-count={rollup.key}
                >{cataloguePopulationCount(rollup.rows.length)}
                {rollup.rows.length === 1 ? 'skill' : 'skills'}</span
              >
              {#each rollup.exposureSummaries as exposureSummary (exposureSummary)}
                <span class={meta}>{exposureSummary}</span>
              {/each}
              {#if rollup.lastObservedAt}
                <span class={meta}
                  >{signalLabel.toLowerCase()}
                  <time datetime={rollup.lastObservedAt}>{formatObservedDate(rollup.lastObservedAt)}</time></span
                >
              {/if}
            </summary>
            <ul class={rollupNames}>
              {#each rollup.rows as candidate (candidate.skillName)}
                <li>{candidate.skillName}</li>
              {/each}
            </ul>
          </details>
        {/each}
      {/if}
    </section>
  </section>
{/if}
