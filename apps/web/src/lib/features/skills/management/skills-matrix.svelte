<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    actionRow,
    activeFilterButton,
    commandButton,
    filterTextButton,
    ghostButton,
    muted,
    panel,
    panelHeaderRow,
    panelSub,
    panelTitle,
    pendingButton,
    searchInput,
    skillsReconcilePlanList,
    statusDot,
    statusDotBroken,
    statusDotCopy,
    statusDotLinked,
    statusDotMissing,
    statusDotNone,
    statusPill,
    statusPillDanger,
    statusPillInfo,
    statusPillWarn,
    strongCell,
    table,
    tableWrap,
  } from '@ai-usage/design-system/report';
  import HarnessBadge from '@ai-usage/design-system/svelte/harness-badge';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import {
    canReconcileAll,
    type ReconcilePlanSummary,
    type SkillCellStateFilter,
    type SkillInvocation,
  } from '../../../../skills-page-model';
  import { buildSkillsMatrixView, matrixDotTone, skillStateFilterLabels, skillStateFilterOrder } from './model';
  import SkillSwitch from './skill-switch.svelte';

  const filterBar = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', mb: '12px' });
  const activeFilter = css({ borderColor: 'accent', color: 'accent', bg: 'accentTint' });
  const positionedButton = css({ position: 'relative' });
  const matrixTable = css({ minW: '860px' });
  const matrixWrap = css({ minH: 'auto', display: { base: 'none', md: 'block' } });
  const mobileCards = css({
    display: { base: 'grid', md: 'none' },
    gap: '10px',
    m: 0,
    p: 0,
    listStyle: 'none',
  });
  const mobileCard = css({
    display: 'grid',
    gap: '12px',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
  });
  const mobileRuntimeList = css({ display: 'grid', gap: '7px', m: 0 });
  const mobileRuntimeRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '8px',
    p: '7px 0',
    borderTop: '1px solid token(colors.line)',
  });
  const mobileRuntimeState = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    m: 0,
    color: 'muted',
    fontSize: '12px',
  });
  const stickyCol = css({
    position: 'sticky',
    left: 0,
    zIndex: 1,
    bg: 'surface',
    borderRight: '1px solid token(colors.line)',
    minW: '320px',
    textAlign: 'left',
  });
  const skillCell = css({ display: 'grid', gap: '5px', maxW: '440px' });
  const skillTop = css({ display: 'flex', alignItems: 'center', gap: '8px', minW: 0 });
  const skillName = css({
    overflow: 'hidden',
    overflowWrap: 'anywhere',
    whiteSpace: 'normal',
    textAlign: 'left',
    lineHeight: 1.25,
    maxH: '2.5em',
  });
  const skillNameButton = css({
    appearance: 'none',
    border: 0,
    p: 0,
    bg: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    _hover: { color: 'accent', textDecoration: 'underline', textUnderlineOffset: '2px' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const disabledName = css({ textDecoration: 'line-through', color: 'muted' });
  const skillDescription = css({
    color: 'muted',
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxW: '400px',
  });
  const badgeRow = css({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const centerCell = css({ textAlign: 'center' });
  const inactiveCells = css({ opacity: 0.5 });
  const clickableRow = css({ _hover: { bg: 'surfaceMuted' } });
  const legend = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px 14px',
    mt: '12px',
    color: 'muted',
    fontSize: '12px',
  });
  const legendItem = css({ display: 'inline-flex', alignItems: 'center', gap: '6px' });
  const planPanel = css({
    display: 'grid',
    gap: '8px',
    mb: '12px',
    p: '12px 14px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'accentTint',
  });
  const planSkippedList = css({ color: 'muted' });
  const planLabel = css({
    fontSize: '11px',
    fontWeight: 650,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'muted',
  });

  let {
    activeCellStateFilter,
    onApplyReconcile,
    onCancelReconcile,
    onCellStateFilterChange,
    onPreviewReconcile,
    pendingOperation,
    reconcilePlan,
    snapshot,
    toggleSkill,
  }: {
    activeCellStateFilter?: SkillCellStateFilter;
    onApplyReconcile: () => void;
    onCancelReconcile: () => void;
    onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
    onPreviewReconcile: () => void;
    pendingOperation: string | null;
    reconcilePlan: ReconcilePlanSummary | null;
    snapshot: SkillManagementSnapshot;
    toggleSkill: (skillName: string, enabled: boolean) => void;
  } = $props();

  let invocation = $state<SkillInvocation | undefined>();
  let selectedOrigin = $state<string | undefined>();
  let query = $state('');
  const view = $derived(
    buildSkillsMatrixView(snapshot, {
      ...(activeCellStateFilter === undefined ? {} : { cellState: activeCellStateFilter }),
      ...(invocation === undefined ? {} : { invocation }),
      ...(selectedOrigin === undefined ? {} : { origin: selectedOrigin }),
      query,
    }),
  );
  const runtimeCopy = $derived(`${view.matrix.targets.length} enabled / ${snapshot.targets.length} configured`);
  const toggleStateFilter = (filter: SkillCellStateFilter): void =>
    onCellStateFilterChange(activeCellStateFilter === filter ? undefined : filter);
  const dotClass = (state: Parameters<typeof matrixDotTone>[0]): string | undefined => {
    const tone = matrixDotTone(state);
    if (tone === 'linked') {
      return statusDotLinked;
    }
    if (tone === 'missing') {
      return statusDotMissing;
    }
    if (tone === 'broken') {
      return statusDotBroken;
    }
    if (tone === 'copy') {
      return statusDotCopy;
    }
    return statusDotNone;
  };
  const validationClass = (status: string): string => {
    if (status === 'invalid') {
      return statusPillDanger;
    }
    if (status === 'warning') {
      return statusPillWarn;
    }
    return statusPillInfo;
  };
  const originClass = (origin: string): string => (origin === 'skills.sh' ? statusPillWarn : statusPillInfo);
  const busyAttributes = (busy: boolean) => ({ 'aria-busy': busy ? 'true' : 'false' }) as const;
  const filterClass = (active: boolean): string =>
    cx(active ? activeFilterButton : filterTextButton, active ? activeFilter : undefined);
  const skillHref = (name: string): string => `/skills/global/${encodeURIComponent(name)}`;
</script>

<section class={panel}>
  <div class={panelHeaderRow}>
    <div>
      <h2 class={panelTitle}>Managed skills — exposure per runtime</h2>
      <p class={panelSub}>{runtimeCopy}</p>
    </div>
    <button
      {...busyAttributes(pendingOperation === 'preview-reconcile')}
      class={cx(commandButton, pendingButton, positionedButton)}
      data-pending={pendingOperation === 'preview-reconcile' ? 'true' : undefined}
      disabled={pendingOperation !== null || !canReconcileAll(snapshot)}
      onclick={onPreviewReconcile}
      type="button"
    >
      Reconcile all…
    </button>
  </div>

  {#if reconcilePlan}
    <div class={planPanel}>
      <div class={strongCell}>Planned actions ({reconcilePlan.apply.length})</div>
      {#if reconcilePlan.apply.length > 0}
        <ul class={skillsReconcilePlanList}>
          {#each reconcilePlan.apply as line}
            <li>{line}</li>
          {/each}
        </ul>
      {:else}
        <p class={muted}>Nothing to apply — every active skill is already linked.</p>
      {/if}
      {#if reconcilePlan.skipped.length > 0}
        <div class={planLabel}>Skipped ({reconcilePlan.skipped.length}) — unmanaged content is never touched</div>
        <ul class={cx(skillsReconcilePlanList, planSkippedList)}>
          {#each reconcilePlan.skipped as line}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
      <div class={actionRow}>
        <button
          {...busyAttributes(pendingOperation === 'reconcile-all')}
          class={cx(commandButton, pendingButton, positionedButton)}
          data-pending={pendingOperation === 'reconcile-all' ? 'true' : undefined}
          disabled={pendingOperation !== null || reconcilePlan.apply.length === 0}
          onclick={onApplyReconcile}
          type="button"
        >
          Apply {reconcilePlan.apply.length} {reconcilePlan.apply.length === 1 ? 'action' : 'actions'}
        </button>
        <button class={ghostButton} disabled={pendingOperation !== null} onclick={onCancelReconcile} type="button">
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <div class={filterBar}>
    <button class={filterClass(invocation === undefined)} onclick={() => (invocation = undefined)} type="button">
      All {view.allCount}
    </button>
    <button class={filterClass(invocation === 'auto')} onclick={() => (invocation = 'auto')} type="button">
      Auto {view.autoCount}
    </button>
    <button class={filterClass(invocation === 'manual')} onclick={() => (invocation = 'manual')} type="button">
      Manual {view.manualCount}
    </button>
    {#each view.origins as entry}
      <button
        class={filterClass(selectedOrigin === entry)}
        onclick={() => (selectedOrigin = selectedOrigin === entry ? undefined : entry)}
        type="button"
      >
        {entry}
      </button>
    {/each}
    {#each skillStateFilterOrder as stateFilter}
      <button
        class={filterClass(activeCellStateFilter === stateFilter)}
        disabled={(view.stateFilterCounts.get(stateFilter) ?? 0) === 0}
        onclick={() => toggleStateFilter(stateFilter)}
        type="button"
      >
        {skillStateFilterLabels[stateFilter]} {view.stateFilterCounts.get(stateFilter) ?? 0}
      </button>
    {/each}
    <input
      aria-label="Filter skills"
      class={searchInput}
      oninput={(event) => (query = event.currentTarget.value)}
      placeholder="Filter skills…"
      value={query}
    >
  </div>

  <div class={cx(tableWrap, matrixWrap)}>
    <table class={cx(table, matrixTable)}>
      <thead>
        <tr>
          <th class={stickyCol}>Skill</th>
          {#each view.matrix.targets as target}
            <th><HarnessBadge name={target.label} /></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if view.rows.length === 0}
          <tr>
            <td class={muted} colspan={view.matrix.targets.length + 1}>No skills match the current filter.</td>
          </tr>
        {:else}
          {#each view.rows as row}
            <tr class={clickableRow}>
              <td class={stickyCol}>
                <div class={skillCell}>
                  <div class={skillTop}>
                    <SkillSwitch
                      disabled={pendingOperation !== null}
                      enabled={row.enabled}
                      name={row.name}
                      onToggle={() => toggleSkill(row.name, !row.enabled)}
                      pending={pendingOperation === `toggle:${row.name}`}
                      showTitle
                    />
                    <a
                      class={cx(strongCell, skillName, skillNameButton, row.enabled ? undefined : disabledName)}
                      href={skillHref(row.name)}
                      >{row.name}</a
                    >
                    {#if row.validationStatus !== 'valid'}
                      <span class={cx(statusPill, validationClass(row.validationStatus))}>{row.validationStatus}</span>
                    {/if}
                  </div>
                  <div class={skillDescription} title={row.description || 'No description'}>
                    {row.description || 'No description'}
                  </div>
                  <div class={badgeRow}>
                    <span class={cx(statusPill, statusPillInfo)}>{row.invocation === 'auto' ? 'Auto' : 'Manual'}</span>
                    {#if row.tokenTotal !== null}
                      <span class={cx(statusPill, row.tokenFlag ? statusPillDanger : statusPillInfo)}
                        >{row.tokenTotal}
                        tok</span
                      >
                    {/if}
                    {#if row.origin}
                      <span class={cx(statusPill, originClass(row.origin))}>{row.origin}</span>
                    {/if}
                  </div>
                </div>
              </td>
              {#each row.cells as cell}
                <td class={cx(centerCell, row.enabled ? undefined : inactiveCells)}>
                  <span
                    aria-label={cell.label}
                    class={cx(statusDot, dotClass(cell.state))}
                    role="img"
                    title={cell.label}
                  ></span>
                </td>
              {/each}
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  <ul aria-label="Managed skills by runtime" class={mobileCards}>
    {#if view.rows.length === 0}
      <li class={muted}>No skills match the current filter.</li>
    {/if}
    {#each view.rows as row}
      <li class={mobileCard}>
        <div class={skillCell}>
          <div class={skillTop}>
            <SkillSwitch
              disabled={pendingOperation !== null}
              enabled={row.enabled}
              name={row.name}
              onToggle={() => toggleSkill(row.name, !row.enabled)}
              pending={pendingOperation === `toggle:${row.name}`}
            />
            <a
              class={cx(strongCell, skillName, skillNameButton, row.enabled ? undefined : disabledName)}
              href={skillHref(row.name)}
              >{row.name}</a
            >
            {#if row.validationStatus !== 'valid'}
              <span class={cx(statusPill, validationClass(row.validationStatus))}>{row.validationStatus}</span>
            {/if}
          </div>
          <div class={skillDescription}>{row.description || 'No description'}</div>
          <div class={badgeRow}>
            <span class={cx(statusPill, statusPillInfo)}>{row.invocation === 'auto' ? 'Auto' : 'Manual'}</span>
            {#if row.tokenTotal !== null}
              <span class={cx(statusPill, row.tokenFlag ? statusPillDanger : statusPillInfo)}>
                {row.tokenTotal}
                tok
              </span>
            {/if}
            {#if row.origin}
              <span class={cx(statusPill, originClass(row.origin))}>{row.origin}</span>
            {/if}
          </div>
        </div>
        <dl class={mobileRuntimeList}>
          {#each row.cells as cell}
            <div class={mobileRuntimeRow}>
              <dt>
                <HarnessBadge
                  name={view.matrix.targets.find((target) => target.id === cell.targetId)?.label ?? cell.targetId}
                />
              </dt>
              <dd class={mobileRuntimeState}>
                <span
                  aria-hidden="true"
                  class={cx(statusDot, dotClass(cell.state), row.enabled ? undefined : inactiveCells)}
                ></span>{cell.label}
              </dd>
            </div>
          {/each}
        </dl>
      </li>
    {/each}
  </ul>

  <div class={legend}>
    <span class={legendItem}> <span class={cx(statusDot, statusDotLinked)}></span>Linked </span>
    <span class={legendItem}> <span class={cx(statusDot, statusDotMissing)}></span>Not linked </span>
    <span class={legendItem}> <span class={cx(statusDot, statusDotBroken)}></span>Broken / wrong target </span>
    <span class={legendItem}> <span class={cx(statusDot, statusDotCopy)}></span>Copy (not a link) </span>
    <span class={legendItem}> <span class={cx(statusDot, statusDotNone)}></span>Disabled </span>
  </div>
</section>
