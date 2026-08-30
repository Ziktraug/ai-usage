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
    ADOPTION_GROUP_COPY,
    buildSkillObservationsView,
    deletionCandidateText,
    formatObservedAt,
    formatObservedDate,
    homonymNote,
    installVerdictText,
    managedVerdictDescribesInstall,
    NAME_SCOPED_COUNTS_TEXT,
    NOT_OBSERVABLE_TEXT,
    observationRecency,
    observationRecencyNote,
    observedHarnessSummary,
    resolvedPathsNote,
    SKILL_OBSERVATION_TIER_DESCRIPTIONS,
    SKILL_OBSERVATION_TIER_ORDER,
    type SkillInstallScope,
    skillObservationRow,
    verdictText,
  } from './model';

  let {
    errorMessage,
    /**
     * Which installation of the name this detail describes. Observations aggregate by name, so a
     * project install and a managed one sharing a name share one set of counts — and only the
     * caller knows which of them the page has selected.
     */
    installScope = 'global',
    observations,
    skillName,
    variant = 'overview',
  }: {
    errorMessage?: string | undefined;
    installScope?: SkillInstallScope;
    observations?: SkillObservations | undefined;
    skillName?: string | undefined;
    variant?: 'overview' | 'skill';
  } = $props();

  const view = $derived(observations === undefined ? undefined : buildSkillObservationsView(observations));
  const row = $derived(
    view === undefined || skillName === undefined ? undefined : skillObservationRow(view, skillName),
  );
  const managedClaimApplies = $derived(row === undefined || managedVerdictDescribesInstall(row, installScope));
  const homonym = $derived(row === undefined ? undefined : homonymNote(row, installScope));
  const detailVerdict = $derived(
    row === undefined
      ? verdictText({ verdict: 'never-observed', verdictProvisional: !(view?.invocationEvidenceComplete ?? true) })
      : installVerdictText(row, installScope),
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
      {:else if view.invocationEvidenceComplete}
        Never observed.
      {:else}
        No observation within the read bound.
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
  </section>
{:else}
  <section
    aria-label="Skill observations"
    class={cx(panel, stack)}
    data-skill-observations="overview"
    id="observed-usage"
  >
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
      {#each SKILL_OBSERVATION_TIER_ORDER as tier (tier)}
        <li>{tier} — {SKILL_OBSERVATION_TIER_DESCRIPTIONS[tier]}</li>
      {/each}
    </ul>

    <!-- Two different facts, and collapsing them into one hedge is what made a store full of real
         invocation history read as if nothing had ever been invoked. A truncated exposure catalogue
         is routine — Codex writes one exposure row per catalogue entry per session — and costs the
         verdicts nothing; a truncated invocation read is the one that does. -->
    {#if view.lowerBound}
      <p
        class={meta}
        data-skill-observations-lower-bound={view.onlyExposureTruncated ? 'exposure' : 'invocations'}
        role="status"
      >
        {#if view.onlyExposureTruncated}
          The read carried every recorded invocation and stopped short of the full exposure catalogue, so
          <em>exposed</em>
          counts below are lower bounds. The verdicts are not affected.
        {:else}
          The observation read reached its bound, so every count below is a lower bound.
        {/if}
      </p>
    {/if}
    {#if view.skipped > 0}
      <p class={meta} data-skill-observations-skipped role="status">
        {view.skipped}
        stored observations could not be read and are not counted.
      </p>
    {/if}

    <p class={meta} data-skill-observations-table-note>
      Rows are ordered by evidence strength, then most recent observation. — means an observable harness recorded
      nothing. Skills only ever seen in a catalogue are folded under “Offered but never invoked” below.
    </p>
    <!-- The wrapper scrolls when the harness columns exceed the panel, so it is a named, focusable
         region: a keyboard user must be able to reach the columns a pointer user can drag to. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-reachable -->
    <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
    <section aria-label="Observed skill usage by harness" class={cx(tableWrap, observationsTableWrap)} tabindex="0">
      <table class={table}>
        <thead>
          <tr>
            <th scope="col">Skill</th>
            {#each view.observableHarnesses as harness (harness.harnessKey)}
              <th scope="col">{harness.label}</th>
            {/each}
            <th scope="col">Last observed</th>
          </tr>
        </thead>
        <tbody>
          {#if view.invocationRows.length === 0}
            <tr>
              <td class={muted} colspan={view.observableHarnesses.length + 2}>No skills to report.</td>
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
      data-provisional={view.invocationEvidenceComplete ? 'false' : 'true'}
      data-skill-observations-group="deletion"
      id="observations-deletion"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Projected everywhere but never invoked</h3>
        <p class={panelSub}>
          Managed skills installed in every enabled runtime that no harness recorded being used. Deletion candidates.
          Being offered to a model does not count as use, and Cursor cannot report, so its projections are not evidence
          either way.
        </p>
        {#if !view.invocationEvidenceComplete}
          <p class={panelSub} data-skill-observations-provisional-note role="status">
            Provisional: this read was bounded or could not read every stored row, so absence here is not proof.
          </p>
        {/if}
      </div>
      {#if view.deletionCandidates.length === 0}
        <p class={meta}>
          {view.invocationEvidenceComplete
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

    <section
      aria-label="Invoked but unmanaged"
      class={section}
      data-skill-observations-group="adoption"
      id="observations-adoption"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Invoked but unmanaged</h3>
        <p class={panelSub}>
          Skills a harness recorded being <em>used</em> that resolve to no entry in the managed inventory. Three very
          different situations, so they are listed apart. A skill that was only offered to a model is listed under its
          catalogue further down: a catalogue lists everything, so being in one is not use.
        </p>
      </div>
      {#if view.adoptionCandidates.length === 0}
        <p class={meta}>Every invoked skill resolves to a managed inventory entry.</p>
      {:else}
        {#each view.adoptionGroups as group (group.residence)}
          <div class={subGroup} data-skill-observations-residence={group.residence}>
            <div class={subGroupHeader}>
              <h4 class={subGroupTitle}>{ADOPTION_GROUP_COPY[group.residence].heading} · {group.rows.length}</h4>
              <p class={cx(panelSub, meta)}>{ADOPTION_GROUP_COPY[group.residence].description}</p>
            </div>
            <ul class={candidateList}>
              {#each group.rows as candidate (candidate.skillName)}
                <li>
                  {candidate.skillName}
                  <span class={meta}>
                    {observedHarnessSummary(candidate)}
                    {#if candidate.lastObservedAt}
                      · last
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
      aria-label="Offered but never invoked"
      class={section}
      data-skill-observations-group="offered"
      id="observations-offered"
    >
      <div class={sectionHeader}>
        <h3 class={panelTitle}>Offered but never invoked</h3>
        <p class={panelSub}>
          Skills a harness put in front of a model with no evidence any of them was used. A fact about offering, not
          about use, so it proposes nothing on its own — and it is folded by catalogue, because every entry of one
          catalogue carries the same fact.
        </p>
      </div>
      {#if view.catalogueRollups.length === 0}
        <p class={meta}>No skill was offered without also being invoked.</p>
      {:else}
        {#each view.catalogueRollups as rollup (rollup.key)}
          <details class={rollupPanel} data-skill-observations-catalogue={rollup.key}>
            <summary class={rollupSummary}>
              <span class={strongCell}>{rollup.label}</span>
              <span class={meta}>{rollup.rows.length} {rollup.rows.length === 1 ? 'skill' : 'skills'}</span>
              {#each rollup.exposureSummaries as exposureSummary (exposureSummary)}
                <span class={meta}>{exposureSummary}</span>
              {/each}
              {#if rollup.lastObservedAt}
                <span class={meta}
                  >last <time datetime={rollup.lastObservedAt}>{formatObservedDate(rollup.lastObservedAt)}</time></span
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
