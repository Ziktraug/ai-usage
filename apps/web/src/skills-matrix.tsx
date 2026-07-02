import { css, cx } from '@ai-usage/design-system/css';
import {
  activeFilterButton,
  commandButton,
  filterTextButton,
  ghostButton,
  HarnessBadge,
  muted,
  panel,
  panelHeader,
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
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import {
  buildSkillMatrix,
  canReconcileAll,
  filterMatrixRows,
  type MatrixCellState,
  type ReconcilePlanSummary,
  type SkillInvocation,
  type SkillRowFilter,
} from './skills-page-model';

const headerRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '12px',
  alignItems: 'center',
  justifyContent: 'space-between',
});

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

const matrixTable = css({
  minW: '860px',
});

// tableWrap reserves 320px for the report's long tables; the matrix only has
// a handful of rows, so let it hug its content instead.
const matrixWrap = css({
  minH: 'auto',
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
});

const skillName = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
  cursor: 'pointer',
  _hover: {
    bg: 'surfaceMuted',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
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

const operationPanel = css({
  mt: '12px',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
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

const FilterButton = (props: { active: boolean; children: JSX.Element; onClick: () => void }) => (
  <button
    class={cx(props.active ? activeFilterButton : filterTextButton, props.active ? activeFilter : undefined)}
    onClick={props.onClick}
    type="button"
  >
    {props.children}
  </button>
);

export const SkillsMatrix = (props: {
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onOpenSkill: (skillName: string, element: HTMLElement) => void;
  onPreviewReconcile: () => void;
  operationMessage: string | null;
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
  const canRunReconcile = createMemo(() => canReconcileAll(props.snapshot));

  return (
    <section class={panel}>
      <div class={cx(panelHeader, headerRow)}>
        <div>
          <h2 class={panelTitle}>Managed skills — exposure per runtime</h2>
          <p class={panelSub}>{matrix().targets.length} enabled runtimes</p>
        </div>
        <button
          class={commandButton}
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
                class={commandButton}
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
            <For each={rows()}>
              {(row) => (
                <tr
                  class={clickableRow}
                  onClick={(event) => props.onOpenSkill(row.name, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      props.onOpenSkill(row.name, event.currentTarget);
                    }
                  }}
                  tabIndex={0}
                >
                  <td class={stickyCol}>
                    <div class={skillCell}>
                      <div class={skillTop}>
                        <button
                          aria-checked={row.enabled}
                          aria-label={row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`}
                          class={switchButton}
                          disabled={props.pendingOperation !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.toggleSkill(row.name, !row.enabled);
                          }}
                          role="switch"
                          title={row.enabled ? 'Disable' : 'Enable'}
                          type="button"
                        />
                        <span class={cx(strongCell, skillName, row.enabled ? undefined : disabledName)}>
                          {row.name}
                        </span>
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
          </tbody>
        </table>
      </div>
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
      <Show when={props.operationMessage}>{(message) => <div class={operationPanel}>{message()}</div>}</Show>
      <Show when={rows().length === 0}>
        <p class={muted}>No skills match the current filter.</p>
      </Show>
    </section>
  );
};
