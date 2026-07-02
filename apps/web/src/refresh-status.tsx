import { cx } from '@ai-usage/design-system/css';
import {
  refreshButton,
  refreshIconButton,
  refreshRing,
  refreshRingDelayed,
  refreshRingError,
  refreshRingIdle,
  refreshRingPaused,
  refreshRingRefreshing,
  refreshRingStatic,
  refreshRingSuccess,
  refreshStatus,
  refreshStatusError,
} from '@ai-usage/design-system/report';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { fmtDate } from './shared';

const formatRefreshCountdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
};

const formatRefreshAge = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
};

type RefreshStatusKind = 'idle' | 'refreshing' | 'success' | 'delayed' | 'error' | 'paused' | 'static';

const refreshStatusLabels: Record<RefreshStatusKind, string> = {
  delayed: 'Delayed',
  error: 'Error',
  idle: 'Ready',
  paused: 'Paused',
  refreshing: 'Refreshing',
  static: 'Static',
  success: 'Live',
};

const refreshRingClass: Record<RefreshStatusKind, string> = {
  delayed: refreshRingDelayed,
  error: refreshRingError,
  idle: refreshRingIdle,
  paused: refreshRingPaused,
  refreshing: refreshRingRefreshing,
  static: refreshRingStatic,
  success: refreshRingSuccess,
};

export const RefreshStatus = (props: {
  canRefresh: boolean;
  generatedAt: string;
  lastRefreshError: string | null;
  lastSuccessfulRefreshAt: number | null;
  nextRefreshAt: number | null;
  onTogglePause: () => void;
  refreshErrorCount: number;
  refreshIntervalMs: number;
  refreshPaused: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) => {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  const countdown = createMemo(() => {
    const next = props.nextRefreshAt;
    if (!next) {
      return 'paused';
    }
    return formatRefreshCountdown(next - now());
  });
  const remainingRatio = createMemo(() => {
    if (!props.canRefresh || props.refreshPaused || props.nextRefreshAt == null) {
      return 0;
    }
    if (props.refreshing) {
      return 1;
    }
    return Math.max(0, Math.min(1, (props.nextRefreshAt - now()) / props.refreshIntervalMs));
  });
  const status = createMemo<RefreshStatusKind>(() => {
    if (!props.canRefresh) {
      return 'static';
    }
    if (props.refreshPaused) {
      return 'paused';
    }
    if (props.refreshing) {
      return 'refreshing';
    }
    if (props.refreshErrorCount >= 2) {
      return 'error';
    }
    if (props.refreshErrorCount === 1) {
      return 'delayed';
    }
    return props.lastSuccessfulRefreshAt == null ? 'idle' : 'success';
  });
  const statusLabel = () => refreshStatusLabels[status()];
  const primaryLabel = createMemo(() => {
    const currentStatus = status();
    if (currentStatus === 'static') {
      return 'Static';
    }
    if (currentStatus === 'paused') {
      return 'Paused';
    }
    if (currentStatus === 'refreshing') {
      return 'Refreshing';
    }
    if (currentStatus === 'delayed' || currentStatus === 'error') {
      return `${statusLabel()} · retry ${countdown()}`;
    }
    return `Next ${countdown()}`;
  });
  const tooltipLines = createMemo(() => {
    const lines = [`Status: ${statusLabel()}`, `Generated: ${fmtDate(props.generatedAt)}`];
    if (props.canRefresh) {
      lines.push(`Interval: ${formatRefreshCountdown(props.refreshIntervalMs)}`);
    } else {
      lines.push('Auto-refresh unavailable for static snapshots');
    }
    if (props.canRefresh && !props.refreshPaused) {
      lines.push(`Next refresh: ${countdown()}`);
    }
    if (props.refreshPaused) {
      lines.push('Auto-refresh is paused');
    }
    if (props.lastSuccessfulRefreshAt != null) {
      lines.push(`Last successful refresh: ${formatRefreshAge(now() - props.lastSuccessfulRefreshAt)}`);
    }
    if (props.lastRefreshError) {
      lines.push(`Last error: ${props.lastRefreshError}`);
    }
    return lines;
  });
  const tooltipText = createMemo(() => tooltipLines().join('\n'));

  return (
    <div
      class={cx(refreshStatus, status() === 'delayed' || status() === 'error' ? refreshStatusError : undefined)}
      title={tooltipText()}
    >
      <span
        aria-label={`Data refresh status: ${primaryLabel()}`}
        aria-live="polite"
        class={cx(refreshRing, refreshRingClass[status()])}
        role="status"
        style={{ '--refresh-progress': String(remainingRatio()) }}
      />
      <button
        class={refreshButton}
        disabled={!props.canRefresh || props.refreshing}
        onClick={props.onRefresh}
        type="button"
      >
        Refresh
      </button>
      <button
        aria-label={props.refreshPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        aria-pressed={props.refreshPaused}
        class={refreshIconButton}
        disabled={!props.canRefresh}
        onClick={props.onTogglePause}
        title={props.refreshPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        type="button"
      >
        {props.refreshPaused ? '>' : '||'}
      </button>
    </div>
  );
};
