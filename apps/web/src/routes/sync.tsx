import { css } from '@ai-usage/design-system/css';
import {
  dateCell,
  field,
  ghostButton,
  header,
  headerActions,
  headerTop,
  inlineFieldLabel,
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
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type { DiscoveredLanPeer } from '@ai-usage/lan-pairing';
import type { LanMergeState, ManualMergeImportResult, TrustedLanPeer } from '@ai-usage/usage-merge';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import type { LanMergeServerResult } from '../server/lan-merge.server';
import {
  exportManualMergeBundle,
  getLanMergeState,
  mergeLanPeer,
  pairLanPeer,
  scanLanMergePeers,
  startLanMerge,
  stopLanMerge,
} from '../server/sync';
import {
  buildLanMergeSummary,
  formatSyncDateTime,
  lanDiscoveredPeerStatusLabel,
  lanMergeErrorHint,
  lanMergeServiceStatusLabel,
  lanPrimaryPeerDetails,
  lanTrustedPeerStatusLabel,
  mergeBundleUrlForLanPeer,
} from '../sync-page-model';

export const Route = createFileRoute('/sync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { importManualMergeBundleForServer } = await import('../server/lan-merge.server');
        return Response.json(await importManualMergeBundleForServer({ text: await request.text() }));
      },
    },
  },
  loader: async () => ({
    lan: await getLanMergeState(),
  }),
  component: SyncRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

const summaryGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(4, minmax(0, 1fr))' },
  gap: '12px',
});

const sectionGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 1.2fr) minmax(320px, 0.8fr)' },
  gap: '16px',
  alignItems: 'start',
});

const panelStack = css({
  display: 'grid',
  gap: '12px',
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
});

const machineList = css({
  display: 'grid',
  gap: '10px',
});

const machineItem = css({
  display: 'grid',
  gap: '10px',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});

const machineHeader = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  justifyContent: 'space-between',
});

const badgeRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
});

const tinyBadge = css({
  display: 'inline-flex',
  alignItems: 'center',
  h: '20px',
  px: '7px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'muted',
  fontSize: '11px',
  fontWeight: 650,
});

const formField = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
});

const emptyText = css({
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.6,
});

const operationPanel = css({
  display: 'grid',
  gap: '4px',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  fontSize: '13px',
});

const diagnostics = css({
  display: 'grid',
  gap: '10px',
});

const diagnosticsList = css({
  display: 'grid',
  gap: '6px',
  fontFamily: 'mono',
  fontSize: '12px',
  overflowWrap: 'anywhere',
});

type LanStateResult = Awaited<ReturnType<typeof getLanMergeState>>;
type LanOperationError = Extract<LanStateResult, { ok: false }>['error'];
type ManualImportResult = LanMergeServerResult<ManualMergeImportResult>;

const MetricPanel = (props: { label: string; value: number; detail: string }) => (
  <div class={panel}>
    <div class={panelHeader}>
      <div class={panelSub}>{props.label}</div>
      <div class={panelTitle}>{props.value}</div>
      <div class={panelSub}>{props.detail}</div>
    </div>
  </div>
);

const OperationNotice = (props: { error: LanOperationError | null; message: string | null }) => (
  <Show when={props.error || props.message}>
    <div class={operationPanel} role={props.error ? 'alert' : 'status'}>
      <Show fallback={<div>{props.message}</div>} when={props.error}>
        {(error) => (
          <>
            <div class={strongCell}>{error().message}</div>
            <Show when={lanMergeErrorHint(error())}>{(hint) => <div class={muted}>{hint()}</div>}</Show>
          </>
        )}
      </Show>
    </div>
  </Show>
);

const canScanLan = (status: LanMergeState['service']['status']) => status === 'running' || status === 'pairing';
const scanButtonLabel = (canScan: boolean, scanning: boolean) => {
  if (!canScan) {
    return 'Start first';
  }
  return scanning ? 'Scanning' : 'Scan LAN';
};

const LocalMachinePanel = (props: {
  state: LanMergeState;
  scanning: boolean;
  pending: boolean;
  scanHost: string;
  onScanHostChange: (host: string) => void;
  onStart: () => void;
  onStop: () => void;
  onScan: () => void;
  onRefresh: () => void;
}) => (
  <section class={statusBand}>
    <div class={statusContent}>
      <div class={statusTitleRow}>
        <span class={statusTitle}>{props.state.localMachine.label}</span>
        <span class={summaryPill}>{lanMergeServiceStatusLabel(props.state.service.status)}</span>
      </div>
      <div class={statusMeta}>
        <span>{props.state.localMachine.id}</span>
        <span>{props.state.trustedPeers.length.toLocaleString()} paired machines</span>
        <span>{props.state.discoveredPeers.filter((peer) => !peer.self).length.toLocaleString()} nearby machines</span>
      </div>
      <Show when={props.state.service.lastError}>
        {(error) => (
          <div class={operationPanel} role="alert">
            <div class={strongCell}>{error()}</div>
          </div>
        )}
      </Show>
    </div>
    <div class={actionRow}>
      <label class={formField}>
        <span class={inlineFieldLabel}>Scan host</span>
        <input
          class={field}
          disabled={props.pending || props.scanning}
          onInput={(event) => props.onScanHostChange(event.currentTarget.value)}
          placeholder="192.168.1.23"
          value={props.scanHost}
        />
      </label>
      <Show
        fallback={
          <button class={ghostButton} disabled={props.pending || props.scanning} onClick={props.onStart} type="button">
            Start LAN merge
          </button>
        }
        when={props.state.service.status === 'running' || props.state.service.status === 'pairing'}
      >
        <button class={ghostButton} disabled={props.pending || props.scanning} onClick={props.onStop} type="button">
          Stop
        </button>
      </Show>
      <button
        class={ghostButton}
        disabled={props.pending || props.scanning || !canScanLan(props.state.service.status)}
        onClick={props.onScan}
        type="button"
      >
        {scanButtonLabel(canScanLan(props.state.service.status), props.scanning)}
      </button>
      <button class={ghostButton} disabled={props.pending || props.scanning} onClick={props.onRefresh} type="button">
        Refresh
      </button>
    </div>
  </section>
);

const PairedMachines = (props: {
  peers: TrustedLanPeer[];
  discoveredPeers: DiscoveredLanPeer[];
  pendingOperation: string | null;
  onMerge: (peer: TrustedLanPeer, discovered: DiscoveredLanPeer | undefined) => void;
}) => (
  <Show fallback={<div class={emptyText}>No machines are paired yet.</div>} when={props.peers.length > 0}>
    <div class={machineList}>
      <For each={props.peers}>
        {(peer) => {
          const discovered = () => props.discoveredPeers.find((item) => item.identity.id === peer.machineId);
          return (
            <div class={machineItem}>
              <div class={machineHeader}>
                <div>
                  <div class={strongCell}>{peer.machineLabel}</div>
                  <div class={muted}>{lanTrustedPeerStatusLabel(peer)}</div>
                </div>
                <span class={summaryPill}>{peer.online ? 'Online' : 'Offline'}</span>
              </div>
              <div class={badgeRow}>
                <For each={lanPrimaryPeerDetails(peer)}>{(detail) => <span class={tinyBadge}>{detail}</span>}</For>
              </div>
              <div class={actionRow}>
                <button
                  class={ghostButton}
                  disabled={!!props.pendingOperation}
                  onClick={() => props.onMerge(peer, discovered())}
                  type="button"
                >
                  Merge now
                </button>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  </Show>
);

const DiscoveredMachines = (props: {
  peers: DiscoveredLanPeer[];
  password: string;
  pendingOperation: string | null;
  onPasswordChange: (password: string) => void;
  onPair: (peer: DiscoveredLanPeer) => void;
}) => {
  const visiblePeers = () => props.peers.filter((peer) => !peer.self);
  const pairDisabledReason = (peer: DiscoveredLanPeer) => {
    if (props.pendingOperation) {
      return 'Operation in progress';
    }
    if (!props.password.trim()) {
      return 'Enter the pair password first';
    }
    if (!peer.online) {
      return 'Peer is offline';
    }
    if (!peer.pairingAvailable) {
      return 'Pairing is unavailable on this peer';
    }
    return null;
  };
  return (
    <div class={panelStack}>
      <label class={formField}>
        <span class={inlineFieldLabel}>Pair password</span>
        <input
          autocomplete="one-time-code"
          class={field}
          disabled={!!props.pendingOperation}
          onInput={(event) => props.onPasswordChange(event.currentTarget.value)}
          type="password"
          value={props.password}
        />
      </label>
      <Show
        fallback={<div class={emptyText}>Scan the LAN to find nearby machines.</div>}
        when={visiblePeers().length > 0}
      >
        <div class={machineList}>
          <For each={visiblePeers()}>
            {(peer) => {
              const disabledReason = () => pairDisabledReason(peer);
              return (
                <div class={machineItem}>
                  <div class={machineHeader}>
                    <div>
                      <div class={strongCell}>{peer.identity.label}</div>
                      <div class={muted}>{lanDiscoveredPeerStatusLabel(peer)}</div>
                    </div>
                    <span class={summaryPill}>{peer.online ? 'Online' : 'Offline'}</span>
                  </div>
                  <div class={dateCell}>Last seen {formatSyncDateTime(peer.lastSeenAt)}</div>
                  <div class={actionRow}>
                    <button
                      class={ghostButton}
                      disabled={!!disabledReason()}
                      onClick={() => props.onPair(peer)}
                      title={disabledReason() ?? `Pair ${peer.identity.label}`}
                      type="button"
                    >
                      Pair
                    </button>
                    <Show when={disabledReason()}>{(reason) => <span class={muted}>{reason()}</span>}</Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

const DiagnosticsPanel = (props: { state: LanMergeState }) => (
  <details class={panel}>
    <summary class={panelTitle}>Diagnostics</summary>
    <div class={diagnostics}>
      <div>
        <div class={panelSub}>Local endpoints</div>
        <div class={diagnosticsList}>
          <Show
            fallback={<span>No local LAN merge endpoint is running.</span>}
            when={props.state.service.urls.length > 0}
          >
            <For each={props.state.service.urls}>{(url) => <span>{url}</span>}</For>
          </Show>
        </div>
      </div>
      <div>
        <div class={panelSub}>Discovered endpoints</div>
        <div class={diagnosticsList}>
          <Show
            fallback={<span>No diagnostics for discovered machines.</span>}
            when={props.state.discoveredPeers.length > 0}
          >
            <For each={props.state.discoveredPeers}>
              {(peer) => (
                <span>
                  {peer.identity.label}: {mergeBundleUrlForLanPeer(peer)}
                </span>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  </details>
);

const ManualTransferPanel = (props: {
  pendingOperation: string | null;
  onExport: () => void;
  onImport: (file: File | undefined) => void;
}) => (
  <div class={panel}>
    <div class={panelHeader}>
      <div class={panelTitle}>Manual transfer</div>
      <div class={panelSub}>Export usage as a file or import a file from another machine.</div>
    </div>
    <div class={actionRow}>
      <button class={ghostButton} disabled={!!props.pendingOperation} onClick={props.onExport} type="button">
        {props.pendingOperation === 'manual-export' ? 'Exporting' : 'Export file'}
      </button>
      <label class={formField}>
        <span class={inlineFieldLabel}>Import file</span>
        <input
          accept=".json,application/json"
          class={field}
          disabled={!!props.pendingOperation}
          onChange={(event) => {
            props.onImport(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
          type="file"
        />
      </label>
    </div>
  </div>
);

const SyncStateView = (props: {
  state: LanMergeState;
  scanning: boolean;
  refreshing: boolean;
  pendingOperation: string | null;
  operationError: LanOperationError | null;
  operationMessage: string | null;
  scanHost: string;
  pairPassword: string;
  onScanHostChange: (host: string) => void;
  onPairPasswordChange: (password: string) => void;
  onStart: () => void;
  onStop: () => void;
  onScan: () => void;
  onRefresh: () => void;
  onMerge: (peer: TrustedLanPeer, discovered: DiscoveredLanPeer | undefined) => void;
  onPair: (peer: DiscoveredLanPeer) => void;
  onManualExport: () => void;
  onManualImport: (file: File | undefined) => void;
}) => {
  const summary = createMemo(() => buildLanMergeSummary(props.state));
  return (
    <div class={pageStack}>
      <LocalMachinePanel
        onRefresh={props.onRefresh}
        onScan={props.onScan}
        onScanHostChange={props.onScanHostChange}
        onStart={props.onStart}
        onStop={props.onStop}
        pending={props.refreshing || !!props.pendingOperation}
        scanHost={props.scanHost}
        scanning={props.scanning}
        state={props.state}
      />

      <section aria-label="LAN merge summary" class={summaryGrid}>
        <MetricPanel detail="Allowed to merge" label="Paired machines" value={summary().trustedMachines} />
        <MetricPanel detail="Seen on the LAN" label="Available" value={summary().onlineMachines} />
        <MetricPanel detail="Found by scan" label="Nearby" value={summary().discoveredMachines} />
        <MetricPanel detail="From peer bundles" label="Warnings" value={summary().warningCount} />
      </section>

      <OperationNotice error={props.operationError} message={props.operationMessage} />

      <section class={sectionGrid}>
        <div class={panel}>
          <div class={panelHeader}>
            <div class={panelTitle}>Paired machines</div>
            <div class={panelSub}>Merge usage rows from machines that already completed pairing.</div>
          </div>
          <PairedMachines
            discoveredPeers={props.state.discoveredPeers}
            onMerge={props.onMerge}
            peers={props.state.trustedPeers}
            pendingOperation={props.pendingOperation}
          />
        </div>

        <div class={panelStack}>
          <ManualTransferPanel
            onExport={props.onManualExport}
            onImport={props.onManualImport}
            pendingOperation={props.pendingOperation}
          />

          <div class={panel}>
            <div class={panelHeader}>
              <div class={panelTitle}>Pair nearby machine</div>
              <div class={panelSub}>
                Enter the shared password shown during pairing, then choose a discovered machine.
              </div>
            </div>
            <DiscoveredMachines
              onPair={props.onPair}
              onPasswordChange={props.onPairPasswordChange}
              password={props.pairPassword}
              peers={props.state.discoveredPeers}
              pendingOperation={props.pendingOperation}
            />
          </div>

          <DiagnosticsPanel state={props.state} />
        </div>
      </section>
    </div>
  );
};

const SyncStateError = (props: {
  result: Extract<LanStateResult, { ok: false }>;
  refreshing: boolean;
  onRefresh: () => void;
}) => (
  <div class={panel}>
    <div class={panelHeader}>
      <div class={panelTitle}>LAN merge unavailable</div>
      <div class={panelSub}>{props.result.error.message}</div>
    </div>
    <div class={actionRow}>
      <button class={ghostButton} disabled={props.refreshing} onClick={props.onRefresh} type="button">
        {props.refreshing ? 'Refreshing' : 'Retry'}
      </button>
    </div>
  </div>
);

const downloadJsonFile = (filename: string, value: unknown) => {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const manualImportMessage = (result: Extract<ManualImportResult, { ok: true }>['data']) => {
  const changed = result.result.inserted + result.result.updated + result.result.superseded + result.result.deleted;
  return `Imported ${result.machine.label}: ${changed.toLocaleString()} changed, ${result.result.unchanged.toLocaleString()} unchanged.`;
};

const importManualMergeFile = async (file: File): Promise<ManualImportResult> => {
  const response = await fetch('/sync', {
    body: file,
    headers: { 'Content-Type': file.type || 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    return {
      ok: false,
      error: {
        tag: 'HttpError',
        message: `Manual import failed with HTTP ${response.status}.`,
      },
    };
  }
  return (await response.json()) as ManualImportResult;
};

function SyncRoute() {
  const loaderResult = Route.useLoaderData();
  const [result, setResult] = createSignal<LanStateResult>(loaderResult().lan);
  const [refreshing, setRefreshing] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  const [pendingOperation, setPendingOperation] = createSignal<string | null>(null);
  const [operationError, setOperationError] = createSignal<LanOperationError | null>(null);
  const [operationMessage, setOperationMessage] = createSignal<string | null>(null);
  const [scanHost, setScanHost] = createSignal('');
  const [pairPassword, setPairPassword] = createSignal('');
  const okResult = createMemo(() => {
    const current = result();
    return current.ok ? current : null;
  });

  const setOperationResult = (next: LanStateResult, successMessage: string) => {
    setResult(next);
    if (next.ok) {
      setOperationError(null);
      setOperationMessage(successMessage);
      return true;
    }
    setOperationError(next.error);
    setOperationMessage(null);
    return false;
  };

  const refresh = async () => {
    if (refreshing() || pendingOperation()) {
      return;
    }
    setRefreshing(true);
    try {
      setResult(await getLanMergeState());
      setOperationError(null);
    } finally {
      setRefreshing(false);
    }
  };

  const scan = async () => {
    if (scanning() || pendingOperation()) {
      return;
    }
    setScanning(true);
    setOperationError(null);
    setOperationMessage(null);
    try {
      const host = scanHost().trim();
      setOperationResult(await scanLanMergePeers({ data: host ? { hosts: [host] } : {} }), 'LAN scan complete.');
    } finally {
      setScanning(false);
    }
  };

  const runOperation = async (
    operation: string,
    mutation: () => Promise<LanStateResult>,
    successMessage: string | ((state: LanMergeState) => string),
  ) => {
    if (pendingOperation()) {
      return;
    }
    setPendingOperation(operation);
    setOperationError(null);
    setOperationMessage(null);
    try {
      const next = await mutation();
      const message = operationSuccessMessage(successMessage, next);
      return setOperationResult(next, message);
    } finally {
      setPendingOperation(null);
    }
  };

  const operationSuccessMessage = (
    successMessage: string | ((state: LanMergeState) => string),
    result: LanStateResult,
  ) => {
    if (typeof successMessage !== 'function') {
      return successMessage;
    }
    return result.ok ? successMessage(result.data) : '';
  };

  const start = () => runOperation('start', () => startLanMerge({ data: {} }), 'LAN merge started.');

  const stop = () => runOperation('stop', () => stopLanMerge({ data: {} }), 'LAN merge stopped.');

  const mergePeer = (peer: TrustedLanPeer, discovered: DiscoveredLanPeer | undefined) =>
    runOperation(
      `merge:${peer.machineId}`,
      () =>
        mergeLanPeer({
          data: {
            machineId: peer.machineId,
            url: discovered ? mergeBundleUrlForLanPeer(discovered) : null,
          },
        }),
      `Merged ${peer.machineLabel}.`,
    );

  const pairPeer = (peer: DiscoveredLanPeer) =>
    runOperation(
      `pair:${peer.identity.id}`,
      () =>
        pairLanPeer({
          data: {
            discoveredPeerId: peer.identity.id,
            password: pairPassword().trim(),
            url: mergeBundleUrlForLanPeer(peer),
          },
        }),
      (state) =>
        state.trustedPeers.some((trusted) => trusted.machineId === peer.identity.id)
          ? `Paired ${peer.identity.label}.`
          : `Waiting for ${peer.identity.label}.`,
    );

  const manualExport = async () => {
    if (pendingOperation()) {
      return;
    }
    setPendingOperation('manual-export');
    setOperationError(null);
    setOperationMessage(null);
    try {
      const next = await exportManualMergeBundle({ data: {} });
      if (next.ok) {
        downloadJsonFile(next.data.filename, next.data.bundle);
        setOperationMessage(
          `Exported ${next.data.bundle.rows.length.toLocaleString()} rows from ${next.data.bundle.machine.label}.`,
        );
        return;
      }
      setOperationError(next.error);
    } finally {
      setPendingOperation(null);
    }
  };

  const manualImport = async (file: File | undefined) => {
    if (!file || pendingOperation()) {
      return;
    }
    setPendingOperation('manual-import');
    setOperationError(null);
    setOperationMessage(null);
    try {
      const next = await importManualMergeFile(file);
      if (next.ok) {
        setOperationMessage(manualImportMessage(next.data));
        return;
      }
      setOperationError(next.error);
    } finally {
      setPendingOperation(null);
    }
  };

  return (
    <div class={shell}>
      <header class={header}>
        <div class={headerTop}>
          <div class={titleBlock}>
            <p class={meta}>LAN merge</p>
            <h1 class={title}>Sync</h1>
          </div>
          <div class={headerActions}>
            <Link class={navButton} search={dashboardSearchDefaults} to="/">
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main class={page}>
        <Show
          fallback={
            <SyncStateError
              onRefresh={refresh}
              refreshing={refreshing()}
              result={result() as Extract<LanStateResult, { ok: false }>}
            />
          }
          when={okResult()}
        >
          {(okResult) => (
            <SyncStateView
              onManualExport={manualExport}
              onManualImport={manualImport}
              onMerge={mergePeer}
              onPair={pairPeer}
              onPairPasswordChange={setPairPassword}
              onRefresh={refresh}
              onScan={scan}
              onScanHostChange={setScanHost}
              onStart={start}
              onStop={stop}
              operationError={operationError()}
              operationMessage={operationMessage()}
              pairPassword={pairPassword()}
              pendingOperation={pendingOperation()}
              refreshing={refreshing()}
              scanHost={scanHost()}
              scanning={scanning()}
              state={okResult().data}
            />
          )}
        </Show>
      </main>
    </div>
  );
}
