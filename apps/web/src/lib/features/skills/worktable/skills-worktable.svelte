<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte serializes these dynamic states to valid true/false ARIA tokens asserted by SSR tests -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { meta, muted, statusPill, statusPillInfo, statusPillWarn, strongCell } from '@ai-usage/design-system/report';
  import { count } from '../../../../skills-page-model';
  import { toggleOperation } from '../management/model';
  import type { SkillsManagementOperationEpisodePort } from '../management/operation-episode.svelte';
  import SkillSwitch from '../management/skill-switch.svelte';
  import { formatObservedAt } from '../observations/model';
  import ObservationReadQualification from '../observations/observation-read-qualification.svelte';
  import type { SkillsPresentationProjection } from '../presentation';
  import {
    type SkillsWorktableFilterId,
    type SkillsWorktableModel,
    type SkillsWorktableProjectRow,
    type SkillsWorktableSkillRow,
    WORKTABLE_EVIDENCE_NOTATION_TEXT,
    WORKTABLE_NAME_SCOPE_TEXT,
    WORKTABLE_PLACEMENT_LEGEND,
    worktableGlyph,
    worktableGroupVisible,
    worktableManagedEmptyText,
    worktableManagedRowVisible,
    worktableObservabilityText,
  } from './model';

  let {
    management,
    model,
    presentation,
    selectedName,
  }: {
    management: SkillsManagementOperationEpisodePort;
    model: SkillsWorktableModel;
    presentation: SkillsPresentationProjection;
    selectedName: string | undefined;
  } = $props();

  let filter = $state<SkillsWorktableFilterId>('all');
  let adoptionExpanded = $state(false);
  let externalExpanded = $state(false);
  let catalogueExpanded = $state(false);
  let expandedProjects = $state<ReadonlySet<string>>(new Set());
  const pendingOperation = $derived(management.pendingOperation);
  const observationsState = $derived(presentation.observations.state);
  const observationsError = $derived(presentation.observations.errorMessage);
  const visibleManagedRows = $derived(
    model.managedRows.filter((row) => worktableManagedRowVisible(filter, row, model.deletionCandidateNames)),
  );
  const columnCount = $derived(model.columns.length + 3);
  const emptyEvidenceText = (row: SkillsWorktableSkillRow): string => {
    if (observationsState === 'unavailable') {
      return 'skill observations unavailable';
    }
    if (observationsState === 'loading') {
      return 'skill observations loading';
    }
    if (row.observationRowOmitted) {
      return 'observation row omitted from this response';
    }
    return presentation.observations.view?.signalsComplete === true
      ? 'no invocation recorded'
      : 'no invocation in loaded history';
  };
  const toggleProject = (key: string): void => {
    const next = new Set(expandedProjects);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    expandedProjects = next;
  };
  const toggleSkill = async (name: string, enabled: boolean): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    await management.execute({
      kind: 'management',
      operation: toggleOperation(name, enabled),
      owner: 'worktable',
      pendingLabel: `toggle:${name}`,
    });
  };
  const ADOPT_GATE_TEXT =
    'Adopting a runtime copy into the source repository is not implemented yet — it waits on the approved file-operation plan.';

  const strip = css({ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'stretch' });
  const chip = css({
    appearance: 'none',
    display: 'grid',
    gap: '6px',
    alignContent: 'center',
    p: '12px 16px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    '&[aria-pressed="true"]': { borderColor: 'accent', bg: 'accentTint' },
  });
  const chipLabel = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    '[aria-pressed="true"] &': { color: 'ink' },
  });
  const chipValue = css({ fontFamily: 'mono', fontSize: '22px', fontWeight: 600, lineHeight: 1 });
  const stripAside = css({ display: 'grid', gap: '8px', alignContent: 'center', flex: '1 1 240px', minW: 0 });
  const observabilityLine = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 10px',
    alignItems: 'center',
    m: 0,
    p: 0,
    listStyle: 'none',
    color: 'muted',
    fontSize: '11px',
  });
  const notObservable = css({ textDecoration: 'line-through' });
  const notationLine = css({ color: 'muted', fontSize: '11px' });
  const notationDeclared = css({ fontFamily: 'mono', color: 'ink' });
  const notationInferred = css({ fontFamily: 'mono', color: 'muted' });
  const legendRow = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 18px',
    alignItems: 'center',
    m: 0,
    p: 0,
    listStyle: 'none',
    color: 'muted',
    fontFamily: 'mono',
    fontSize: '11px',
  });
  // A grid child sizes to its content by default, so without an explicit floor the table's own
  // width pushed the page 461px wide at 1280 instead of scrolling inside this box.
  const tableWrap = css({
    overflowX: 'auto',
    contain: 'inline-size',
    // The cells carry visually-hidden spans that spell each count's tier out in words. They are
    // absolutely positioned, so without a positioned ancestor here their containing block is the
    // viewport: a span sitting at x≈836 inside the scrolled table then widened the *document*,
    // and the page scrolled sideways on mobile even though the table itself was contained.
    position: 'relative',
    minW: 0,
    maxW: 'full',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const worktable = css({
    width: 'full',
    borderCollapse: 'collapse',
    fontSize: '13px',
    '& th, & td': { p: '10px 16px', textAlign: 'left', verticalAlign: 'middle' },
    '& thead th': {
      color: 'muted',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      borderBottom: '1px solid token(colors.line)',
      whiteSpace: 'nowrap',
    },
    '& tbody tr': { borderBottom: '1px solid token(colors.line)' },
  });
  const groupHeaderRow = css({ bg: 'surfaceMuted' });
  const groupHeaderCell = css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '4px 12px',
    alignItems: 'baseline',
  });
  const groupTitle = css({ fontSize: '12px', fontWeight: 650 });
  const nameCell = css({ display: 'grid', gap: '2px', minW: '260px', maxW: '380px' });
  const nameLink = css({
    color: 'ink',
    fontWeight: 650,
    textDecoration: 'none',
    _hover: { color: 'accent', textDecoration: 'underline' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const nameText = css({ fontWeight: 650 });
  const descriptionText = css({
    color: 'muted',
    fontSize: '11.5px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const dimmed = css({ opacity: 0.55 });
  const cellStack = css({ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' });
  const glyphMark = css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    w: '18px',
    h: '18px',
    borderRadius: 'xs',
    fontFamily: 'mono',
    fontSize: '11px',
    fontWeight: 700,
    '&[data-tone="linked"]': { bg: 'status.okSoft', color: 'status.ok' },
    '&[data-tone="missing"]': { bg: 'surfaceMuted', color: 'ink' },
    '&[data-tone="broken"]': { bg: 'status.dangerSoft', color: 'status.danger' },
    '&[data-tone="copy"]': { bg: 'status.warnSoft', color: 'status.warn' },
    '&[data-tone="none"]': { color: 'muted' },
  });
  const declaredCount = css({ fontFamily: 'mono', fontSize: '12px', color: 'ink' });
  const inferredCount = css({ fontFamily: 'mono', fontSize: '12px', color: 'muted' });
  const emptyCount = css({ fontFamily: 'mono', fontSize: '12px', color: 'muted' });
  const activityCell = css({ fontFamily: 'mono', fontSize: '11px', color: 'muted', whiteSpace: 'nowrap' });
  const staleMark = css({ color: 'status.warn', fontWeight: 650 });
  const actionCell = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' });
  const foldButton = css({
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    w: 'full',
    p: 0,
    border: 0,
    bg: 'transparent',
    color: 'muted',
    fontSize: '12px',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const expandButton = css({
    appearance: 'none',
    p: '2px 8px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'accent',
    fontSize: '12px',
    fontWeight: 650,
    cursor: 'pointer',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const adoptButton = css({
    appearance: 'none',
    p: '3px 12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'transparent',
    color: 'muted',
    fontSize: '12px',
    fontWeight: 650,
    cursor: 'not-allowed',
    opacity: 0.7,
  });
  const selectedRow = css({ bg: 'accentTint' });
  const visuallyHidden = css({
    position: 'absolute',
    w: '1px',
    h: '1px',
    m: '-1px',
    p: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
  });
  const catalogueNames = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 14px',
    m: 0,
    p: 0,
    listStyle: 'none',
    color: 'muted',
    fontSize: '12px',
  });
  const stack = css({ display: 'grid', gap: '16px', minW: 0 });
</script>

{#snippet evidenceCells(_row: SkillsWorktableSkillRow)}
  {#each _row.cells as cell (cell.columnKey)}
    <td data-worktable-cell={cell.columnKey}>
      <span class={cx(cellStack, _row.enabled ? undefined : dimmed)}>
        {#if cell.glyph}
          <span aria-hidden="true" class={glyphMark} data-tone={cell.tone}>{cell.glyph}</span>
          <span class={visuallyHidden}>{cell.placementLabel}</span>
        {/if}
        {#each cell.evidence as entry (entry.tier)}
          <span class={entry.tier === 'declared' ? declaredCount : inferredCount} data-evidence-tier={entry.tier}>
            <span aria-hidden="true">{entry.text}</span>
            <span class={visuallyHidden}>{entry.accessibleText}</span>
          </span>
        {/each}
        {#if cell.evidence.length === 0}
          {#if cell.glyph === undefined}
            <span aria-hidden="true" class={emptyCount}>—</span>
          {/if}
          <span class={visuallyHidden}>{emptyEvidenceText(_row)}</span>
        {/if}
      </span>
    </td>
  {/each}
{/snippet}

{#snippet activityCellFor(_row: SkillsWorktableSkillRow)}
  <td class={activityCell} data-observation-recency={_row.lastSignalRecency}>
    {#if _row.lastObservedAt}
      <time datetime={_row.lastObservedAt} title={formatObservedAt(_row.lastObservedAt)}>{_row.lastSignalText}</time>
      {#if _row.lastSignalStale}
        <span class={staleMark}> · stale</span>
      {/if}
    {:else}
      {_row.lastSignalText}
    {/if}
  </td>
{/snippet}

{#snippet skillNameCell(_row: SkillsWorktableSkillRow)}
  <th scope="row">
    <span class={cx(nameCell, _row.enabled ? undefined : dimmed)}>
      {#if _row.href}
        <a class={nameLink} data-sveltekit-noscroll href={_row.href}>{_row.name}</a>
      {:else}
        <span class={nameText}>{_row.name}</span>
      {/if}
      <span class={descriptionText} title={_row.description || _row.residence}>
        {_row.description || _row.residence}
      </span>
    </span>
  </th>
{/snippet}

<div class={stack} data-skills-worktable>
  <section aria-label="Skill decisions" class={strip}>
    {#each model.filters as entry (entry.id)}
      <button
        aria-label={`${entry.label} — ${entry.accessibleValue}`}
        aria-pressed={filter === entry.id ? 'true' : 'false'}
        class={chip}
        data-worktable-filter={entry.id}
        onclick={() => (filter = entry.id)}
        type="button"
      >
        <span class={chipLabel}>{entry.label}</span>
        <span class={chipValue}>{entry.value}</span>
      </button>
    {/each}
    <div class={stripAside}>
      <ul aria-label="Harness observability" class={observabilityLine}>
        {#each model.observability as harness (harness.label)}
          <li data-harness-observability={harness.observable ? 'observable' : 'not-observable'}>
            <span class={harness.observable ? undefined : notObservable}>{harness.label}</span>
            — {worktableObservabilityText(harness.observable)}
          </li>
        {/each}
      </ul>
      <p class={notationLine} data-worktable-notation>
        <span class={notationDeclared}>10</span>
        recorded invocations ·
        <span class={notationInferred}>~10</span>
        reconstructed from traces — never added together.
      </p>
    </div>
  </section>

  <ul aria-label="Placement marks" class={legendRow}>
    {#each WORKTABLE_PLACEMENT_LEGEND as entry (entry.tone)}
      <li>
        <span aria-hidden="true" class={glyphMark} data-tone={entry.tone}>{worktableGlyph(entry.tone)}</span>
        {entry.label}
      </li>
    {/each}
    <li>“offered to a model” counts stay out of the table — drawer and Catalogue group</li>
  </ul>

  <ObservationReadQualification view={presentation.observations.view} />
  {#if observationsError !== undefined && presentation.observations.view !== undefined}
    <p class={muted} data-skill-observations-refresh-error role="status">
      Current observation proof is unavailable. Retained positive evidence remains visible; absence-based verdicts are
      provisional. {observationsError}
    </p>
  {:else if observationsError !== undefined}
    <p class={muted} data-skill-observations-state="unavailable" role="status">
      Skill observations are unavailable. {observationsError}
    </p>
  {:else if observationsState === 'loading'}
    <p aria-busy="true" class={muted} data-skill-observations-state="loading">Loading skill observations…</p>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a horizontally scrollable region must be keyboard-reachable -->
  <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
  <section aria-label="Skills worktable" class={tableWrap} tabindex="0">
    <table class={worktable}>
      <thead>
        <tr>
          <th scope="col">Skill</th>
          {#each model.columns as column (column.key)}
            <th scope="col">{column.label}</th>
          {/each}
          <th scope="col">Activity</th>
          <th scope="col">State / Action</th>
        </tr>
      </thead>
      <tbody>
        {#if worktableGroupVisible(filter, 'managed')}
          <tr class={groupHeaderRow}>
            <td colspan={columnCount}>
              <div class={groupHeaderCell} data-worktable-group="managed">
                <span class={groupTitle}>Managed <span class={meta}>{model.managedRows.length}</span></span>
                <span class={meta}>Single source of truth — linked out to every harness</span>
              </div>
            </td>
          </tr>
          {#if visibleManagedRows.length === 0}
            <tr>
              <td class={muted} colspan={columnCount}>
                {worktableManagedEmptyText({
                  deletionCandidatesProvisional: model.deletionCandidatesProvisional,
                  filter,
                  observationsState,
                })}
              </td>
            </tr>
          {/if}
          {#each visibleManagedRows as row (row.name)}
            <tr class={row.name === selectedName ? selectedRow : undefined} data-worktable-row={row.name}>
              {@render skillNameCell(row)}
              {@render evidenceCells(row)}
              {@render activityCellFor(row)}
              <td>
                <div class={actionCell}>
                  <SkillSwitch
                    disabled={pendingOperation !== null}
                    enabled={row.enabled}
                    name={row.name}
                    onToggle={() => toggleSkill(row.name, !row.enabled)}
                    pending={pendingOperation === `toggle:${row.name}`}
                    showTitle
                  />
                  {#if row.enabled}
                    <span class={cx(statusPill, statusPillInfo)}>{row.invocationLabel}</span>
                    {#if row.issueCount > 0}
                      <span class={cx(statusPill, statusPillWarn)}>{count(row.issueCount, 'issue')}</span>
                    {/if}
                  {:else}
                    <span class={cx(statusPill, statusPillInfo)} data-worktable-disabled-state>Kept in source</span>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        {/if}

        {#if worktableGroupVisible(filter, 'to-adopt')}
          <tr class={groupHeaderRow}>
            <td colspan={columnCount}>
              <div class={groupHeaderCell} data-worktable-group="to-adopt">
                <span class={groupTitle}> To adopt <span class={meta}>{model.adoption.totalText}</span> </span>
                <span class={meta}>
                  Invocation evidence from a runtime directory, no managed home — ranked by evidence strength
                </span>
              </div>
            </td>
          </tr>
          {#if model.adoption.total === 0 && observationsState === 'ready'}
            <tr>
              <td class={muted} colspan={columnCount}>
                {model.adoption.emptyText}
              </td>
            </tr>
          {/if}
          {#each model.adoption.previewRows as row (row.name)}
            <tr data-worktable-row={row.name}>
              {@render skillNameCell(row)}
              {@render evidenceCells(row)}
              {@render activityCellFor(row)}
              <td>
                <button
                  aria-describedby="worktable-adopt-gate"
                  class={adoptButton}
                  data-worktable-adopt={row.name}
                  disabled
                  title={ADOPT_GATE_TEXT}
                  type="button"
                >
                  Adopt…
                </button>
              </td>
            </tr>
          {/each}
          {#if model.adoption.foldedRows.length > 0}
            <tr>
              <td colspan={columnCount}>
                <button
                  aria-expanded={adoptionExpanded ? 'true' : 'false'}
                  class={foldButton}
                  data-worktable-fold="adoption"
                  onclick={() => (adoptionExpanded = !adoptionExpanded)}
                  type="button"
                >
                  <span aria-hidden="true">{adoptionExpanded ? '▾' : '▸'}</span>
                  {count(model.adoption.foldedRows.length, 'more with weaker evidence', 'more with weaker evidence')}
                </button>
              </td>
            </tr>
            {#if adoptionExpanded}
              {#each model.adoption.foldedRows as row (row.name)}
                <tr data-worktable-row={row.name}>
                  {@render skillNameCell(row)}
                  {@render evidenceCells(row)}
                  {@render activityCellFor(row)}
                  <td>
                    <button
                      aria-describedby="worktable-adopt-gate"
                      class={adoptButton}
                      data-worktable-adopt={row.name}
                      disabled
                      title={ADOPT_GATE_TEXT}
                      type="button"
                    >
                      Adopt…
                    </button>
                  </td>
                </tr>
              {/each}
            {/if}
          {/if}
          {#if model.adoption.externalRows.length > 0}
            <tr>
              <td colspan={columnCount}>
                <button
                  aria-expanded={externalExpanded ? 'true' : 'false'}
                  class={foldButton}
                  data-worktable-fold="external"
                  onclick={() => (externalExpanded = !externalExpanded)}
                  type="button"
                >
                  <span aria-hidden="true">{externalExpanded ? '▾' : '▸'}</span>
                  {count(model.adoption.externalRows.length, 'more shipped with a harness or plugin')}
                  — they live upstream, not adoptable
                </button>
              </td>
            </tr>
            {#if externalExpanded}
              {#each model.adoption.externalRows as row (row.name)}
                <tr data-worktable-row={row.name}>
                  {@render skillNameCell(row)}
                  {@render evidenceCells(row)}
                  {@render activityCellFor(row)}
                  <td><span class={meta}>Upstream</span></td>
                </tr>
              {/each}
            {/if}
          {/if}
        {/if}

        {#if worktableGroupVisible(filter, 'projects')}
          <tr class={groupHeaderRow}>
            <td colspan={columnCount}>
              <div class={groupHeaderCell} data-worktable-group="projects">
                <span class={groupTitle}>
                  Projects
                  <span class={meta}>
                    {count(model.projectRows.length, 'repo')}
                    · {count(model.projectSkillCount, 'skill')}
                  </span>
                </span>
                <span class={meta}>Owned by their repository — observed in place, never written to</span>
              </div>
            </td>
          </tr>
          {#if model.projectRows.length === 0}
            <tr>
              <td class={muted} colspan={columnCount}>No project repository carries a skill directory.</td>
            </tr>
          {/if}
          {#each model.projectRows as project (project.key)}
            {@const expanded = expandedProjects.has(project.key)}
            <tr data-worktable-project={project.key}>
              <th scope="row">
                <span class={nameCell}>
                  <span class={nameText}>
                    {project.label}
                    <span class={meta}>{count(project.skillCount, 'skill')}</span>
                  </span>
                  <span class={descriptionText} title={project.shortPath}>{project.shortPath}</span>
                </span>
              </th>
              <td class={muted} colspan={model.columns.length + 1}>{project.summary} · {project.lastSignalText}</td>
              <td>
                <button
                  aria-expanded={expanded ? 'true' : 'false'}
                  class={expandButton}
                  data-worktable-project-expand={project.key}
                  onclick={() => toggleProject(project.key)}
                  type="button"
                >
                  {expanded ? 'Collapse' : 'Expand'}
                  <span class={visuallyHidden}> the skills in {project.label}</span>
                </button>
              </td>
            </tr>
            {#if expanded}
              {#each project.expandedRows as row (row.name)}
                <tr class={row.name === selectedName ? selectedRow : undefined} data-worktable-row={row.name}>
                  {@render skillNameCell(row)}
                  {@render evidenceCells(row)}
                  {@render activityCellFor(row)}
                  <td><span class={meta}>Read-only</span></td>
                </tr>
              {/each}
            {/if}
          {/each}
        {/if}

        {#if worktableGroupVisible(filter, 'catalogue')}
          <tr class={groupHeaderRow}>
            <td colspan={columnCount}>
              <div class={groupHeaderCell} data-worktable-group="catalogue">
                <span class={groupTitle}>
                  Catalogue only
                  <span class={meta}>{model.catalogue.entryCountText}</span>
                </span>
                <span class={meta}>{model.catalogue.description}</span>
              </div>
            </td>
          </tr>
          <tr>
            <td colspan={columnCount}>
              {#if observationsState !== 'ready'}
                <span class={muted}>Skill observation facts are {observationsState}.</span>
              {:else if model.catalogue.rollups.length === 0}
                <span class={muted}>{model.catalogue.emptyText}</span>
              {:else}
                <button
                  aria-expanded={catalogueExpanded ? 'true' : 'false'}
                  class={foldButton}
                  data-worktable-fold="catalogue"
                  onclick={() => (catalogueExpanded = !catalogueExpanded)}
                  type="button"
                >
                  <span aria-hidden="true">{catalogueExpanded ? '▾' : '▸'}</span>
                  {model.catalogue.foldSummary}
                </button>
              {/if}
            </td>
          </tr>
          {#if catalogueExpanded}
            {#each model.catalogue.rollups as rollup (rollup.key)}
              <tr data-skill-observations-catalogue={rollup.key}>
                <th scope="row"><span class={strongCell}>{rollup.label}</span></th>
                <td colspan={columnCount - 1}>
                  <span class={meta}>
                    {rollup.entryCountText}
                    {#each rollup.exposureSummaries as summary (summary)}
                      · {summary}
                    {/each}
                  </span>
                  <ul class={catalogueNames}>
                    {#each rollup.rows as entry (entry.skillName)}
                      <li>{entry.skillName}</li>
                    {/each}
                  </ul>
                </td>
              </tr>
            {/each}
          {/if}
        {/if}
      </tbody>
    </table>
  </section>

  <p class={meta} id="worktable-adopt-gate">{ADOPT_GATE_TEXT}</p>
  <p class={meta} data-worktable-name-scope>{WORKTABLE_NAME_SCOPE_TEXT}</p>
  <p class={visuallyHidden}>{WORKTABLE_EVIDENCE_NOTATION_TEXT}</p>
</div>
