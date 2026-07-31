import { css, cx } from '@ai-usage/design-system/css';
import {
  actionRow,
  banner,
  bannerError,
  commandButton,
  ghostButton,
  header,
  headerActions,
  headerTop,
  meta,
  page,
  panel,
  shell,
  statusPill,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import {
  type CollectionSourceGroup,
  collectionSourceDefinitions,
  type SourceControlEntryView,
  type SourcePublicationView,
} from '@ai-usage/report-core/source-control';
import { createFileRoute } from '@tanstack/solid-router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { enforceReportOnlyDemoNavigation } from '../demo-route-guard';
import { fmtDate, fmtNum } from '../shared';
import { useSourceControl } from '../source-control-context';
import { presentSourceProgress, presentSourceState, sourceToneClass } from '../source-control-presentation';

export const Route = createFileRoute('/sources')({
  beforeLoad: enforceReportOnlyDemoNavigation,
  component: SourcesRoute,
});

const pageStack = css({ display: 'grid', gap: '18px' });
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
const revisionValue = css({ display: 'flex', alignItems: 'center', gap: '6px', minW: 0 });
const revisionCode = css({ overflow: 'hidden', fontFamily: 'mono', fontSize: '11px', textOverflow: 'ellipsis' });
const detailList = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '12px', lineHeight: 1.5 });
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

const sourceCountLabel = (count: number): string => `${count} source${count === 1 ? '' : 's'}`;

const MAX_INLINE_REVISION_LENGTH = 24;
const REVISION_PREFIX_LENGTH = 12;
const REVISION_SUFFIX_LENGTH = 8;

const compactRevision = (revision: string): string =>
  revision.length <= MAX_INLINE_REVISION_LENGTH
    ? revision
    : `${revision.slice(0, REVISION_PREFIX_LENGTH)}…${revision.slice(-REVISION_SUFFIX_LENGTH)}`;

const PublicationRevision = (props: { value: string | null | undefined }) => {
  const [copied, setCopied] = createSignal(false);
  const copyRevision = async (): Promise<void> => {
    if (!props.value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Show fallback={<span class={axisValue}>Not published yet</span>} when={props.value}>
      {(revision) => (
        <div class={revisionValue}>
          <code class={revisionCode} title={revision()}>
            {compactRevision(revision())}
          </code>
          <button aria-label="Copy publication revision" class={ghostButton} onClick={copyRevision} type="button">
            {copied() ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </Show>
  );
};

const publicationStatus = (publication: SourcePublicationView): string => {
  if (publication.running) {
    return 'Publishing stored data now.';
  }
  if (publication.queued) {
    return 'Publication is queued.';
  }
  return publication.pendingDemand
    ? 'Publication demand is waiting for its dependency.'
    : 'Publication demand is fully acknowledged.';
};

const SourceCard = (props: {
  available: boolean;
  pending: boolean;
  source: SourceControlEntryView;
  execute: ReturnType<typeof useSourceControl>['execute'];
}) => {
  const canRun = () =>
    props.source.policy === 'enabled' &&
    props.source.availability === 'detected' &&
    !['queued', 'running', 'pausing'].includes(props.source.lifecycle);
  const determinateProgress = () => {
    const progress = presentSourceProgress(props.source);
    return progress.kind === 'determinate' ? progress : null;
  };
  const presentation = () => presentSourceState(props.source);
  const toggleDisabledReason = () => {
    if (!props.available) {
      return 'The usage engine is not available for source commands.';
    }
    if (props.pending) {
      return 'Another source command is pending.';
    }
    return;
  };
  const runDisabledReason = () => {
    if (!props.available) {
      return 'The usage engine is not available for source commands.';
    }
    if (props.pending) {
      return 'Another source command is pending.';
    }
    if (props.source.policy === 'disabled') {
      return 'Enable this source before running it.';
    }
    if (props.source.availability !== 'detected') {
      return 'Detect a supported input before running this source.';
    }
    if (!canRun()) {
      return 'This source is already queued or running.';
    }
    return;
  };

  return (
    <article class={cx(panel, sourceCard)} data-source-card>
      <div class={sourceHeader}>
        <div>
          <h3 class={sourceName}>{props.source.label}</h3>
          <p class={sourceId}>{props.source.id}</p>
        </div>
        <div class={sourceBadges}>
          <span class={cx(statusPill, sourceToneClass(presentation().tone))} data-source-health>
            {presentation().label}
          </span>
        </div>
      </div>
      <div class={axes}>
        <div class={axis}>
          <span class={axisLabel}>Availability</span>
          <span class={axisValue}>{props.source.availability}</span>
        </div>
        <div class={axis}>
          <span class={axisLabel}>Lifecycle</span>
          <span class={axisValue}>{props.source.lifecycle}</span>
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
            <Show
              fallback={<progress aria-label={`${props.source.label} progress`} class={progressBar} />}
              when={determinateProgress()}
            >
              {(progress) => (
                <progress
                  aria-label={`${props.source.label} progress`}
                  class={progressBar}
                  max={progress().max}
                  value={progress().value}
                />
              )}
            </Show>
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
        <p>
          Cadence: {fmtNum(Math.round(props.source.cadenceMs / 1000))}s · duration{' '}
          {props.source.durationMs === undefined ? 'not available' : `${fmtNum(props.source.durationMs)}ms`} · queue
          delay {props.source.queueDelayMs === undefined ? 'not available' : `${fmtNum(props.source.queueDelayMs)}ms`}
        </p>
        <p>
          Started {fmtDate(props.source.lastStartedAt ?? null)} · finished{' '}
          {fmtDate(props.source.lastFinishedAt ?? null)}
        </p>
        <For each={props.source.warnings}>{(warning) => <p>Warning: {warning.message ?? warning.code}</p>}</For>
      </div>
      <div class={actionRow}>
        <label class={switchLabel}>
          <input
            checked={props.source.policy === 'enabled'}
            disabled={!props.available || props.pending}
            onChange={(event) => {
              props
                .execute({
                  command: 'set-enabled',
                  enabled: event.currentTarget.checked,
                  sourceId: props.source.id,
                })
                .catch(() => undefined);
            }}
            title={toggleDisabledReason()}
            type="checkbox"
          />
          Enabled
        </label>
        <button
          aria-busy={props.pending ? 'true' : undefined}
          class={ghostButton}
          disabled={!props.available || props.pending || !canRun()}
          onClick={() => {
            props.execute({ command: 'run-now', sourceId: props.source.id }).catch(() => undefined);
          }}
          title={runDisabledReason()}
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
  const controlsAvailable = () => sourceControl.state().connection === 'live';
  const sourceById = createMemo(() => new Map(snapshot()?.sources.map((source) => [source.id, source] as const) ?? []));
  const groups = [
    { id: 'sessions', sources: collectionSourceDefinitions.filter((source) => source.group === 'sessions') },
    {
      id: 'provider-usage',
      sources: collectionSourceDefinitions.filter((source) => source.group === 'provider-usage'),
    },
    { id: 'enrichments', sources: collectionSourceDefinitions.filter((source) => source.group === 'enrichments') },
  ] as const;
  const conciseStatus = createMemo(() => {
    const state = sourceControl.state();
    if (state.commandError) {
      return state.commandError;
    }
    if (state.connection === 'protocol-mismatch') {
      return 'The usage engine is incompatible; stored report reads remain available.';
    }
    if (state.connection === 'disconnected') {
      return 'Connection interrupted; reconnecting.';
    }
    return state.publication ? 'Report published.' : '';
  });

  return (
    <main class={page} data-hydrated={sourceControl.state().connection === 'stopped' ? 'false' : 'true'}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <p class={meta}>Server-owned collection</p>
              <h1 class={title}>Sources</h1>
              <p class={meta}>Policy, availability, lifecycle, and outcomes stay independent for every collector.</p>
            </div>
            <div class={headerActions}>
              <button
                class={ghostButton}
                disabled={!(snapshot() && controlsAvailable()) || pending()}
                onClick={() => {
                  sourceControl.execute({ command: 'detect-all' }).catch(() => undefined);
                }}
                type="button"
              >
                Detect all
              </button>
              <button
                class={commandButton}
                disabled={!(snapshot() && controlsAvailable()) || pending()}
                onClick={() => {
                  sourceControl.execute({ command: 'run-all' }).catch(() => undefined);
                }}
                type="button"
              >
                Run all enabled
              </button>
            </div>
          </div>
        </header>
        <div aria-atomic="true" aria-live="polite" class={meta} role="status">
          {conciseStatus()}
        </div>
        <div class={pageStack}>
          <Show when={sourceControl.state().connection === 'disconnected'}>
            <div class={banner}>Connection interrupted. Showing the last server snapshot while reconnecting.</div>
          </Show>
          <Show when={sourceControl.state().connection === 'protocol-mismatch'}>
            <div class={banner}>
              This usage engine version is incompatible. Source mutations are disabled; stored report reads remain
              available.
            </div>
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
                <section class={cx(panel, sourceCard)}>
                  <h2 class={groupTitle}>Report publication pipeline</h2>
                  <p class={meta}>{publicationStatus(current().publication)}</p>
                  <div class={axes}>
                    <div class={axis}>
                      <span class={axisLabel}>Revision</span>
                      <PublicationRevision value={current().publication.revision} />
                    </div>
                    <div class={axis}>
                      <span class={axisLabel}>Last outcome</span>
                      <span class={axisValue}>{current().publication.lastOutcome}</span>
                    </div>
                    <div class={axis}>
                      <span class={axisLabel}>Demand</span>
                      <span class={axisValue}>
                        {current().publication.acknowledgedRequestGeneration}/
                        {current().publication.requestedGeneration} acknowledged
                      </span>
                    </div>
                    <div class={axis}>
                      <span class={axisLabel}>RTK dependency</span>
                      <span class={axisValue}>
                        {current().publication.rtkCompletedGeneration >= current().publication.rtkRequiredGeneration
                          ? 'Caught up'
                          : `Waiting for generation ${current().publication.rtkRequiredGeneration}`}
                      </span>
                    </div>
                  </div>
                </section>
                <For each={groups}>
                  {(group) => (
                    <section aria-labelledby={`source-group-${group.id}`} class={groupStack}>
                      <div class={groupHeader}>
                        <h2 class={groupTitle} id={`source-group-${group.id}`}>
                          {groupLabels[group.id]}
                        </h2>
                        <span class={meta}>{sourceCountLabel(group.sources.length)}</span>
                      </div>
                      <div class={sourceGrid}>
                        <For each={group.sources}>
                          {(definition) => (
                            <Show when={sourceById().get(definition.id)}>
                              {(source) => (
                                <SourceCard
                                  available={controlsAvailable()}
                                  execute={sourceControl.execute}
                                  pending={pending()}
                                  source={source()}
                                />
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
