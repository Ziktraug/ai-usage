<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';

  const wrap = css({ position: 'relative', h: '260px', minW: 0, overflow: 'hidden' });
  const svg = css({ w: '100%', h: '100%' });
  const gridline = css({ stroke: 'line', strokeWidth: 1 });
  const axis = css({ fill: 'muted', fontSize: '9px' });
  const point = css({ opacity: 0.78, stroke: 'surface', strokeWidth: 1 });
  const neutralPoint = css({ fill: 'muted' });
  const summary = css({ color: 'muted', fontSize: '11px' });
  const distribution = css({ borderTop: '1px solid token(colors.line)', pt: '8px', fontSize: '11px' });
  const distributionList = css({ display: 'grid', gap: '7px', mt: '8px' });
  const distributionRow = css({ display: 'grid', gap: '2px' });
  const distributionMeta = css({ color: 'muted' });
  const outliers = css({ display: 'grid', gap: '6px' });
  const listTitle = css({ textStyle: 'label', color: 'muted', m: 0 });
  const outlier = css({
    display: 'flex',
    justifyContent: 'space-between',
    gap: '8px',
    p: '7px',
    borderRadius: 'sm',
    textAlign: 'left',
    _hover: { bg: 'track' },
  });
  const legend = css({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const empty = css({ color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import { HarnessBadge, harnessMarkFillFor, panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { FocusedOverviewSessionItem, FocusedSessionShape } from '@ai-usage/report-core/focused-report-query';
  import { fmtDuration, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { presentSessionShape, SESSION_SHAPE_POINT_RADIUS, sessionShapePosition } from './session-shape-model';

  interface Props {
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    shape: FocusedSessionShape | null;
  }

  const unchangedItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem => item;
  let { onSelectSession = () => undefined, presentSessionItem = unchangedItem, shape }: Props = $props();
  const presented = $derived(shape ? presentSessionShape(shape, presentSessionItem) : null);
</script>

<section class={panel} data-session-shape>
  <div>
    <!-- h3: this panel only ever renders inside the "Advanced analysis" h2 section. -->
    <h4 class={panelTitle}>Session shape</h4>
    <p class={panelSub}>Duration × API value (log scales) — fixed-size marks show sessions or campaigns</p>
  </div>
  {#if presented}
    <div class={wrap}>
      <svg aria-hidden="true" class={svg} height="100%" width="100%">
        {#each presented.xTicks as tick (`x:${tick.value}`)}
          {@const position = sessionShapePosition(presented, tick.value, 1).x}
          <line class={gridline} x1={`${position}%`} x2={`${position}%`} y1="0" y2="100%"></line>
          <text class={axis} dx="3" dy="-5" x={`${position}%`} y="100%">{tick.label}</text>
        {/each}
        {#each presented.yTicks as tick (`y:${tick.value}`)}
          {@const position = sessionShapePosition(presented, 1, tick.value).y}
          <line class={gridline} x1="0" x2="100%" y1={`${position}%`} y2={`${position}%`}></line>
          <text class={axis} dy="-3" x="4" y={`${position}%`}>{tick.label}</text>
        {/each}
        {#each presented.points as item (`${item.row.rowId}:${item.aggregateCount}`)}
          {@const position = sessionShapePosition(presented, item.durationMs ?? 0, item.costApprox)}
          <circle
            class={cx(point, harnessMarkFillFor(item.harness) ?? neutralPoint)}
            cx={`${position.x}%`}
            cy={`${position.y}%`}
            data-session-shape-harness={item.harness}
            data-session-shape-point
            r={SESSION_SHAPE_POINT_RADIUS}
          >
            <title>
              {[
              `${item.label} — ${fmtMoney(item.costApprox)} · ${fmtDuration(item.durationMs)} · ${item.harness}`,
              item.kind === 'campaign' ? `${fmtNum(item.sessionCount)} sessions` : '',
              item.aggregateCount > 1 ? `${fmtNum(item.aggregateCount)} nearby sessions` : '',
            ].filter(Boolean).join(' · ')}
            </title>
          </circle>
        {/each}
      </svg>
    </div>
    <ul aria-label="Session Shape harness key" class={legend} data-session-shape-harness-key>
      {#each presented.harnesses as name (name)}
        <li><HarnessBadge {name} /></li>
      {/each}
    </ul>
    <p class={summary} data-session-shape-summary>
      {fmtNum(presented.totalPoints)}
      timed, fully priced sessions · {fmtNum(presented.points.length)} plotted session/campaign groups
    </p>
    <details class={distribution}>
      <summary>Distribution by harness</summary>
      <ul class={distributionList}>
        {#each presented.harnessSummaries as harness (harness.harness)}
          <li class={distributionRow}>
            <span
              ><HarnessBadge name={harness.harness} />
              · {fmtNum(harness.sessions)} sessions in {fmtNum(harness.groups)}
              {harness.groups === 1 ? 'group' : 'groups'}</span
            >
            <span class={distributionMeta}
              >Duration {fmtDuration(harness.durationMin)}–{fmtDuration(harness.durationMax)}
              · API value {fmtMoney(harness.costMin)}–{fmtMoney(harness.costMax)}</span
            >
          </li>
        {/each}
      </ul>
    </details>
    {#if presented.outliers.length > 0}
      <section aria-labelledby="session-shape-standouts-title" class={outliers}>
        <h5 class={listTitle} id="session-shape-standouts-title">Standout sessions</h5>
        {#each presented.outliers as item (item.row.rowId)}
          <button
            aria-label={`Inspect ${item.kind === 'campaign' ? 'campaign' : 'session'}: ${item.label}`}
            class={outlier}
            onclick={() => onSelectSession(item)}
            type="button"
          >
            <span>{item.label}</span>
            <span class={distributionMeta}
              >{fmtMoney(item.costApprox)}
              · {fmtDuration(item.durationMs)} · {item.harness}</span
            >
          </button>
        {/each}
      </section>
    {/if}
  {:else}
    <p class={empty}>Not enough timed, fully priced sessions in range</p>
  {/if}
</section>
