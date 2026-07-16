import { css, cx } from '@ai-usage/design-system/css';
import {
  ghostButton,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
} from '@ai-usage/design-system/report';
import { Link } from '@tanstack/solid-router';
import { createMemo, For, Show } from 'solid-js';
import { useSourceControl } from '../source-control-context';

const summary = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  ml: { base: '0', md: 'auto' },
  _focusWithin: {
    '& [data-source-card]': { display: 'grid' },
  },
  _hover: {
    '& [data-source-card]': { display: 'grid' },
  },
});

const summaryLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  h: '36px',
  px: '10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '12px',
  fontWeight: 650,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const summaryDot = css({
  w: '8px',
  h: '8px',
  borderRadius: 'full',
  bg: 'status.ok',
});

const summaryDotWarn = css({ bg: 'status.warn' });
const summaryDotDanger = css({ bg: 'status.danger' });

const card = css({
  display: 'none',
  position: 'absolute',
  zIndex: 40,
  top: 'calc(100% + 8px)',
  right: '0',
  width: 'min(360px, calc(100vw - 40px))',
  gap: '10px',
  p: '12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'lg',
});

const cardHeader = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  alignItems: 'center',
});

const cardTitle = css({ fontSize: '13px', fontWeight: 700 });
const cardMeta = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });
const sourceList = css({ display: 'grid', gap: '6px' });
const sourceRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
  minW: 0,
});
const sourceLabel = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' });

const summaryToneClass = (tone: 'danger' | 'ok' | 'warning'): string => {
  if (tone === 'ok') {
    return statusPillOk;
  }
  if (tone === 'danger') {
    return statusPillDanger;
  }
  return statusPillWarn;
};

const sourceToneClass = (source: { availability: string; lastOutcome: string; lifecycle: string }): string => {
  if (source.lifecycle === 'running') {
    return statusPillOk;
  }
  if (source.lastOutcome === 'failed' || source.availability !== 'detected') {
    return statusPillDanger;
  }
  if (source.lastOutcome === 'warning') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

export const SourceControlSummary = () => {
  const sourceControl = useSourceControl();
  const snapshot = () => sourceControl.state().snapshot;
  const enabledSources = createMemo(() => snapshot()?.sources.filter((source) => source.policy === 'enabled') ?? []);
  const warningCount = createMemo(
    () =>
      enabledSources().filter(
        (source) =>
          source.lastOutcome === 'failed' || source.lastOutcome === 'warning' || source.availability !== 'detected',
      ).length,
  );
  const statusLabel = createMemo(() => {
    const state = sourceControl.state();
    if (!state.snapshot) {
      return state.connection === 'connecting' ? 'Connecting' : 'Unavailable';
    }
    if (state.connection === 'stale') {
      return 'Reconnecting';
    }
    if (warningCount() > 0) {
      return `${warningCount()} warning${warningCount() === 1 ? '' : 's'}`;
    }
    if (state.snapshot.runningCount > 0) {
      return `${state.snapshot.runningCount} running`;
    }
    return 'Sources ready';
  });
  const statusTone = createMemo(() => {
    const state = sourceControl.state();
    if (!state.snapshot || state.connection === 'stale') {
      return 'warning';
    }
    return warningCount() > 0 ? 'danger' : 'ok';
  });
  const runPending = () => sourceControl.state().pendingCommand !== null;

  return (
    <section aria-label="Collection source status" class={summary}>
      <Link class={summaryLink} to="/sources">
        <span
          aria-hidden="true"
          class={cx(
            summaryDot,
            statusTone() === 'warning' ? summaryDotWarn : undefined,
            statusTone() === 'danger' ? summaryDotDanger : undefined,
          )}
        />
        {statusLabel()}
      </Link>
      <button
        aria-busy={runPending() ? 'true' : undefined}
        class={ghostButton}
        disabled={!snapshot() || runPending()}
        onClick={() => {
          sourceControl.execute({ command: 'run-all' }).catch(() => undefined);
        }}
        type="button"
      >
        Run all
      </button>
      <div class={card} data-source-card="">
        <div class={cardHeader}>
          <span class={cardTitle}>Collection sources</span>
          <span class={cx(statusPill, summaryToneClass(statusTone()))}>{statusLabel()}</span>
        </div>
        <Show fallback={<p class={cardMeta}>Waiting for the server-owned source snapshot.</p>} when={snapshot()}>
          <div class={sourceList}>
            <For each={enabledSources()}>
              {(source) => (
                <div class={sourceRow}>
                  <span class={sourceLabel} title={source.label}>
                    {source.label}
                  </span>
                  <span class={cx(statusPill, sourceToneClass(source))}>
                    {source.lifecycle === 'running' ? 'running' : source.lastOutcome}
                  </span>
                </div>
              )}
            </For>
          </div>
          <p class={cardMeta}>Open Sources for availability, policy, scheduling, progress, and history.</p>
        </Show>
      </div>
    </section>
  );
};
