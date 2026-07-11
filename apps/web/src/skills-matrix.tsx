import { css, cx } from '@ai-usage/design-system/css';
import {
  activeFilterButton,
  commandButton,
  filterTextButton,
  ghostButton,
  HarnessBadge,
  muted,
  panel,
  panelHeaderRow,
  panelSub,
  panelTitle,
  searchInput,
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
import type { ProjectionState, SkillManagementSnapshot } from '@ai-usage/skills';
import { Link } from '@tanstack/solid-router';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import {
  buildSkillMatrix,
  canReconcileAll,
  filterMatrixRows,
  type MatrixCellState,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
  type SkillInvocation,
  type SkillRowFilter,
} from './skills-page-model';

const filterBar = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  mb: '12px',
});

const activeFilter = css({
  borderColor: 'accent',
  color: 'accent',
  bg: 'accentTint',
});

const busyButton = css({
  position: 'relative',
  '&[data-pending=true]': {
    _after: {
      content: '" ..."',
      color: 'accent',
    },
  },
});

const matrixTable = css({
  minW: '860px',
});

// tableWrap reserves 320px for the report's long tables; the matrix only has
// a handful of rows, so let it hug its content instead.
const matrixWrap = css({
  minH: 'auto',
  display: { base: 'none', md: 'block' },
});

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

const mobileRuntimeList = css({
  display: 'grid',
  gap: '7px',
  m: 0,
});

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

const skillCell = css({
  display: 'grid',
  gap: '5px',
  maxW: '440px',
});

const skillTop = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minW: 0,
});

const switchButton = css({
  appearance: 'none',
  position: 'relative',
  w: '32px',
  h: '18px',
  flexShrink: 0,
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  cursor: 'pointer',
  _after: {
    content: '""',
    position: 'absolute',
    top: '2px',
    left: '2px',
    w: '12px',
    h: '12px',
    borderRadius: 'full',
    bg: 'muted',
    transition: 'transform 0.15s, background-color 0.15s',
  },
  '&[aria-checked=true]': {
    bg: 'status.okSoft',
    borderColor: 'status.ok',
    _after: {
      bg: 'status.ok',
      transform: 'translateX(14px)',
    },
  },
  _disabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  '&[data-pending=true]': {
    borderColor: 'accent',
    _before: {
      content: '"…" ',
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'accent',
      fontSize: '13px',
      fontWeight: 800,
      lineHeight: 1,
    },
    _after: {
      opacity: 0.25,
    },
  },
});

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
  _hover: {
    color: 'accent',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const disabledName = css({
  textDecoration: 'line-through',
  color: 'muted',
});

const skillDescription = css({
  color: 'muted',
  fontSize: '12px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxW: '400px',
});

const badgeRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
});

const centerCell = css({
  textAlign: 'center',
});

const inactiveCells = css({
  opacity: 0.5,
});

const clickableRow = css({
  _hover: {
    bg: 'surfaceMuted',
  },
});

const legend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px 14px',
  mt: '12px',
  color: 'muted',
  fontSize: '12px',
});

const legendItem = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
});

const planPanel = css({
  display: 'grid',
  gap: '8px',
  mb: '12px',
  p: '12px 14px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'accentTint',
});

const planList = css({
  display: 'grid',
  gap: '3px',
  m: 0,
  pl: '18px',
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'ink',
  overflowWrap: 'anywhere',
});

const planSkippedList = css({
  color: 'muted',
});

const planLabel = css({
  fontSize: '11px',
  fontWeight: 650,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: 'muted',
});

const planActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

const originTone = (origin: string) => {
  if (origin === 'github') {
    return statusPillInfo;
  }
  if (origin === 'skills.sh') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

const validationPillClass = (status: string) => {
  if (status === 'invalid') {
    return statusPillDanger;
  }
  if (status === 'warning') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

const stateFilterLabels: Record<SkillCellStateFilter, string> = {
  blocked: 'Blocked',
  broken: 'Broken',
  disabled: 'Disabled',
  linked: 'Linked',
  'not-linked': 'Not linked',
};

const stateFilterOrder: readonly SkillCellStateFilter[] = ['linked', 'not-linked', 'broken', 'blocked', 'disabled'];

const dotClassFor = (state: MatrixCellState) => {
  if (state === 'linked') {
    return statusDotLinked;
  }
  if (state === 'missing') {
    return statusDotMissing;
  }
  if (
    state === 'broken-link' ||
    state === 'wrong-target' ||
    state === 'missing-target' ||
    state === 'duplicate-name-conflict' ||
    state === 'disabled-exposed'
  ) {
    return statusDotBroken;
  }
  if (state === 'unmanaged-copy' || state === 'unmanaged-symlink' || state === 'duplicate-same-content') {
    return statusDotCopy;
  }
  return statusDotNone;
};

const stateLabelForLegend = (state: ProjectionState | 'copy' | 'not-applicable') => {
  if (state === 'linked') {
    return 'Linked';
  }
  if (state === 'missing') {
    return 'Not linked';
  }
  if (state === 'copy') {
    return 'Copy (not a link)';
  }
  if (state === 'not-applicable') {
    return 'Disabled';
  }
  return 'Broken / wrong target';
};

const FilterButton = (props: { active: boolean; children: JSX.Element; disabled?: boolean; onClick: () => void }) => (
  <button
    class={cx(props.active ? activeFilterButton : filterTextButton, props.active ? activeFilter : undefined)}
    disabled={props.disabled}
    onClick={props.onClick}
    type="button"
  >
    {props.children}
  </button>
);

export const SkillsMatrix = (props: {
  activeCellStateFilter: SkillCellStateFilter | undefined;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onPreviewReconcile: () => void;
  pendingOperation: string | null;
  reconcilePlan: ReconcilePlanSummary | null;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const [invocation, setInvocation] = createSignal<SkillInvocation | undefined>();
  const [origin, setOrigin] = createSignal<string | undefined>();
  const [query, setQuery] = createSignal('');
  const matrix = createMemo(() => buildSkillMatrix(props.snapshot));
  const filter = createMemo(() => {
    const nextFilter: SkillRowFilter = { query: query() };
    const selectedInvocation = invocation();
    const selectedOrigin = origin();
    if (selectedInvocation !== undefined) {
      nextFilter.invocation = selectedInvocation;
    }
    if (selectedOrigin !== undefined) {
      nextFilter.origin = selectedOrigin;
    }
    if (props.activeCellStateFilter !== undefined) {
      nextFilter.cellState = props.activeCellStateFilter;
    }
    return nextFilter;
  });
  const rows = createMemo(() => filterMatrixRows(matrix().rows, filter()));
  const allCount = createMemo(() => matrix().rows.length);
  const autoCount = createMemo(() => matrix().rows.filter((row) => row.invocation === 'auto').length);
  const manualCount = createMemo(() => matrix().rows.filter((row) => row.invocation === 'manual').length);
  const origins = createMemo(() =>
    [
      ...new Set(
        matrix()
          .rows.map((row) => row.origin)
          .filter((value): value is string => value !== null),
      ),
    ].sort(),
  );
  const stateFilterCounts = createMemo(() => {
    const counts = new Map<SkillCellStateFilter, number>();
    for (const stateFilter of stateFilterOrder) {
      counts.set(stateFilter, filterMatrixRows(matrix().rows, { cellState: stateFilter }).length);
    }
    return counts;
  });
  const canRunReconcile = createMemo(() => canReconcileAll(props.snapshot));
  const runtimeCopy = createMemo(
    () => `${matrix().targets.length} enabled / ${props.snapshot.targets.length} configured`,
  );
  const toggleStateFilter = (stateFilter: SkillCellStateFilter) => {
    props.onCellStateFilterChange(props.activeCellStateFilter === stateFilter ? undefined : stateFilter);
  };

  return (
    <section class={panel}>
      <div class={panelHeaderRow}>
        <div>
          <h2 class={panelTitle}>Managed skills — exposure per runtime</h2>
          <p class={panelSub}>{runtimeCopy()}</p>
        </div>
        <button
          aria-busy={props.pendingOperation === 'preview-reconcile' ? 'true' : undefined}
          class={cx(commandButton, busyButton)}
          data-pending={props.pendingOperation === 'preview-reconcile' ? 'true' : undefined}
          disabled={props.pendingOperation !== null || !canRunReconcile()}
          onClick={props.onPreviewReconcile}
          type="button"
        >
          Reconcile all…
        </button>
      </div>
      <Show when={props.reconcilePlan}>
        {(plan) => (
          <div class={planPanel}>
            <div class={strongCell}>Planned actions ({plan().apply.length})</div>
            <Show
              fallback={<p class={muted}>Nothing to apply — every active skill is already linked.</p>}
              when={plan().apply.length > 0}
            >
              <ul class={planList}>
                <For each={plan().apply}>{(line) => <li>{line}</li>}</For>
              </ul>
            </Show>
            <Show when={plan().skipped.length > 0}>
              <div class={planLabel}>Skipped ({plan().skipped.length}) — unmanaged content is never touched</div>
              <ul class={cx(planList, planSkippedList)}>
                <For each={plan().skipped}>{(line) => <li>{line}</li>}</For>
              </ul>
            </Show>
            <div class={planActions}>
              <button
                aria-busy={props.pendingOperation === 'reconcile-all' ? 'true' : undefined}
                class={cx(commandButton, busyButton)}
                data-pending={props.pendingOperation === 'reconcile-all' ? 'true' : undefined}
                disabled={props.pendingOperation !== null || plan().apply.length === 0}
                onClick={props.onApplyReconcile}
                type="button"
              >
                Apply {plan().apply.length} {plan().apply.length === 1 ? 'action' : 'actions'}
              </button>
              <button class={ghostButton} onClick={props.onCancelReconcile} type="button">
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
      <div class={filterBar}>
        <FilterButton active={invocation() === undefined} onClick={() => setInvocation()}>
          All {allCount()}
        </FilterButton>
        <FilterButton active={invocation() === 'auto'} onClick={() => setInvocation('auto')}>
          Auto {autoCount()}
        </FilterButton>
        <FilterButton active={invocation() === 'manual'} onClick={() => setInvocation('manual')}>
          Manual {manualCount()}
        </FilterButton>
        <For each={origins()}>
          {(entry) => (
            <FilterButton active={origin() === entry} onClick={() => setOrigin(origin() === entry ? undefined : entry)}>
              {entry}
            </FilterButton>
          )}
        </For>
        <For each={stateFilterOrder}>
          {(stateFilter) => {
            const filterCount = () => stateFilterCounts().get(stateFilter) ?? 0;
            return (
              <FilterButton
                active={props.activeCellStateFilter === stateFilter}
                disabled={filterCount() === 0}
                onClick={() => toggleStateFilter(stateFilter)}
              >
                {stateFilterLabels[stateFilter]} {filterCount()}
              </FilterButton>
            );
          }}
        </For>
        <input
          class={searchInput}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter skills…"
          value={query()}
        />
      </div>
      <div class={cx(tableWrap, matrixWrap)}>
        <table class={cx(table, matrixTable)}>
          <thead>
            <tr>
              <th class={stickyCol}>Skill</th>
              <For each={matrix().targets}>
                {(target) => (
                  <th>
                    <HarnessBadge name={target.label} />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Show
              fallback={
                <tr>
                  <td class={muted} colspan={matrix().targets.length + 1}>
                    No skills match the current filter.
                  </td>
                </tr>
              }
              when={rows().length > 0}
            >
              <For each={rows()}>
                {(row) => (
                  <tr class={clickableRow}>
                    <td class={stickyCol}>
                      <div class={skillCell}>
                        <div class={skillTop}>
                          <button
                            aria-busy={props.pendingOperation === `toggle:${row.name}` ? 'true' : undefined}
                            aria-checked={row.enabled}
                            aria-label={row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`}
                            class={switchButton}
                            data-pending={props.pendingOperation === `toggle:${row.name}` ? 'true' : undefined}
                            disabled={props.pendingOperation !== null}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.toggleSkill(row.name, !row.enabled);
                            }}
                            role="switch"
                            title={row.enabled ? 'Disable' : 'Enable'}
                            type="button"
                          />
                          <Link
                            class={cx(strongCell, skillName, skillNameButton, row.enabled ? undefined : disabledName)}
                            params={{ skillName: row.name }}
                            resetScroll={false}
                            to="/skills/global/$skillName"
                          >
                            {row.name}
                          </Link>
                          <Show when={row.validationStatus !== 'valid'}>
                            <span class={cx(statusPill, validationPillClass(row.validationStatus))}>
                              {row.validationStatus}
                            </span>
                          </Show>
                        </div>
                        <div class={skillDescription} title={row.description || 'No description'}>
                          {row.description || 'No description'}
                        </div>
                        <div class={badgeRow}>
                          <span class={cx(statusPill, statusPillInfo)}>
                            {row.invocation === 'auto' ? 'Auto' : 'Manual'}
                          </span>
                          <Show when={row.tokenTotal !== null}>
                            <span class={cx(statusPill, row.tokenFlag ? statusPillDanger : statusPillInfo)}>
                              {row.tokenTotal} tok
                            </span>
                          </Show>
                          <Show when={row.origin}>
                            {(value) => <span class={cx(statusPill, originTone(value()))}>{value()}</span>}
                          </Show>
                        </div>
                      </div>
                    </td>
                    <For each={row.cells}>
                      {(cell) => (
                        <td class={cx(centerCell, row.enabled ? undefined : inactiveCells)}>
                          <span
                            aria-label={cell.label}
                            class={cx(statusDot, dotClassFor(cell.state))}
                            role="img"
                            title={cell.label}
                          />
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
      <ul aria-label="Managed skills by runtime" class={mobileCards}>
        <Show fallback={<li class={muted}>No skills match the current filter.</li>} when={rows().length > 0}>
          <For each={rows()}>
            {(row) => (
              <li class={mobileCard}>
                <div class={skillCell}>
                  <div class={skillTop}>
                    <button
                      aria-busy={props.pendingOperation === `toggle:${row.name}` ? 'true' : undefined}
                      aria-checked={row.enabled}
                      aria-label={row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`}
                      class={switchButton}
                      data-pending={props.pendingOperation === `toggle:${row.name}` ? 'true' : undefined}
                      disabled={props.pendingOperation !== null}
                      onClick={() => props.toggleSkill(row.name, !row.enabled)}
                      role="switch"
                      type="button"
                    />
                    <Link
                      class={cx(strongCell, skillName, skillNameButton, row.enabled ? undefined : disabledName)}
                      params={{ skillName: row.name }}
                      resetScroll={false}
                      to="/skills/global/$skillName"
                    >
                      {row.name}
                    </Link>
                    <Show when={row.validationStatus !== 'valid'}>
                      <span class={cx(statusPill, validationPillClass(row.validationStatus))}>
                        {row.validationStatus}
                      </span>
                    </Show>
                  </div>
                  <div class={skillDescription}>{row.description || 'No description'}</div>
                  <div class={badgeRow}>
                    <span class={cx(statusPill, statusPillInfo)}>{row.invocation === 'auto' ? 'Auto' : 'Manual'}</span>
                    <Show when={row.tokenTotal !== null}>
                      <span class={cx(statusPill, row.tokenFlag ? statusPillDanger : statusPillInfo)}>
                        {row.tokenTotal} tok
                      </span>
                    </Show>
                    <Show when={row.origin}>
                      {(value) => <span class={cx(statusPill, originTone(value()))}>{value()}</span>}
                    </Show>
                  </div>
                </div>
                <dl class={mobileRuntimeList}>
                  <For each={row.cells}>
                    {(cell) => {
                      const target = () => matrix().targets.find((entry) => entry.id === cell.targetId);
                      return (
                        <div class={mobileRuntimeRow}>
                          <dt>
                            <HarnessBadge name={target()?.label ?? cell.targetId} />
                          </dt>
                          <dd class={mobileRuntimeState}>
                            <span
                              aria-hidden="true"
                              class={cx(statusDot, dotClassFor(cell.state), row.enabled ? undefined : inactiveCells)}
                            />
                            {cell.label}
                          </dd>
                        </div>
                      );
                    }}
                  </For>
                </dl>
              </li>
            )}
          </For>
        </Show>
      </ul>
      <div class={legend}>
        <span class={legendItem}>
          <span class={cx(statusDot, statusDotLinked)} />
          {stateLabelForLegend('linked')}
        </span>
        <span class={legendItem}>
          <span class={cx(statusDot, statusDotMissing)} />
          {stateLabelForLegend('missing')}
        </span>
        <span class={legendItem}>
          <span class={cx(statusDot, statusDotBroken)} />
          {stateLabelForLegend('broken-link')}
        </span>
        <span class={legendItem}>
          <span class={cx(statusDot, statusDotCopy)} />
          {stateLabelForLegend('copy')}
        </span>
        <span class={legendItem}>
          <span class={cx(statusDot, statusDotNone)} />
          {stateLabelForLegend('not-applicable')}
        </span>
      </div>
    </section>
  );
};
