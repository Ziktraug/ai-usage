import { css, cx } from '@ai-usage/design-system/css';
import { ghostButton, statusPill } from '@ai-usage/design-system/report';
import { Link } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { useSourceControl } from '../source-control-context';
import { presentSourceState, sourceToneClass } from '../source-control-presentation';

const summary = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  ml: { base: '0', md: 'auto' },
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
  _focus: {
    '& [data-source-card]': { display: 'grid' },
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
  _hover: {
    '& [data-source-card]': { display: 'grid' },
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

export const SourceControlSummary = () => {
  const sourceControl = useSourceControl();
  const snapshot = () => sourceControl.state().snapshot;
  const enabledSources = createMemo(() => snapshot()?.sources.filter((source) => source.policy === 'enabled') ?? []);
  const warningCount = createMemo(
    () => enabledSources().filter((source) => ['danger', 'warning'].includes(presentSourceState(source).tone)).length,
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
  const runningSources = createMemo(
    () =>
      snapshot()?.sources.filter((source) => source.lifecycle === 'running' || source.lifecycle === 'pausing') ?? [],
  );
  const queuedSources = createMemo(() => snapshot()?.sources.filter((source) => source.lifecycle === 'queued') ?? []);
  const nextDueSource = createMemo(
    () =>
      snapshot()
        ?.sources.filter((source) => source.nextDueAt !== undefined)
        .toSorted((left, right) => String(left.nextDueAt).localeCompare(String(right.nextDueAt)))[0],
  );
  const [hasFocus, setHasFocus] = createSignal(false);
  const [isHovered, setIsHovered] = createSignal(false);
  const isSummaryVisible = () => hasFocus() || isHovered();
  const [clock, setClock] = createSignal(Date.now());
  createEffect(() => {
    if (!isSummaryVisible() || runningSources().length === 0) {
      return;
    }
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = (startedAt: string | undefined): string => {
    if (!startedAt) {
      return 'elapsed time unavailable';
    }
    const milliseconds = Math.max(0, clock() - Date.parse(startedAt));
    return `${Math.round(milliseconds / 1000)}s elapsed`;
  };

  return (
    <section aria-label="Collection source status" class={summary}>
      <Link
        class={summaryLink}
        onBlur={() => setHasFocus(false)}
        onFocus={() => setHasFocus(true)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        to="/sources"
      >
        <span
          aria-hidden="true"
          class={cx(
            summaryDot,
            statusTone() === 'warning' ? summaryDotWarn : undefined,
            statusTone() === 'danger' ? summaryDotDanger : undefined,
          )}
        />
        {statusLabel()}
        <div class={card} data-source-card="">
          <div class={cardHeader}>
            <span class={cardTitle}>Collection sources</span>
            <span class={cx(statusPill, sourceToneClass(statusTone()))}>{statusLabel()}</span>
          </div>
          <Show fallback={<p class={cardMeta}>Waiting for the server-owned source snapshot.</p>} when={snapshot()}>
            <div class={sourceList}>
              <For each={enabledSources()}>
                {(source) => {
                  const presentation = () => presentSourceState(source);
                  return (
                    <div class={sourceRow}>
                      <span class={sourceLabel} title={`${source.label}: ${presentation().explanation}`}>
                        {source.label}
                      </span>
                      <span class={cx(statusPill, sourceToneClass(presentation().tone))}>{presentation().label}</span>
                    </div>
                  );
                }}
              </For>
            </div>
            <Show when={runningSources().length > 0}>
              <p class={cardMeta}>
                Running:{' '}
                {runningSources()
                  .map((source) => `${source.label} (${elapsed(source.lastStartedAt)})`)
                  .join(', ')}
              </p>
            </Show>
            <Show when={queuedSources().length > 0}>
              <p class={cardMeta}>
                Queued:{' '}
                {queuedSources()
                  .map((source) => source.label)
                  .join(', ')}
              </p>
            </Show>
            <Show when={nextDueSource()}>
              {(source) => (
                <p class={cardMeta}>
                  Next due: {source().label} at {source().nextDueAt}
                </p>
              )}
            </Show>
            <p class={cardMeta}>
              Last success:{' '}
              {enabledSources()
                .flatMap((source) => (source.lastSuccessAt ? [source.lastSuccessAt] : []))
                .toSorted()
                .at(-1) ?? 'none yet'}
            </p>
          </Show>
        </div>
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
    </section>
  );
};
