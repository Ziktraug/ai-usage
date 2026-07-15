import { Drawer } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import { drawer } from '@ai-usage/design-system/report';
import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaRefreshResult } from '@ai-usage/report-data/provider-quota';
import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  buildProviderQuotaHistoryModel,
  type ProviderQuotaHistoryRange,
  type ProviderQuotaHistorySeries,
} from './provider-quota-history-model';
import { fmtDate, fmtPct } from './shared';

const drawerClass = css({ w: { base: '100vw', md: 'min(960px, 94vw)' }, maxW: '100vw' });
const layout = css({ display: 'grid', gap: '18px', p: { base: '16px', md: '24px' }, overflowY: 'auto' });
const header = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '12px' });
const title = css({ m: 0, fontSize: 'xl', color: 'ink' });
const controls = css({ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'end' });
const rangeControls = css({ display: 'flex', gap: '8px', flexWrap: 'wrap', border: 0, p: 0, m: 0 });
const control = css({ display: 'grid', gap: '4px', color: 'muted', fontSize: '12px' });
const button = css({
  px: '12px',
  py: '7px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
const selectedButton = css({ bg: 'accentSoft', color: 'accent', borderColor: 'accent' });
const banner = css({ p: '10px 12px', borderRadius: 'md', bg: 'accentSoft', color: 'ink', fontSize: '13px' });
const cards = css({ display: 'grid', gap: '14px' });
const card = css({
  display: 'grid',
  gap: '10px',
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
const cardTop = css({ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' });
const meta = css({ color: 'muted', fontSize: '12px' });
const chart = css({ w: 'full', h: '180px', bg: 'surface', border: '1px solid token(colors.line)', borderRadius: 'sm' });
const tableWrap = css({ overflowX: 'auto' });
const table = css({
  w: 'full',
  fontSize: '12px',
  borderCollapse: 'collapse',
  '& th, & td': { p: '6px 8px', textAlign: 'left', borderBottom: '1px solid token(colors.line)' },
});

const seriesPath = (series: ProviderQuotaHistorySeries, segmentIndex: number): string => {
  const segment = series.segments[segmentIndex];
  if (!segment?.points.length) {
    return '';
  }
  const firstTime = Date.parse(series.firstObservedAt);
  const lastTime = Date.parse(series.lastObservedAt);
  const duration = Math.max(1, lastTime - firstTime);
  return segment.points
    .map((point, index) => {
      const x = 20 + ((Date.parse(point.firstObservedAt) - firstTime) / duration) * 560;
      const y = 150 - ((point.usedPercent ?? 0) / 100) * 120;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
};

const largestGapLabel = (milliseconds: number): string => {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
};

const SeriesCard = (props: { series: ProviderQuotaHistorySeries }) => (
  <article class={card}>
    <div class={cardTop}>
      <div>
        <strong>{props.series.label}</strong>
        <div class={meta}>
          {props.series.providerLabel} · {props.series.machineLabel ?? props.series.machineId}
        </div>
      </div>
      <strong>{props.series.currentPercent === null ? 'Unknown' : fmtPct(props.series.currentPercent)}</strong>
    </div>
    <div class={meta}>
      {props.series.summary} · largest gap {largestGapLabel(props.series.largestGapMs)} · {props.series.sourceKey} (
      {props.series.sourceConfidence})
    </div>
    <svg aria-hidden="true" class={chart} preserveAspectRatio="none" viewBox="0 0 600 180">
      <title>{props.series.label} quota observation chart</title>
      <path d="M 20 30 H 580 M 20 90 H 580 M 20 150 H 580" fill="none" stroke="currentColor" stroke-opacity="0.12" />
      <For each={props.series.segments}>
        {(_segment, index) => (
          <path d={seriesPath(props.series, index())} fill="none" stroke="currentColor" stroke-width="3" />
        )}
      </For>
      <For each={props.series.points}>
        {(point) => {
          const duration = Math.max(
            1,
            Date.parse(props.series.lastObservedAt) - Date.parse(props.series.firstObservedAt),
          );
          const x =
            20 + ((Date.parse(point.firstObservedAt) - Date.parse(props.series.firstObservedAt)) / duration) * 560;
          const y = 150 - ((point.usedPercent ?? 0) / 100) * 120;
          return <circle cx={x} cy={y} fill="currentColor" r="3" />;
        }}
      </For>
      <For each={props.series.segments.filter(({ breakReason }) => breakReason !== null)}>
        {(segment) => {
          const point = segment.points[0];
          if (!point) {
            return null;
          }
          const duration = Math.max(
            1,
            Date.parse(props.series.lastObservedAt) - Date.parse(props.series.firstObservedAt),
          );
          const x =
            20 + ((Date.parse(point.firstObservedAt) - Date.parse(props.series.firstObservedAt)) / duration) * 560;
          return (
            <>
              <line stroke="currentColor" stroke-dasharray="5 4" x1={x} x2={x} y1="22" y2="158" />
              <text font-size="11" x={x + 4} y="18">
                {segment.breakReason}
              </text>
            </>
          );
        }}
      </For>
    </svg>
    <div class={meta}>
      First {fmtDate(props.series.firstObservedAt)} · Last {fmtDate(props.series.lastObservedAt)} · Next reset{' '}
      {props.series.nextResetAt ? fmtDate(props.series.nextResetAt) : 'unknown'}
    </div>
    <div class={tableWrap}>
      <table class={table}>
        <caption class="sr-only">{props.series.label} quota observations</caption>
        <thead>
          <tr>
            <th>Observed</th>
            <th>Used</th>
            <th>Reset</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.series.points}>
            {(point) => (
              <tr>
                <td>{fmtDate(point.firstObservedAt)}</td>
                <td>{point.usedPercent === null ? 'Unknown' : fmtPct(point.usedPercent)}</td>
                <td>{point.resetAt ? fmtDate(point.resetAt) : 'Unknown'}</td>
                <td>
                  {point.source.key} ({point.source.confidence})
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </article>
);

export const ProviderQuotaHistoryPanel = (props: {
  error?: string | null;
  loading: boolean;
  onClose(): void;
  onRangeChange(range: ProviderQuotaHistoryRange): void;
  range: ProviderQuotaHistoryRange;
  refresh?: ProviderQuotaRefreshResult | null;
  result: ProviderQuotaHistoryResult | null;
}) => {
  let closeButton: HTMLButtonElement | undefined;
  const previousFocus = typeof document === 'undefined' ? null : document.activeElement;
  const model = createMemo(() => (props.result ? buildProviderQuotaHistoryModel(props.result) : null));
  const providers = createMemo(() => [...new Set(model()?.series.map(({ providerKey }) => providerKey) ?? [])]);
  const machines = createMemo(() => [...new Set(model()?.series.map(({ machineId }) => machineId) ?? [])]);
  const accounts = createMemo(() => [
    ...new Set(model()?.series.map(({ accountScope }) => accountScope ?? 'unknown') ?? []),
  ]);
  const [provider, setProvider] = createSignal('');
  const [machine, setMachine] = createSignal('');
  const [account, setAccount] = createSignal('');
  const visibleSeries = createMemo(
    () =>
      model()?.series.filter(
        (series) =>
          (!provider() || series.providerKey === provider()) &&
          (!machine() || series.machineId === machine()) &&
          (!account() || (series.accountScope ?? 'unknown') === account()),
      ) ?? [],
  );
  const refreshBanner = () => {
    if (props.error) {
      return props.error;
    }
    if (props.refresh?.live === 'unsupported') {
      return 'Codex CLI unavailable. Showing stored history.';
    }
    if (props.refresh?.live === 'auth-required') {
      return 'Codex authentication required. Showing stored history.';
    }
    if (props.refresh?.backfill === 'advanced') {
      return 'Historical backfill is still progressing.';
    }
    return null;
  };

  return (
    <Drawer
      contentAriaLabel="Codex quota history"
      contentClass={cx(drawer, drawerClass)}
      finalFocusEl={() => (previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : null)}
      initialFocusEl={() => closeButton ?? null}
      modal
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      open
      trapFocus
    >
      <div class={layout}>
        <div class={header}>
          <div>
            <h2 class={title}>Codex quota history</h2>
            <div class={meta}>Provider-defined quota observations retained on this machine.</div>
          </div>
          <button
            aria-label="Close Codex quota history"
            class={button}
            onClick={props.onClose}
            ref={(element) => {
              closeButton = element;
            }}
            type="button"
          >
            ✕
          </button>
        </div>
        <Show when={refreshBanner()}>
          {(message) => (
            <div class={banner} role="status">
              {message()}
            </div>
          )}
        </Show>
        <div class={controls}>
          <fieldset class={rangeControls}>
            <legend>History range</legend>
            <For each={['24h', '7d', '30d'] as const}>
              {(range) => (
                <button
                  aria-pressed={props.range === range}
                  class={`${button} ${props.range === range ? selectedButton : ''}`}
                  onClick={() => props.onRangeChange(range)}
                  type="button"
                >
                  {range}
                </button>
              )}
            </For>
          </fieldset>
          <label class={control}>
            Provider
            <select onChange={(event) => setProvider(event.currentTarget.value)} value={provider()}>
              <option value="">All</option>
              <For each={providers()}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
          <label class={control}>
            Machine
            <select onChange={(event) => setMachine(event.currentTarget.value)} value={machine()}>
              <option value="">All</option>
              <For each={machines()}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
          <label class={control}>
            Account scope
            <select onChange={(event) => setAccount(event.currentTarget.value)} value={account()}>
              <option value="">All</option>
              <For each={accounts()}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
        </div>
        <Show when={props.loading}>
          <div role="status">Loading quota history…</div>
        </Show>
        <Show when={!props.loading && model()?.emptyMessage}>{(message) => <div>{message()}</div>}</Show>
        <Show when={model()?.partial}>
          <div class={banner}>History is partial or contains skipped corrupt observations.</div>
        </Show>
        <div class={cards}>
          <For each={visibleSeries()}>{(series) => <SeriesCard series={series} />}</For>
        </div>
      </div>
    </Drawer>
  );
};
