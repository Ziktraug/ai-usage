import { cx } from '@ai-usage/design-system/css';
import {
  detailItem,
  detailLabel,
  detailValue,
  drawer,
  drawerActions,
  drawerBody,
  drawerClose,
  drawerCompare,
  drawerGrid,
  drawerLegend,
  drawerLegendItem,
  drawerLegendSwatch,
  drawerLegendValue,
  drawerNav,
  drawerPosition,
  drawerTitle,
  drawerTop,
  ghostButton,
  muted,
} from '@ai-usage/design-system/report';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { CampaignTotals, CampaignView } from './dashboard-model';
import type { FieldFilterKey } from './dashboard-search';
import { lineDeltaLabel, rtkSavedLabel, rtkSavedTitle } from './dashboard-sort';
import {
  type DashboardRow,
  fmtCompact,
  fmtDate,
  fmtDuration,
  fmtMoney,
  fmtNum,
  HarnessBadge,
  median,
  rowKey,
  SegmentBar,
  tokenSegmentClasses,
  UNKNOWN_PRICE_HINT,
} from './shared';

const DetailItem = (props: { label: string; value: string; hint?: string }) => (
  <div class={detailItem} title={props.hint}>
    <div class={detailLabel}>{props.label}</div>
    <div class={detailValue}>{props.value}</div>
  </div>
);

const fmtRatio = (ratio: number) => (ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`);

const fmtCampaignTotals = (totals: CampaignTotals) =>
  [
    `${fmtMoney(totals.totalCost)} API`,
    `${fmtCompact(totals.freshTokens)} fresh tokens`,
    `${fmtNum(totals.turns)} turns`,
    `${fmtNum(totals.tools)} tools`,
  ].join(' · ');

const campaignSessionSummary = (row: DashboardRow) =>
  [
    row.costKnown ? fmtMoney(row.costApprox) : '— API',
    `${fmtCompact(row.freshTokens)} fresh`,
    `${fmtNum(row.turns)} turns`,
    `${fmtNum(row.tools)} tools`,
  ].join(' · ');

export const SessionDrawer = (props: {
  row: DashboardRow;
  rows: DashboardRow[];
  selectedCampaign?: CampaignView | null;
  onClose: () => void;
  onNavigate: (delta: number) => void;
  onSelectSession: (row: DashboardRow) => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onClearFilters: () => void;
}) => {
  let closeButton: HTMLButtonElement | undefined;
  const [showAllCampaignSessions, setShowAllCampaignSessions] = createSignal(false);
  // Move focus in on open and hand it back on close, so keyboard users are
  // not stranded; the inspector itself stays non-modal.
  onMount(() => {
    const previous = document.activeElement;
    closeButton?.focus();
    onCleanup(() => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  });

  const position = createMemo(() => props.rows.findIndex((row) => rowKey(row) === rowKey(props.row)));
  const medianCost = createMemo(() =>
    median(props.rows.filter((row) => row.costKnown && row.costApprox > 0).map((row) => row.costApprox)),
  );
  const medianDuration = createMemo(() =>
    median(props.rows.map((row) => row.durationMs ?? 0).filter((duration) => duration > 0)),
  );
  const costRatio = () =>
    props.row.costKnown && props.row.costApprox > 0 && medianCost() > 0 ? props.row.costApprox / medianCost() : null;
  const durationRatio = () =>
    (props.row.durationMs ?? 0) > 0 && medianDuration() > 0 ? (props.row.durationMs ?? 0) / medianDuration() : null;
  const isInNavigation = () => position() >= 0;

  const anatomySegments = () => [
    { label: 'Cache read', value: props.row.tokCr, class: tokenSegmentClasses.cacheRead },
    { label: 'Cache write', value: props.row.tokCw, class: tokenSegmentClasses.cacheWrite },
    { label: 'Input', value: props.row.tokIn, class: tokenSegmentClasses.input },
    { label: 'Output', value: props.row.tokOut, class: tokenSegmentClasses.output },
  ];
  const campaignVisibleKeys = createMemo(
    () => new Set((props.selectedCampaign?.visibleRows ?? []).map((row) => rowKey(row))),
  );
  const hiddenCampaignRows = createMemo(
    () => props.selectedCampaign?.allRows.filter((row) => !campaignVisibleKeys().has(rowKey(row))) ?? [],
  );
  const campaignRowsToShow = createMemo(() => {
    const campaign = props.selectedCampaign;
    if (!campaign) return [];
    return showAllCampaignSessions() ? [...campaign.visibleRows, ...hiddenCampaignRows()] : campaign.visibleRows;
  });

  return (
    <aside class={drawer} role="dialog" aria-label="Session details">
      <div class={drawerTop}>
        <HarnessBadge name={props.row.harness} />
        <div class={drawerNav}>
          <span class={drawerPosition}>
            <Show when={isInNavigation()} fallback="Outside filters">
              {fmtNum(position() + 1)} / {fmtNum(props.rows.length)}
            </Show>
          </span>
          <button
            class={drawerClose}
            type="button"
            aria-label="Previous session (k)"
            title="Previous session (k)"
            disabled={!isInNavigation() || position() <= 0}
            onClick={() => props.onNavigate(-1)}
          >
            ↑
          </button>
          <button
            class={drawerClose}
            type="button"
            aria-label="Next session (j)"
            title="Next session (j)"
            disabled={!isInNavigation() || position() >= props.rows.length - 1}
            onClick={() => props.onNavigate(1)}
          >
            ↓
          </button>
          <button
            ref={closeButton}
            class={drawerClose}
            type="button"
            aria-label="Close session details"
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        </div>
      </div>
      <div class={drawerBody}>
        <div>
          <div class={drawerTitle}>{props.row.sessionLabel}</div>
          <div class={muted}>
            {props.row.providerDisplay} · {props.row.modelLabel}
          </div>
        </div>
        <div>
          <SegmentBar segments={anatomySegments()} ariaLabel="Token anatomy" />
          <div class={drawerLegend} style={{ 'margin-top': '8px' }}>
            <For each={anatomySegments()}>
              {(segment) => (
                <div class={drawerLegendItem} title={`${segment.label}: ${fmtNum(segment.value)} tokens`}>
                  <span class={cx(drawerLegendSwatch, segment.class)} />
                  <span>{segment.label}</span>
                  <span class={drawerLegendValue}>{fmtCompact(segment.value)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={costRatio() != null || durationRatio() != null}>
          <div class={drawerCompare} title="Compared with the median session in the current view">
            <Show when={costRatio() != null}>≈ {fmtRatio(costRatio() ?? 0)} median cost</Show>
            <Show when={costRatio() != null && durationRatio() != null}> · </Show>
            <Show when={durationRatio() != null}>{fmtRatio(durationRatio() ?? 0)} median duration</Show>
          </div>
        </Show>
        <Show when={props.selectedCampaign}>
          {(campaign) => (
            <div class={drawerCompare}>
              <div class={drawerTitle}>Campaign</div>
              <div style={{ 'margin-top': '6px' }}>{fmtCampaignTotals(campaign().visibleTotals)}</div>
              <div class={muted} style={{ 'margin-top': '4px' }}>
                {fmtNum(campaign().visibleCount)} / {fmtNum(campaign().totalCount)} sessions shown
                <Show when={campaign().visibleCount < campaign().totalCount}>
                  {' · '}current filters hide part of this campaign
                </Show>
              </div>
              <div style={{ display: 'grid', gap: '8px', 'margin-top': '10px' }}>
                <For each={campaignRowsToShow()}>
                  {(session) => {
                    const hidden = () => !campaignVisibleKeys().has(rowKey(session));
                    return (
                      <button
                        class={ghostButton}
                        type="button"
                        title={hidden() ? 'Select session hidden by current filters' : 'Select campaign session'}
                        style={{
                          display: 'block',
                          'text-align': 'left',
                          opacity: hidden() ? 0.58 : 1,
                        }}
                        onClick={() => props.onSelectSession(session)}
                      >
                        <div>{session.sessionLabel}</div>
                        <div class={muted}>
                          {campaignSessionSummary(session)}
                          <Show when={hidden()}>{' · '}hidden by current filters</Show>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={hiddenCampaignRows().length > 0}>
                <div class={drawerActions} style={{ 'margin-top': '10px' }}>
                  <button
                    class={ghostButton}
                    type="button"
                    onClick={() => setShowAllCampaignSessions((current) => !current)}
                  >
                    {showAllCampaignSessions() ? 'Show filtered campaign sessions' : 'Show all campaign sessions'}
                  </button>
                  <button class={ghostButton} type="button" onClick={() => props.onClearFilters()}>
                    Clear filters
                  </button>
                </div>
              </Show>
            </div>
          )}
        </Show>
        <div class={drawerGrid}>
          <DetailItem label="Started" value={fmtDate(props.row.date)} />
          <DetailItem label="Ended" value={fmtDate(props.row.endDate)} />
          <DetailItem label="Total tokens" value={fmtNum(props.row.tokenTotal)} />
          <DetailItem label="RTK savings" value={rtkSavedLabel(props.row)} hint={rtkSavedTitle(props.row)} />
          <DetailItem
            label="API value"
            value={props.row.costKnown ? fmtMoney(props.row.costApprox) : '—'}
            hint={props.row.costKnown ? 'Estimated cost at standard API prices' : UNKNOWN_PRICE_HINT}
          />
          <DetailItem
            label="Actual cost"
            value={fmtMoney(props.row.costActual)}
            hint="Out-of-pocket spend — $0.00 means covered by a subscription"
          />
          <DetailItem
            label="Sub value"
            value={fmtMoney(props.row.costQuota)}
            hint="Cursor export value covered by the subscription quota"
          />
          <DetailItem label="Calls" value={fmtNum(props.row.calls)} />
          <DetailItem label="Turns" value={fmtNum(props.row.turns)} />
          <DetailItem label="Tools" value={fmtNum(props.row.tools)} />
          <DetailItem label="Duration" value={fmtDuration(props.row.durationMs)} />
          <DetailItem label="Lines" value={lineDeltaLabel(props.row)} />
          <DetailItem label="Subagent" value={props.row.subagent ? 'Yes' : 'No'} />
          <Show when={props.row.partial}>
            <DetailItem label="Partial" value="Yes" hint="Local history did not cover the whole session" />
          </Show>
          <Show when={props.row.usageUnavailable}>
            <DetailItem
              label="Usage data"
              value="Unavailable"
              hint="Session came from prompt history, but detailed local token counters are missing"
            />
          </Show>
          <Show when={props.row.ambiguous}>
            <DetailItem
              label="Reconciliation"
              value="Ambiguous"
              hint="Multiple local Cursor sessions matched the same export cluster; totals are best-effort"
            />
          </Show>
        </div>
        <div class={drawerActions}>
          <button
            class={ghostButton}
            type="button"
            onClick={() => props.onFieldFilter('project', props.row.projectKey)}
          >
            Filter project: {props.row.projectKey}
          </button>
          <button class={ghostButton} type="button" onClick={() => props.onFieldFilter('model', props.row.modelKey)}>
            Filter model: {props.row.modelKey}
          </button>
        </div>
      </div>
    </aside>
  );
};
