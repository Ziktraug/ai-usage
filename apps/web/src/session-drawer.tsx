import { Drawer } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
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
import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { CampaignTotals, CampaignView } from './dashboard-model';
import type { FieldFilterKey } from './dashboard-search';
import { lineDeltaLabel, rtkSavedLabel, rtkSavedTitle } from './dashboard-sort';
import { SessionAnalysis } from './session-analysis';
import { classifySessionAnalysisError, type SessionAnalysisError } from './session-analysis-error';
import { sessionDurationSemantics } from './session-analysis-model';
import type { SessionAnalysisTarget } from './session-analysis-target';
import { canAnalyzeSession, loadSessionDetail } from './session-detail-client';
import {
  apiValuePresentation,
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
} from './shared';

const DetailItem = (props: { label: string; value: string; hint?: string }) => (
  <div class={detailItem} title={props.hint}>
    <div class={detailLabel}>{props.label}</div>
    <div class={detailValue}>{props.value}</div>
  </div>
);

const analysisDrawer = css({ w: { base: '100vw', md: 'min(960px, 94vw)' } });
const SESSION_ANALYSIS_PANEL_ID = 'session-analysis-panel';

const fmtRatio = (ratio: number) => (ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`);

const fmtCampaignTotals = (totals: CampaignTotals) => {
  const apiValue = apiValuePresentation({ costApprox: totals.totalCost, costKnown: totals.costKnown });
  return [
    `${apiValue.label} API`,
    `${fmtCompact(totals.freshTokens)} fresh tokens`,
    `${fmtNum(totals.turns)} turns`,
    `${fmtNum(totals.tools)} tools`,
  ].join(' · ');
};

const campaignSessionSummary = (row: DashboardRow) => {
  const apiValue = apiValuePresentation(row);
  return [
    `${apiValue.label} API`,
    `${fmtCompact(row.freshTokens)} fresh`,
    `${fmtNum(row.turns)} turns`,
    `${fmtNum(row.tools)} tools`,
  ].join(' · ');
};

export const SessionDrawer = (props: {
  onClose: () => void;
  onClearFilters: () => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onNavigate: (delta: number) => void;
  onSelectSession: (row: DashboardRow) => void;
  navigation?: {
    loading: boolean;
    next: DashboardRow | null;
    previous: DashboardRow | null;
    total: number;
  };
  revision: string | null;
  row: DashboardRow;
  rows: DashboardRow[];
  selectedCampaign?: CampaignView | null;
  target: SessionAnalysisTarget;
}) => {
  let closeButton: HTMLButtonElement | undefined;
  const previousFocus = typeof document === 'undefined' ? null : document.activeElement;
  const [showAllCampaignSessions, setShowAllCampaignSessions] = createSignal(false);
  const [analysisOpen, setAnalysisOpen] = createSignal(false);
  const [analysisLoading, setAnalysisLoading] = createSignal(false);
  const [analysisResponse, setAnalysisResponse] = createSignal<SessionDetailResponse | null>(null);
  const [analysisError, setAnalysisError] = createSignal<SessionAnalysisError | null>(null);
  let analysisPanel: HTMLDivElement | undefined;
  let analysisSequence = 0;

  createEffect(() => {
    rowKey(props.row);
    analysisSequence += 1;
    setAnalysisOpen(false);
    setAnalysisLoading(false);
    setAnalysisResponse(null);
    setAnalysisError(null);
  });

  onCleanup(() => {
    analysisSequence += 1;
  });

  const loadAnalysis = async (): Promise<void> => {
    const sequence = ++analysisSequence;
    setAnalysisLoading(true);
    setAnalysisResponse(null);
    setAnalysisError(null);
    try {
      const revision = props.revision;
      if (!revision) {
        throw new Error('A served report revision is required for session analysis.');
      }
      const response = await loadSessionDetail({ revision, rowId: props.target.reportRowId });
      if (sequence === analysisSequence) {
        setAnalysisResponse(response);
      }
    } catch (error) {
      if (sequence === analysisSequence) {
        setAnalysisError(classifySessionAnalysisError(error));
      }
    } finally {
      if (sequence === analysisSequence) {
        setAnalysisLoading(false);
      }
    }
  };

  const toggleAnalysis = async (): Promise<void> => {
    if (analysisOpen()) {
      analysisSequence += 1;
      setAnalysisOpen(false);
      setAnalysisLoading(false);
      setAnalysisResponse(null);
      setAnalysisError(null);
      return;
    }
    setAnalysisOpen(true);
    const requestSequence = analysisSequence + 1;
    await loadAnalysis();
    if (analysisOpen() && requestSequence === analysisSequence) {
      analysisPanel?.scrollIntoView({ block: 'nearest' });
    }
  };

  const analysisButtonLabel = (): string => {
    if (analysisOpen()) {
      return 'Hide analysis';
    }
    return props.target.kind === 'session' ? 'Analyze' : 'Analyze root';
  };

  const analysisButtonAriaLabel = (): string => {
    if (analysisOpen()) {
      return 'Hide session chronology';
    }
    return props.target.kind === 'session' ? 'Analyze session chronology' : 'Analyze root session chronology';
  };

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
  const apiValue = () => apiValuePresentation(props.row);
  const durationSemantics = () =>
    sessionDurationSemantics(props.row.source?.harnessKey, props.target.kind === 'campaign-root');
  const isInNavigation = () => position() >= 0;
  const previousAvailable = () =>
    props.navigation ? props.navigation.previous !== null : isInNavigation() && position() > 0;
  const nextAvailable = () =>
    props.navigation ? props.navigation.next !== null : isInNavigation() && position() < props.rows.length - 1;

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
    if (!campaign) {
      return [];
    }
    return showAllCampaignSessions() ? [...campaign.visibleRows, ...hiddenCampaignRows()] : campaign.visibleRows;
  });

  return (
    <Drawer
      closeOnInteractOutside
      contentAriaLabel="Session details"
      contentClass={analysisOpen() ? cx(drawer, analysisDrawer) : drawer}
      finalFocusEl={() => (previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : null)}
      initialFocusEl={() => closeButton ?? null}
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      open
      trapFocus={false}
    >
      <div class={drawerTop}>
        <HarnessBadge name={props.row.harness} />
        <div class={drawerNav}>
          <span class={drawerPosition}>
            <Show fallback="Outside filters" when={props.navigation || isInNavigation()}>
              {props.navigation
                ? `${fmtNum(props.navigation.total)} matching sessions`
                : `${fmtNum(position() + 1)} / ${fmtNum(props.rows.length)}`}
            </Show>
          </span>
          <button
            aria-label="Previous session (k)"
            class={drawerClose}
            disabled={props.navigation?.loading || !previousAvailable()}
            onClick={() => props.onNavigate(-1)}
            title="Previous session (k)"
            type="button"
          >
            ↑
          </button>
          <button
            aria-label="Next session (j)"
            class={drawerClose}
            disabled={props.navigation?.loading || !nextAvailable()}
            onClick={() => props.onNavigate(1)}
            title="Next session (j)"
            type="button"
          >
            ↓
          </button>
          <Show when={canAnalyzeSession({ revision: props.revision, rowId: props.target.reportRowId })}>
            <button
              aria-controls={SESSION_ANALYSIS_PANEL_ID}
              aria-expanded={analysisOpen()}
              aria-label={analysisButtonAriaLabel()}
              class={ghostButton}
              onClick={() => toggleAnalysis()}
              type="button"
            >
              {analysisButtonLabel()}
            </button>
          </Show>
          <button
            aria-label="Close session details"
            class={drawerClose}
            onClick={() => props.onClose()}
            ref={(element) => {
              closeButton = element;
            }}
            type="button"
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
          <SegmentBar ariaLabel="Token anatomy" segments={anatomySegments()} />
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
                        onClick={() => props.onSelectSession(session)}
                        style={{
                          display: 'block',
                          'text-align': 'left',
                          opacity: hidden() ? 0.58 : 1,
                        }}
                        title={hidden() ? 'Select session hidden by current filters' : 'Select campaign session'}
                        type="button"
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
                    onClick={() => setShowAllCampaignSessions((current) => !current)}
                    type="button"
                  >
                    {showAllCampaignSessions() ? 'Show filtered campaign sessions' : 'Show all campaign sessions'}
                  </button>
                  <button class={ghostButton} onClick={() => props.onClearFilters()} type="button">
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
          <DetailItem hint={rtkSavedTitle(props.row)} label="RTK savings" value={rtkSavedLabel(props.row)} />
          <DetailItem hint={apiValue().title} label="API value" value={apiValue().label} />
          <DetailItem
            hint="Out-of-pocket spend — $0.00 means covered by a subscription"
            label="Actual cost"
            value={fmtMoney(props.row.costActual)}
          />
          <DetailItem
            hint="Cursor export value covered by the subscription quota"
            label="Sub value"
            value={fmtMoney(props.row.costQuota)}
          />
          <DetailItem label="Calls" value={fmtNum(props.row.calls)} />
          <DetailItem label="Turns" value={fmtNum(props.row.turns)} />
          <DetailItem label="Tools" value={fmtNum(props.row.tools)} />
          <DetailItem
            hint={durationSemantics().metricHint}
            label={durationSemantics().metricLabel}
            value={fmtDuration(props.row.durationMs)}
          />
          <DetailItem label="Lines" value={lineDeltaLabel(props.row)} />
          <DetailItem label="Subagent" value={props.row.subagent ? 'Yes' : 'No'} />
          <Show when={props.row.partial}>
            <DetailItem hint="Local history did not cover the whole session" label="Partial" value="Yes" />
          </Show>
          <Show when={props.row.usageUnavailable}>
            <DetailItem
              hint="Session came from prompt history, but detailed local token counters are missing"
              label="Usage data"
              value="Unavailable"
            />
          </Show>
          <Show when={props.row.ambiguous}>
            <DetailItem
              hint="Multiple local Cursor sessions matched the same export cluster; totals are best-effort"
              label="Reconciliation"
              value="Ambiguous"
            />
          </Show>
        </div>
        <div class={drawerActions}>
          <button
            class={ghostButton}
            onClick={() => props.onFieldFilter('project', props.row.projectKey)}
            type="button"
          >
            Filter project: {props.row.projectKey}
          </button>
          <button class={ghostButton} onClick={() => props.onFieldFilter('model', props.row.modelKey)} type="button">
            Filter model: {props.row.modelKey}
          </button>
        </div>
        <Show when={analysisOpen()}>
          <div
            id={SESSION_ANALYSIS_PANEL_ID}
            ref={(element) => {
              analysisPanel = element;
            }}
          >
            <SessionAnalysis
              error={analysisError()}
              harnessKey={props.row.source?.harnessKey ?? ''}
              loading={analysisLoading()}
              onRetry={loadAnalysis}
              response={analysisResponse()}
              target={props.target}
            />
          </div>
        </Show>
      </div>
    </Drawer>
  );
};
