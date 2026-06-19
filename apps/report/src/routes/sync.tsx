import { css } from '@ai-usage/design-system/css';
import {
  dateCell,
  eyebrow,
  eyebrowRow,
  ghostButton,
  header,
  headerActions,
  headerTop,
  meta,
  muted,
  navButton,
  page,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  strongCell,
  summaryPill,
  table,
  tableWrap,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type { SyncRemoteState, SyncState, SyncStoredSnapshotState } from '@ai-usage/sync';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import { getSyncState as getSyncStateForRoute } from '../server/sync';
import {
  buildSyncSummary,
  enabledStatusLabel,
  formatSyncDateTime,
  remoteMachineLabel,
  tokenStatusLabel,
} from '../sync-page-model';

export const Route = createFileRoute('/sync')({
  loader: () => getSyncStateForRoute(),
  component: SyncRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

const statusBand = css({
  display: 'grid',
  gap: '14px',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 1fr) auto' },
  alignItems: 'center',
  p: '16px 18px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

const statusContent = css({
  display: 'grid',
  gap: '8px',
  minW: 0,
});

const statusTitleRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
});

const statusTitle = css({
  fontSize: '15px',
  fontWeight: 650,
});

const statusMeta = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 12px',
  color: 'muted',
  fontSize: '12px',
});

const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  justifyContent: { base: 'flex-start', lg: 'flex-end' },
});

const summaryGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(4, minmax(0, 1fr))' },
  gap: '12px',
});

const sectionGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 1.35fr) minmax(320px, 0.65fr)' },
  gap: '16px',
  alignItems: 'start',
});

const panelStack = css({
  display: 'grid',
  gap: '12px',
});

const detailGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
  gap: '10px',
});

const detailBlock = css({
  display: 'grid',
  gap: '3px',
  minW: 0,
});

const detailLabel = css({
  textStyle: 'label',
  color: 'muted',
});

const detailValue = css({
  fontFamily: 'mono',
  fontSize: '13px',
  overflowWrap: 'anywhere',
});

const emptyText = css({
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.6,
});

const badgeRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
});

const warningList = css({
  display: 'grid',
  gap: '10px',
});

const warningItem = css({
  display: 'grid',
  gap: '3px',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});

const errorPanel = css({
  p: '16px 18px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surface',
  color: 'ink',
});

type SyncStateResult = Awaited<ReturnType<typeof getSyncStateForRoute>>;

const MetricPanel = (props: { label: string; value: number; detail: string }) => (
  <div class={panel}>
    <div class={panelHeader}>
      <div class={panelSub}>{props.label}</div>
      <div class={panelTitle}>{props.value}</div>
      <div class={panelSub}>{props.detail}</div>
    </div>
  </div>
);

const RemoteRows = (props: { remotes: SyncRemoteState[] }) => (
  <Show
    when={props.remotes.length > 0}
    fallback={<div class={emptyText}>No snapshot remotes are configured yet.</div>}
  >
    <div class={tableWrap}>
      <table class={table}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Enabled</th>
            <th>Token</th>
            <th>Machine</th>
            <th>Rows</th>
            <th>Fetched</th>
            <th>URL</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.remotes}>
            {(remote) => (
              <tr>
                <td class={strongCell}>{remote.name}</td>
                <td>{enabledStatusLabel(remote)}</td>
                <td>
                  <div class={badgeRow}>
                    <span>{tokenStatusLabel(remote.tokenStatus)}</span>
                    <Show when={remote.tokenEnv}>{(tokenEnv) => <span class={muted}>{tokenEnv()}</span>}</Show>
                  </div>
                </td>
                <td>{remoteMachineLabel(remote)}</td>
                <td>{remote.rows.toLocaleString()}</td>
                <td class={dateCell}>{formatSyncDateTime(remote.fetchedAt)}</td>
                <td class={muted}>{remote.url}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

const SnapshotRows = (props: { snapshots: SyncStoredSnapshotState[] }) => (
  <Show
    when={props.snapshots.length > 0}
    fallback={<div class={emptyText}>No synced usage snapshots are stored yet.</div>}
  >
    <div class={warningList}>
      <For each={props.snapshots}>
        {(snapshot) => (
          <div class={warningItem}>
            <div class={strongCell}>{snapshot.machineLabel}</div>
            <div class={muted}>
              {snapshot.remoteName} - {snapshot.rows.toLocaleString()} rows - {formatSyncDateTime(snapshot.fetchedAt)}
            </div>
            <div class={dateCell}>{snapshot.remoteUrl}</div>
          </div>
        )}
      </For>
    </div>
  </Show>
);

const WarningRows = (props: { warnings: SyncState['warnings'] }) => (
  <Show when={props.warnings.length > 0} fallback={<div class={emptyText}>No sync warnings.</div>}>
    <div class={warningList}>
      <For each={props.warnings}>
        {(warning) => (
          <div class={warningItem}>
            <div class={strongCell}>{warning.operation}</div>
            <div>{warning.message}</div>
            <Show when={warning.path}>{(path) => <div class={dateCell}>{path()}</div>}</Show>
          </div>
        )}
      </For>
    </div>
  </Show>
);

const SyncStateView = (props: { state: SyncState; refreshing: boolean; onRefresh: () => void }) => {
  const summary = createMemo(() => buildSyncSummary(props.state));
  return (
    <div class={pageStack}>
      <section class={statusBand}>
        <div class={statusContent}>
          <div class={statusTitleRow}>
            <span class={statusTitle}>Local snapshot server</span>
            <span class={summaryPill}>Not serving</span>
          </div>
          <div class={statusMeta}>
            <span>{props.state.localMachine.label}</span>
            <span>{props.state.localMachine.id}</span>
          </div>
        </div>
        <div class={actionRow}>
          <button class={ghostButton} type="button" disabled>
            Start
          </button>
          <button class={ghostButton} type="button" disabled={props.refreshing} onClick={props.onRefresh}>
            {props.refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </section>

      <section class={summaryGrid} aria-label="Sync summary">
        <MetricPanel label="Configured remotes" value={summary().configuredRemotes} detail="Snapshot remotes" />
        <MetricPanel label="Enabled remotes" value={summary().enabledRemotes} detail="Included in pulls" />
        <MetricPanel label="Missing tokens" value={summary().missingTokens} detail="Token env not set" />
        <MetricPanel
          label="Stored snapshots"
          value={summary().storedSnapshots}
          detail={`${summary().warningCount} warnings`}
        />
      </section>

      <section class={sectionGrid}>
        <div class={panelStack}>
          <div class={panel}>
            <div class={panelHeader}>
              <div class={panelTitle}>Snapshot remotes</div>
              <div class={panelSub}>Configured remotes and the latest stored snapshot state.</div>
            </div>
            <RemoteRows remotes={props.state.remotes} />
          </div>

          <div class={panel}>
            <div class={panelHeader}>
              <div class={panelTitle}>Sync warnings</div>
              <div class={panelSub}>Local storage and snapshot read issues.</div>
            </div>
            <WarningRows warnings={props.state.warnings} />
          </div>
        </div>

        <div class={panelStack}>
          <div class={panel}>
            <div class={panelHeader}>
              <div class={panelTitle}>Local machine</div>
              <div class={panelSub}>This machine is used for self-sync protection.</div>
            </div>
            <div class={detailGrid}>
              <div class={detailBlock}>
                <div class={detailLabel}>Label</div>
                <div class={detailValue}>{props.state.localMachine.label}</div>
              </div>
              <div class={detailBlock}>
                <div class={detailLabel}>ID</div>
                <div class={detailValue}>{props.state.localMachine.id}</div>
              </div>
            </div>
          </div>

          <div class={panel}>
            <div class={panelHeader}>
              <div class={panelTitle}>Stored snapshots</div>
              <div class={panelSub}>Synced usage snapshots available to the report pipeline.</div>
            </div>
            <SnapshotRows snapshots={props.state.storedSnapshots} />
          </div>

          <div class={panel}>
            <div class={panelHeader}>
              <div class={panelTitle}>Discovery and add remote</div>
              <div class={panelSub}>LAN scan and manual endpoint form connect in later slices.</div>
            </div>
            <div class={emptyText}>Use the CLI sync commands until remote mutations and LAN discovery are wired here.</div>
          </div>
        </div>
      </section>
    </div>
  );
};

const SyncStateError = (props: {
  result: Extract<SyncStateResult, { ok: false }>;
  refreshing: boolean;
  onRefresh: () => void;
}) => (
  <div class={errorPanel}>
    <div class={panelHeader}>
      <div class={panelTitle}>Sync state unavailable</div>
      <div class={panelSub}>{props.result.error.message}</div>
    </div>
    <div class={actionRow}>
      <button class={ghostButton} type="button" disabled={props.refreshing} onClick={props.onRefresh}>
        {props.refreshing ? 'Refreshing' : 'Retry'}
      </button>
    </div>
  </div>
);

function SyncRoute() {
  const loaderResult = Route.useLoaderData();
  const [result, setResult] = createSignal<SyncStateResult>(loaderResult());
  const [refreshing, setRefreshing] = createSignal(false);
  const refresh = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      setResult(await getSyncStateForRoute());
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <div class={eyebrowRow}>
                <div class={eyebrow}>ai-usage</div>
              </div>
              <h1 class={title}>LAN sync</h1>
              <div class={meta}>Local snapshot serving and remote snapshot management.</div>
            </div>
            <div class={headerActions}>
              <Link to="/" search={dashboardSearchDefaults} class={navButton}>
                Report
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <Show
          when={result().ok}
          fallback={
            <SyncStateError
              result={result() as Extract<SyncStateResult, { ok: false }>}
              refreshing={refreshing()}
              onRefresh={() => void refresh()}
            />
          }
        >
          <SyncStateView
            state={(result() as Extract<SyncStateResult, { ok: true }>).data}
            refreshing={refreshing()}
            onRefresh={() => void refresh()}
          />
        </Show>
      </div>
    </main>
  );
}
