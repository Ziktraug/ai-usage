<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { HarnessBadge, panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import {
    canReconcileAll,
    type ReconcilePlanSummary,
    type SkillCellStateFilter,
    type SkillInvocation,
  } from '../../../../skills-page-model';
  import { buildSkillsMatrixView, matrixDotTone, skillStateFilterLabels, skillStateFilterOrder } from './model';
  import SkillSwitch from './skill-switch.svelte';
  import {
    actionRow,
    activeButton,
    brokenDot,
    button,
    compactStack,
    copyDot,
    dangerPill,
    disabledName,
    filterBar,
    inactive,
    infoPill,
    linkedDot,
    missingDot,
    mobileCard,
    mobileCards,
    muted,
    panelHeader,
    pathText,
    pill,
    planList,
    planPanel,
    primaryButton,
    searchInput,
    skillName,
    skillTop,
    stack,
    statusDot,
    stickyCell,
    table,
    tableCell,
    tableWrap,
    warningPill,
  } from './styles';

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
    buildSkillsMatrixView(snapshot, { cellState: activeCellStateFilter, invocation, origin: selectedOrigin, query }),
  );
  const runtimeCopy = $derived(`${view.matrix.targets.length} enabled / ${snapshot.targets.length} configured`);
  const toggleStateFilter = (filter: SkillCellStateFilter): void =>
    onCellStateFilterChange(activeCellStateFilter === filter ? undefined : filter);
  const dotClass = (state: Parameters<typeof matrixDotTone>[0]): string | undefined => {
    const tone = matrixDotTone(state);
    if (tone === 'linked') {
      return linkedDot;
    }
    if (tone === 'missing') {
      return missingDot;
    }
    if (tone === 'broken') {
      return brokenDot;
    }
    if (tone === 'copy') {
      return copyDot;
    }
    return;
  };
  const validationClass = (status: string): string => {
    if (status === 'invalid') {
      return dangerPill;
    }
    if (status === 'warning') {
      return warningPill;
    }
    return infoPill;
  };
  const busyAttributes = (busy: boolean) => ({ 'aria-busy': busy ? 'true' : 'false' }) as const;
  const skillHref = (name: string): string => `/skills/global/${encodeURIComponent(name)}`;
</script>

<section class={cx(panel, stack)}>
  <div class={panelHeader}>
    <div>
      <h2 class={panelTitle}>Managed skills — exposure per runtime</h2>
      <p class={panelSub}>{runtimeCopy}</p>
    </div>
    <button
      {...busyAttributes(pendingOperation === 'preview-reconcile')}
      class={cx(button, primaryButton)}
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
      <strong>Planned actions ({reconcilePlan.apply.length})</strong>
      {#if reconcilePlan.apply.length > 0}
        <ul class={planList}>
          {#each reconcilePlan.apply as line}
            <li>{line}</li>
          {/each}
        </ul>
      {:else}
        <p class={muted}>Nothing to apply — every active skill is already linked.</p>
      {/if}
      {#if reconcilePlan.skipped.length > 0}
        <div class={muted}>Skipped ({reconcilePlan.skipped.length}) — unmanaged content is never touched</div>
        <ul class={planList}>
          {#each reconcilePlan.skipped as line}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
      <div class={actionRow}>
        <button
          {...busyAttributes(pendingOperation === 'reconcile-all')}
          class={cx(button, primaryButton)}
          data-pending={pendingOperation === 'reconcile-all' ? 'true' : undefined}
          disabled={pendingOperation !== null || reconcilePlan.apply.length === 0}
          onclick={onApplyReconcile}
          type="button"
        >
          Apply {reconcilePlan.apply.length} {reconcilePlan.apply.length === 1 ? 'action' : 'actions'}
        </button>
        <button class={button} disabled={pendingOperation !== null} onclick={onCancelReconcile} type="button">
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <div class={filterBar}>
    <button
      class={cx(button, invocation === undefined ? activeButton : undefined)}
      onclick={() => (invocation = undefined)}
      type="button"
    >
      All {view.allCount}
    </button>
    <button
      class={cx(button, invocation === 'auto' ? activeButton : undefined)}
      onclick={() => (invocation = 'auto')}
      type="button"
    >
      Auto {view.autoCount}
    </button>
    <button
      class={cx(button, invocation === 'manual' ? activeButton : undefined)}
      onclick={() => (invocation = 'manual')}
      type="button"
    >
      Manual {view.manualCount}
    </button>
    {#each view.origins as entry}
      <button
        class={cx(button, selectedOrigin === entry ? activeButton : undefined)}
        onclick={() => (selectedOrigin = selectedOrigin === entry ? undefined : entry)}
        type="button"
      >
        {entry}
      </button>
    {/each}
    {#each skillStateFilterOrder as stateFilter}
      <button
        class={cx(button, activeCellStateFilter === stateFilter ? activeButton : undefined)}
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

  <div class={tableWrap}>
    <table class={table}>
      <thead>
        <tr>
          <th class={cx(tableCell, stickyCell)}>Skill</th>
          {#each view.matrix.targets as target}
            <th class={tableCell}><HarnessBadge name={target.label} /></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if view.rows.length === 0}
          <tr>
            <td class={cx(tableCell, muted)} colspan={view.matrix.targets.length + 1}>
              No skills match the current filter.
            </td>
          </tr>
        {:else}
          {#each view.rows as row}
            <tr>
              <td class={cx(tableCell, stickyCell)}>
                <div class={compactStack}>
                  <div class={skillTop}>
                    <SkillSwitch
                      disabled={pendingOperation !== null}
                      enabled={row.enabled}
                      name={row.name}
                      onToggle={() => toggleSkill(row.name, !row.enabled)}
                      pending={pendingOperation === `toggle:${row.name}`}
                      showTitle
                    />
                    <a class={cx(skillName, row.enabled ? undefined : disabledName)} href={skillHref(row.name)}
                      >{row.name}</a
                    >
                    {#if row.validationStatus !== 'valid'}
                      <span class={cx(pill, validationClass(row.validationStatus))}>{row.validationStatus}</span>
                    {/if}
                  </div>
                  <div class={muted} title={row.description || 'No description'}>
                    {row.description || 'No description'}
                  </div>
                  <div class={actionRow}>
                    <span class={cx(pill, infoPill)}>{row.invocation === 'auto' ? 'Auto' : 'Manual'}</span>
                    {#if row.tokenTotal !== null}
                      <span class={cx(pill, row.tokenFlag ? dangerPill : infoPill)}>{row.tokenTotal} tok</span>
                    {/if}
                    {#if row.origin}
                      <span class={cx(pill, infoPill)}>{row.origin}</span>
                    {/if}
                  </div>
                </div>
              </td>
              {#each row.cells as cell}
                <td class={cx(tableCell, row.enabled ? undefined : inactive)} style="text-align:center">
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
        <div class={compactStack}>
          <div class={skillTop}>
            <SkillSwitch
              disabled={pendingOperation !== null}
              enabled={row.enabled}
              name={row.name}
              onToggle={() => toggleSkill(row.name, !row.enabled)}
              pending={pendingOperation === `toggle:${row.name}`}
            />
            <a class={cx(skillName, row.enabled ? undefined : disabledName)} href={skillHref(row.name)}>{row.name}</a>
            {#if row.validationStatus !== 'valid'}
              <span class={cx(pill, validationClass(row.validationStatus))}>{row.validationStatus}</span>
            {/if}
          </div>
          <div class={muted}>{row.description || 'No description'}</div>
        </div>
        <dl class={compactStack}>
          {#each row.cells as cell}
            <div class={panelHeader}>
              <dt>
                <HarnessBadge
                  name={view.matrix.targets.find((target) => target.id === cell.targetId)?.label ?? cell.targetId}
                />
              </dt>
              <dd class={cx(muted, actionRow)}>
                <span
                  aria-hidden="true"
                  class={cx(statusDot, dotClass(cell.state), row.enabled ? undefined : inactive)}
                ></span>{cell.label}
              </dd>
            </div>
          {/each}
        </dl>
      </li>
    {/each}
  </ul>

  <section aria-label="Projection state legend" class={actionRow}>
    <span class={cx(muted, actionRow)}><span class={cx(statusDot, linkedDot)}></span>Linked</span>
    <span class={cx(muted, actionRow)}><span class={cx(statusDot, missingDot)}></span>Not linked</span>
    <span class={cx(muted, actionRow)}><span class={cx(statusDot, brokenDot)}></span>Broken / wrong target</span>
    <span class={cx(muted, actionRow)}><span class={cx(statusDot, copyDot)}></span>Copy (not a link)</span>
    <span class={cx(muted, actionRow)}><span class={statusDot}></span>Disabled</span>
  </section>
</section>
