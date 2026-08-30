<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    meta,
    metricDelta,
    metricLabel,
    metricTile,
    metricValue,
    muted,
    table,
    tableWrap,
  } from '@ai-usage/design-system/report';
  import { statusPill, statusPillInfo, statusPillOk, statusPillWarn, strongCell } from '@ai-usage/design-system/svelte';
  import { healthyLinkTone, type KnownProjectScope } from '../../../../skills-page-model';
  import { MATRIX_DOT_GLYPHS, matrixDotTone } from '../management/model';
  import {
    formatObservedAt,
    formatObservedDate,
    NAME_SCOPED_COUNTS_TEXT,
    noSignalsText,
    observationRecency,
    observationRecencyNote,
    observedHarnessSummary,
    type SkillObservationRow,
    verdictText,
  } from '../observations/model';
  import type { SkillsPresentationProjection } from '../presentation';
  import SelectionLink from './selection-link.svelte';

  let {
    knownProjects,
    presentation,
  }: {
    knownProjects: readonly KnownProjectScope[];
    presentation: SkillsPresentationProjection;
  } = $props();

  const observationsView = $derived(presentation.observations.view);
  const observationsState = $derived(presentation.observations.state);
  const rowsByName = $derived(presentation.observations.rowsByName);
  const adoptableGroup = $derived(
    observationsView?.adoptionGroups.find((group) => group.residence === 'runtime-installed'),
  );
  const strongestAdoptable = $derived(adoptableGroup?.rows.at(0));
  const deletionToneClass = $derived.by(() => {
    if (observationsView === undefined) {
      return;
    }
    return observationsView.deletionCandidates.length > 0 ? warnValue : okValue;
  });
  const health = $derived(presentation.health);
  const linksToneClass = $derived.by(() => {
    const tone = healthyLinkTone(health);
    if (tone === 'danger') {
      return dangerValue;
    }
    return tone === 'warn' ? warnValue : undefined;
  });
  const matrix = $derived(presentation.matrix);
  const targetLabelById = $derived(presentation.targetLabelById);
  const projectScopes = $derived(presentation.projectScopes);

  const verdictPill = (row: SkillObservationRow): { label: string; pill: string } => {
    if (row.deletionCandidate) {
      return { label: row.verdictProvisional ? 'deletion candidate?' : 'deletion candidate', pill: statusPillWarn };
    }
    if (row.verdict === 'invoked') {
      return { label: 'invocation evidence', pill: statusPillOk };
    }
    if (row.verdict === 'offered-only') {
      return { label: 'offered only', pill: statusPillInfo };
    }
    return {
      label: row.verdictProvisional ? 'no invocation in loaded history' : 'no invocation recorded',
      pill: statusPillInfo,
    };
  };

  const stack = css({ display: 'grid', gap: '12px' });
  const tileGrid = css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' });
  const tileLink = css({
    textDecoration: 'none',
    color: 'ink',
    cursor: 'pointer',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const warnValue = css({ color: 'status.warn' });
  const okValue = css({ color: 'status.ok' });
  const dangerValue = css({ color: 'status.danger' });
  const linksStrip = css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '6px 14px',
    p: '10px 12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    fontSize: '13px',
  });
  const stripLink = css({
    marginLeft: 'auto',
    color: 'accent',
    fontWeight: 600,
    textDecoration: 'none',
    _hover: { textDecoration: 'underline' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const inventoryTableWrap = css({
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
  const exposureCluster = css({ display: 'inline-flex', gap: '5px' });
  const exposureMark = css({
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
    '&[data-tone="missing"]': { bg: 'surfaceMuted', color: 'muted' },
    '&[data-tone="broken"]': { bg: 'status.dangerSoft', color: 'status.danger' },
    '&[data-tone="copy"]': { bg: 'status.warnSoft', color: 'status.warn' },
    '&[data-tone="none"]': { color: 'muted' },
  });
  const usageCell = css({ fontSize: '12px' });
  const observedAtCell = css({ whiteSpace: 'nowrap' });
  const staleMark = css({ color: 'status.warn', fontSize: '11px', fontWeight: 650 });
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
</script>

<div class={stack} data-skills-global-overview>
  {#if observationsView?.producerCompletenessMissing}
    <p class={meta} data-skill-observations-collection-pending role="status">
      Collecting historical skill observations… Results are incomplete until this pass finishes.
    </p>
  {/if}
  <div class={tileGrid} data-skills-overview-observations={observationsState} data-skills-verdict-tiles>
    <a class={cx(metricTile, tileLink)} data-verdict-tile="adopt" href="/skills/matrix#observations-adoption">
      <div class={metricLabel}>To adopt</div>
      <div>
        <div class={cx(metricValue, (adoptableGroup?.rows.length ?? 0) > 0 ? warnValue : undefined)}>
          {observationsView === undefined ? '—' : (adoptableGroup?.rows.length ?? 0)}
        </div>
        <div class={metricDelta}>
          {#if observationsState === 'unavailable'}
            observations unavailable
          {:else if observationsState === 'loading'}
            loading observations…
          {:else if strongestAdoptable}
            invocation evidence from a runtime directory, no managed home — latest: {strongestAdoptable.skillName}
          {:else}
            no unmanaged runtime skill has invocation evidence
          {/if}
        </div>
      </div>
    </a>
    <a class={cx(metricTile, tileLink)} data-verdict-tile="delete" href="/skills/matrix#observations-deletion">
      <div class={metricLabel}>To delete</div>
      <div>
        <div class={cx(metricValue, deletionToneClass)}>
          {observationsView?.deletionCandidates.length ?? '—'}
        </div>
        <div class={metricDelta}>
          {#if observationsState === 'unavailable'}
            observations unavailable
          {:else if observationsState === 'loading'}
            loading observations…
          {:else if (observationsView?.deletionCandidates.length ?? 0) > 0}
            {observationsView?.invocationEvidenceComplete
              ? 'projected everywhere, no invocation recorded'
              : 'projected everywhere, no invocation in loaded history — provisional'}
          {:else if observationsView?.invocationEvidenceComplete}
            no managed skill installed everywhere lacks invocation evidence
          {:else}
            nothing qualifies within the read bound
          {/if}
        </div>
      </div>
    </a>
    <a class={cx(metricTile, tileLink)} data-verdict-tile="catalogue" href="/skills/matrix#observations-offered">
      <div class={metricLabel}>Catalogue only</div>
      <div>
        <div class={metricValue}>{observationsView?.offeredOnly.length ?? '—'}</div>
        <div class={metricDelta}>
          {#if observationsState === 'unavailable'}
            observations unavailable
          {:else if observationsState === 'loading'}
            loading observations…
          {:else}
            {observationsView?.invocationEvidenceComplete
              ? 'available to a model, no invocation recorded — folded by catalogue'
              : 'available to a model, no invocation in loaded history — folded by catalogue'}
          {/if}
        </div>
      </div>
    </a>
  </div>

  {#if observationsView !== undefined}
    <ul aria-label="Observation coverage" class={coverageList}>
      {#each observationsView.harnesses as harness (harness.harnessKey)}
        <li data-skills-overview-observability={harness.observability}>
          {harness.label}
          — {harness.observability === 'not-observable' ? 'not observable' : 'observable'}
        </li>
      {/each}
    </ul>
  {/if}

  <div class={linksStrip} data-skills-links-strip>
    <span class={strongCell}>
      Links
      <span class={linksToneClass} data-links-tone={healthyLinkTone(health)}
        >{health.healthyLinkCount}/{health.expectedLinkCount}
        healthy</span
      >
    </span>
    <span class={meta}>{health.toLinkCount} to link</span>
    <span class={meta}>{health.toRepairCount} to repair</span>
    <span class={meta}>{health.blockedCount} blocked</span>
    {#if health.disabledCount > 0}
      <span class={meta}>{health.disabledCount} disabled</span>
    {/if}
    <a class={stripLink} href="/skills/matrix">Review &amp; reconcile</a>
  </div>

  {#if observationsView !== undefined}
    <p class={meta} data-skill-observations-name-scope>{NAME_SCOPED_COUNTS_TEXT}</p>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-reachable -->
  <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
  <section aria-label="Managed skills with skill signals" class={cx(tableWrap, inventoryTableWrap)} tabindex="0">
    <table class={table} data-skills-inventory-table>
      <thead>
        <tr>
          <th scope="col">Skill</th>
          <th scope="col">Exposure</th>
          <th scope="col">Skill signals</th>
          <th scope="col">Last signal</th>
          <th scope="col">Verdict</th>
        </tr>
      </thead>
      <tbody>
        {#if matrix.rows.length === 0}
          <tr>
            <td class={muted} colspan="5">No managed skills yet.</td>
          </tr>
        {:else}
          {#each matrix.rows as row (row.name)}
            {@const observationRow = rowsByName.get(row.name)}
            <tr data-inventory-skill={row.name}>
              <th class={cx(strongCell, skillNameCell)} scope="row">
                <SelectionLink
                  class={skillNameLink}
                  {knownProjects}
                  selection={{ skillName: row.name, type: 'global-skill' }}
                >
                  {row.name}
                </SelectionLink>
                <div class={descriptionText}>{row.description}</div>
              </th>
              <td>
                <span class={exposureCluster}>
                  {#each row.cells as cell (cell.targetId)}
                    {@const tone = matrixDotTone(cell.state)}
                    <span
                      aria-label={`${targetLabelById.get(cell.targetId) ?? cell.targetId} — ${cell.label}`}
                      class={exposureMark}
                      data-tone={tone}
                      role="img"
                      title={`${targetLabelById.get(cell.targetId) ?? cell.targetId} — ${cell.label}`}
                    >
                      {MATRIX_DOT_GLYPHS[tone]}
                    </span>
                  {/each}
                </span>
              </td>
              <td class={usageCell}>
                {#if observationsState === 'unavailable'}
                  <span class={muted} data-observation-state="unavailable">unavailable</span>
                {:else if observationsState === 'loading'}
                  <span class={muted} data-observation-state="loading">…</span>
                {:else if observationRow === undefined}
                  <span class={muted}>—</span>
                {:else if observedHarnessSummary(observationRow).length > 0}
                  {observedHarnessSummary(observationRow)}
                {:else}
                  <span aria-hidden="true" class={muted}>—</span>
                  <span class={visuallyHidden}>{noSignalsText(observationsView?.signalsComplete ?? false)}</span>
                {/if}
              </td>
              <td
                class={observedAtCell}
                data-observation-recency={observationRow?.lastObservedAt
                  ? observationRecency(observationRow.lastObservedAt)
                  : undefined}
              >
                {#if observationsState === 'unavailable'}
                  <span class={muted} data-observation-state="unavailable">unavailable</span>
                {:else if observationsState === 'loading'}
                  <span class={muted} data-observation-state="loading">…</span>
                {:else if observationRow?.lastObservedAt}
                  <time datetime={observationRow.lastObservedAt} title={formatObservedAt(observationRow.lastObservedAt)}
                    >{formatObservedDate(observationRow.lastObservedAt)}</time
                  >
                  {#if observationRecencyNote(observationRow.lastObservedAt)}
                    <span class={staleMark}> · {observationRecencyNote(observationRow.lastObservedAt)}</span>
                  {/if}
                {:else}
                  <span class={muted}>{noSignalsText(observationsView?.signalsComplete ?? false)}</span>
                {/if}
              </td>
              <td>
                {#if observationsState === 'unavailable'}
                  <span class={muted} data-observation-state="unavailable">unavailable</span>
                {:else if observationsState === 'loading'}
                  <span class={muted} data-observation-state="loading">…</span>
                {:else if observationRow !== undefined}
                  {@const pill = verdictPill(observationRow)}
                  <span
                    class={cx(statusPill, pill.pill)}
                    data-verdict-provisional={observationRow.verdictProvisional ? 'true' : 'false'}
                    title={verdictText(observationRow)}
                  >
                    {pill.label}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </section>

  {#if projectScopes.length > 0}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-reachable -->
    <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
    <section aria-label="Project scopes with skill signals" class={cx(tableWrap, inventoryTableWrap)} tabindex="0">
      <table class={table} data-skills-project-scope-table>
        <thead>
          <tr>
            <th scope="col">Project scope</th>
            <th scope="col">Skills</th>
            <th scope="col">Skill signals</th>
            <th scope="col">Last signal</th>
          </tr>
        </thead>
        <tbody>
          {#each projectScopes as scope (scope.key)}
            {@const usage = presentation.projectUsageByScopeKey.get(scope.key)}
            <tr data-project-scope-row={scope.label}>
              <th class={cx(strongCell, skillNameCell)} scope="row">
                <SelectionLink class={skillNameLink} {knownProjects} selection={scope.selection}>
                  {scope.label}
                </SelectionLink>
                {#if scope.shortPath}
                  <div class={descriptionText}>{scope.shortPath}</div>
                {/if}
              </th>
              <td class={usageCell}>{scope.skills.length}</td>
              <td class={usageCell}>
                {#if observationsState === 'unavailable'}
                  <span class={muted} data-observation-state="unavailable">unavailable</span>
                {:else if observationsState === 'loading'}
                  <span class={muted} data-observation-state="loading">…</span>
                {:else if (usage?.observedCount ?? 0) > 0 && usage?.top !== undefined}
                  {usage.observedCount}
                  with invocation evidence — top: {usage.top.skillName}
                  ({observedHarnessSummary(usage.top)})
                {:else}
                  <span aria-hidden="true" class={muted}>—</span>
                  <span class={visuallyHidden}>{noSignalsText(observationsView?.signalsComplete ?? false)}</span>
                {/if}
              </td>
              <td
                class={observedAtCell}
                data-observation-recency={usage?.lastObservedAt ? observationRecency(usage.lastObservedAt) : undefined}
              >
                {#if observationsState === 'unavailable'}
                  <span class={muted} data-observation-state="unavailable">unavailable</span>
                {:else if observationsState === 'loading'}
                  <span class={muted} data-observation-state="loading">…</span>
                {:else if usage?.lastObservedAt}
                  <time datetime={usage.lastObservedAt} title={formatObservedAt(usage.lastObservedAt)}
                    >{formatObservedDate(usage.lastObservedAt)}</time
                  >
                  {#if observationRecencyNote(usage.lastObservedAt)}
                    <span class={staleMark}> · {observationRecencyNote(usage.lastObservedAt)}</span>
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
  {/if}
</div>
