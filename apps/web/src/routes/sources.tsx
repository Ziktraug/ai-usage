import { css, cx } from '@ai-usage/design-system/css';
import {
  banner,
  bannerError,
  commandButton,
  ghostButton,
  header,
  headerActions,
  headerTop,
  meta,
  navButton,
  page,
  panel,
  shell,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import {
  type CollectionSourceGroup,
  collectionSourceDefinitions,
  type SourceControlEntryView,
} from '@ai-usage/report-core/source-control';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createMemo, For, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import { fmtDate, fmtNum } from '../shared';
import { useSourceControl } from '../source-control-context';

export const Route = createFileRoute('/sources')({
  component: SourcesRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');
const pageStack = css({ display: 'grid', gap: '18px' });
const headerWrap = css({ flexWrap: 'wrap' });
const actionsWrap = css({ flexWrap: 'wrap', justifyContent: 'flex-end' });
const groupStack = css({ display: 'grid', gap: '10px' });
const groupHeader = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: '12px',
});
const groupTitle = css({ fontSize: '16px', fontWeight: 700 });
const sourceGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
  gap: '12px',
});
const sourceCard = css({ display: 'grid', gap: '14px', minW: 0 });
const sourceHeader = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '12px',
  alignItems: 'start',
});
const sourceName = css({ fontSize: '14px', fontWeight: 700, overflowWrap: 'anywhere' });
const sourceId = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
const sourceBadges = css({ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' });
const axes = css({
  display: 'grid',
  gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
  gap: '8px',
});
const axis = css({ display: 'grid', gap: '3px', minW: 0 });
const axisLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
const axisValue = css({ fontSize: '12px', overflowWrap: 'anywhere' });
const detailList = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '12px', lineHeight: 1.5 });
const cardActions = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
const switchLabel = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  fontSize: '12px',
  fontWeight: 650,
});
const progressStack = css({ display: 'grid', gap: '5px' });
const progressBar = css({ width: '100%', accentColor: 'accent' });

const groupLabels: Record<CollectionSourceGroup, string> = {
  enrichments: 'Enrichments',
  'provider-usage': 'Provider usage',
  sessions: 'Sessions',
};

const toneForSource = (source: SourceControlEntryView) => {
  if (source.lifecycle === 'running') {
    return statusPillOk;
  }
  if (source.lastOutcome === 'failed' || source.availability === 'misconfigured') {
    return statusPillDanger;
  }
  if (source.lastOutcome === 'warning' || source.availability === 'not-detected') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

const progressValue = (source: SourceControlEntryView): number | undefined => {
  const { completed, total } = source.progress ?? {};
  if (completed === undefined || total === undefined || total <= 0) {
    return;
  }
  return Math.min(completed, total);
};

const SourceCard = (props: {
  pending: boolean;
  source: SourceControlEntryView;
  execute: ReturnType<typeof useSourceControl>['execute'];
}) => {
  const canRun = () =>
    props.source.policy === 'enabled' &&
    props.source.availability === 'detected' &&
    !['queued', 'running', 'pausing'].includes(props.source.lifecycle);
  const progress = () => progressValue(props.source);

  return (
    <article class={cx(panel, sourceCard)}>
      <div class={sourceHeader}>
        <div>
          <h3 class={sourceName}>{props.source.label}</h3>
          <p class={sourceId}>{props.source.id}</p>
        </div>
        <div class={sourceBadges}>
          <span class={cx(statusPill, toneForSource(props.source))}>{props.source.lifecycle}</span>
          <span class={cx(statusPill, props.source.policy === 'enabled' ? statusPillOk : statusPillInfo)}>
            {props.source.policy}
          </span>
        </div>
      </div>
      <div class={axes}>
        <div class={axis}>
          <span class={axisLabel}>Availability</span>
          <span class={axisValue}>{props.source.availability}</span>
        </div>
        <div class={axis}>
          <span class={axisLabel}>Last outcome</span>
          <span class={axisValue}>{props.source.lastOutcome}</span>
        </div>
        <div class={axis}>
          <span class={axisLabel}>Last success</span>
          <span class={axisValue}>{fmtDate(props.source.lastSuccessAt ?? null)}</span>
        </div>
        <div class={axis}>
          <span class={axisLabel}>Next due</span>
          <span class={axisValue}>{fmtDate(props.source.nextDueAt ?? null)}</span>
        </div>
      </div>
      <Show when={props.source.progress}>
        {(sourceProgress) => (
          <div class={progressStack}>
            <span class={meta}>
              {sourceProgress().phase}
              {sourceProgress().message ? ` · ${sourceProgress().message}` : ''}
            </span>
            <progress
              aria-label={`${props.source.label} progress`}
              class={progressBar}
              max={sourceProgress().total ?? 1}
              value={progress()}
            />
          </div>
        )}
      </Show>
      <div class={detailList}>
        <Show when={props.source.reason.code !== 'none'}>
          <p>Reason: {props.source.reason.message ?? props.source.reason.code}</p>
        </Show>
        <Show when={props.source.inputCount !== undefined || props.source.outputCount !== undefined}>
          <p>
            Last run: {fmtNum(props.source.inputCount ?? 0)} inputs · {fmtNum(props.source.outputCount ?? 0)} outputs
          </p>
        </Show>
        <For each={props.source.warnings}>{(warning) => <p>Warning: {warning.message ?? warning.code}</p>}</For>
      </div>
      <div class={cardActions}>
        <label class={switchLabel}>
          <input
            checked={props.source.policy === 'enabled'}
            disabled={props.pending}
            onChange={(event) => {
              props
                .execute({
                  command: 'set-enabled',
                  enabled: event.currentTarget.checked,
                  sourceId: props.source.id,
                })
                .catch(() => undefined);
            }}
            type="checkbox"
          />
          Enabled
        </label>
        <button
          aria-busy={props.pending ? 'true' : undefined}
          class={ghostButton}
          disabled={props.pending || !canRun()}
          onClick={() => {
            props.execute({ command: 'run-now', sourceId: props.source.id }).catch(() => undefined);
          }}
          type="button"
        >
          Run now
        </button>
      </div>
    </article>
  );
};

function SourcesRoute() {
  const sourceControl = useSourceControl();
  const snapshot = () => sourceControl.state().snapshot;
  const pending = () => sourceControl.state().pendingCommand !== null;
  const sourceById = createMemo(() => new Map(snapshot()?.sources.map((source) => [source.id, source] as const) ?? []));
  const groups = [
    { id: 'sessions', sources: collectionSourceDefinitions.filter((source) => source.group === 'sessions') },
    {
      id: 'provider-usage',
      sources: collectionSourceDefinitions.filter((source) => source.group === 'provider-usage'),
    },
    { id: 'enrichments', sources: collectionSourceDefinitions.filter((source) => source.group === 'enrichments') },
  ] as const;

  return (
    <main class={page} data-hydrated={sourceControl.state().connection === 'stopped' ? 'false' : 'true'}>
      <div class={shell}>
        <header class={header}>
          <div class={cx(headerTop, headerWrap)}>
            <div class={titleBlock}>
              <p class={meta}>Server-owned collection</p>
              <h1 class={title}>Sources</h1>
              <p class={meta}>Policy, availability, lifecycle, and outcomes stay independent for every collector.</p>
            </div>
            <div class={cx(headerActions, actionsWrap)}>
              <button
                class={ghostButton}
                disabled={!snapshot() || pending()}
                onClick={() => {
                  sourceControl.execute({ command: 'detect-all' }).catch(() => undefined);
                }}
                type="button"
              >
                Detect all
              </button>
              <button
                class={commandButton}
                disabled={!snapshot() || pending()}
                onClick={() => {
                  sourceControl.execute({ command: 'run-all' }).catch(() => undefined);
                }}
                type="button"
              >
                Run all enabled
              </button>
              <Link class={navButton} search={dashboardSearchDefaults} to="/">
                Report
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <div aria-live="polite" class={pageStack}>
          <Show when={sourceControl.state().connection === 'stale'}>
            <div class={banner}>Connection interrupted. Showing the last server snapshot while reconnecting.</div>
          </Show>
          <Show when={sourceControl.state().commandError}>
            {(message) => <div class={cx(banner, bannerError)}>{message()}</div>}
          </Show>
          <Show fallback={<div class={panel}>Connecting to the source control plane…</div>} when={snapshot()}>
            {(current) => (
              <>
                <p class={meta}>
                  {current().runningCount} running · {current().queueDepth} queued · snapshot{' '}
                  {fmtDate(current().generatedAt)}
                </p>
                <For each={groups}>
                  {(group) => (
                    <section aria-labelledby={`source-group-${group.id}`} class={groupStack}>
                      <div class={groupHeader}>
                        <h2 class={groupTitle} id={`source-group-${group.id}`}>
                          {groupLabels[group.id]}
                        </h2>
                        <span class={meta}>{group.sources.length} sources</span>
                      </div>
                      <div class={sourceGrid}>
                        <For each={group.sources}>
                          {(definition) => (
                            <Show when={sourceById().get(definition.id)}>
                              {(source) => (
                                <SourceCard execute={sourceControl.execute} pending={pending()} source={source()} />
                              )}
                            </Show>
                          )}
                        </For>
                      </div>
                    </section>
                  )}
                </For>
              </>
            )}
          </Show>
        </div>
      </div>
    </main>
  );
}
