import { css, cx } from '@ai-usage/design-system/css';
import {
  actionRow,
  ghostButton,
  header,
  headerTop,
  meta,
  page,
  pageStack,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  statusPill,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  strongCell,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import { parseUsageEngineMergePreviewOutput, type UsageEngineMergePreviewOutput } from '@ai-usage/usage-engine-control';
import { createFileRoute, useRouter } from '@tanstack/solid-router';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { enforceReportOnlyDemoNavigation } from '../demo-route-guard';
import type { ManualOperationError, ManualOperationResult } from '../manual-transfer-contract';
import {
  buildSyncFleetMachineViews,
  formatFleetAge,
  formatManualImportSummary,
  formatTransferBytes,
  manualTransferMutationAvailability,
} from '../manual-transfer-model';
import { exportManualMergeBundle, getSyncFleet } from '../server/sync';
import { useSourceControl } from '../source-control-context';

export const Route = createFileRoute('/sync')({
  beforeLoad: enforceReportOnlyDemoNavigation,
  loader: async () => await getSyncFleet(),
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleSyncUploadRequest } = await import('../server/sync-upload.server');
        return await handleSyncUploadRequest(request);
      },
    },
  },
  component: SyncRoute,
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

const progressRegion = css({
  display: 'grid',
  gap: '6px',
  mt: '4px',
});

const progressHeader = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  fontSize: '12px',
  color: 'muted',
});

const progressTrack = css({
  position: 'relative',
  h: '6px',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  border: '1px solid token(colors.line)',
  overflow: 'hidden',
});

const progressFill = css({
  position: 'absolute',
  insetBlock: 0,
  left: 0,
  bg: 'accent',
  borderRadius: 'full',
  transition: 'width 0.2s ease',
});

const progressFillProcessing = css({
  opacity: 0.55,
});

const progressHint = css({
  color: 'muted',
  fontSize: '11px',
  lineHeight: 1.5,
});

const fleetGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  gap: '12px',
});
const machineCard = css({
  display: 'grid',
  gap: '14px',
  minW: 0,
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
});
const machineCardCurrent = css({ borderColor: 'accent', boxShadow: '0 0 0 1px token(colors.accent)' });
const machineHeader = css({
  display: 'flex',
  alignItems: 'start',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '10px',
});
const machineTitle = css({ fontSize: '15px', fontWeight: 750, overflowWrap: 'anywhere' });
const machineFacts = css({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' });
const machineFact = css({ display: 'grid', gap: '3px', minW: 0 });
const machineFactLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
const dropZone = css({
  display: 'grid',
  placeItems: 'center',
  gap: '6px',
  minH: '112px',
  p: '18px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
  cursor: 'pointer',
  textAlign: 'center',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
const dropZoneActive = css({ borderColor: 'accent', bg: 'surfaceElevated' });

type ManualImportResult = ManualOperationResult<{ readonly kind: 'none' }>;
type ManualPreviewResult = ManualOperationResult<UsageEngineMergePreviewOutput>;
type PendingOperation = 'manual-export' | 'manual-preview' | 'manual-confirm';

type ManualImportProgress =
  | { phase: 'uploading'; fileName: string; fileSize: number; loaded: number; total: number }
  | { phase: 'processing'; fileName: string; fileSize: number; startedAt: number };

const OperationNotice = (props: { error: ManualOperationError | null; message: string | null }) => (
  <Show when={props.error || props.message}>
    <div class={operationPanel} role={props.error ? 'alert' : 'status'}>
      <Show fallback={<div>{props.message}</div>} when={props.error}>
        {(error) => <div class={strongCell}>{error().message}</div>}
      </Show>
    </div>
  </Show>
);

const MILLISECONDS_PER_SECOND = 1000;

const ManualImportProgressView = (props: { progress: ManualImportProgress }) => {
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  createEffect(() => {
    const current = props.progress;
    if (current.phase !== 'processing') {
      return;
    }
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - current.startedAt) / MILLISECONDS_PER_SECOND));
    }, MILLISECONDS_PER_SECOND);
    onCleanup(() => clearInterval(timer));
  });

  const isUploading = () => props.progress.phase === 'uploading';
  const percent = () => {
    const current = props.progress;
    if (current.phase === 'uploading' && current.total > 0) {
      return Math.round((current.loaded / current.total) * 100);
    }
    return 100;
  };
  const leftLabel = () => {
    const current = props.progress;
    if (current.phase === 'uploading') {
      return `Uploading ${formatTransferBytes(current.loaded)} / ${formatTransferBytes(current.total)}`;
    }
    return 'Merging into the local database…';
  };
  const rightLabel = () => (isUploading() ? `${percent()}%` : `${elapsedSeconds()}s`);

  return (
    <div class={progressRegion}>
      <div class={panelSub}>
        {props.progress.fileName} · {formatTransferBytes(props.progress.fileSize)}
      </div>
      <div class={progressHeader}>
        <span>{leftLabel()}</span>
        <span>{rightLabel()}</span>
      </div>
      <div
        aria-label={isUploading() ? 'Manual import upload progress' : 'Manual import processing'}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={isUploading() ? percent() : undefined}
        class={progressTrack}
        role="progressbar"
      >
        <div
          class={progressFill}
          classList={{ [progressFillProcessing]: !isUploading() }}
          style={{ width: `${percent()}%` }}
        />
      </div>
      <Show when={!isUploading()}>
        <span class={progressHint}>Large files take a moment while each usage row is written and deduplicated.</span>
      </Show>
    </div>
  );
};

const machineFreshnessLabel = (machine: { current: boolean; stale: boolean }): string => {
  if (!machine.stale) {
    return 'Fresh';
  }
  return machine.current ? 'Needs collection' : 'Stale';
};

const MachineFleetPanel = (props: {
  machines: ReturnType<typeof buildSyncFleetMachineViews>;
  omittedMachines: number;
  skipped: number;
}) => (
  <section aria-labelledby="machine-fleet-title">
    <div class={panelHeader}>
      <h2 class={panelTitle} id="machine-fleet-title">
        Machine fleet
      </h2>
      <div class={panelSub}>Freshness is evaluated against the report's default 30-day window.</div>
    </div>
    <div class={fleetGrid}>
      <For each={props.machines}>
        {(machine) => (
          <article
            class={cx(panel, machineCard, machine.current && machineCardCurrent)}
            data-machine-stale={machine.stale ? 'true' : 'false'}
          >
            <div class={machineHeader}>
              <div>
                <h3 class={machineTitle}>{machine.label}</h3>
              </div>
              <div class={actionRow}>
                <Show when={machine.current}>
                  <span class={cx(statusPill, statusPillInfo)}>Current machine</span>
                </Show>
                <span class={cx(statusPill, machine.stale ? statusPillWarn : statusPillOk)}>
                  {machineFreshnessLabel(machine)}
                </span>
              </div>
            </div>
            <div class={machineFacts}>
              <div class={machineFact}>
                <span class={machineFactLabel}>Sessions</span>
                <span>{machine.sessionCount.toLocaleString()}</span>
              </div>
              <div class={machineFact}>
                <span class={machineFactLabel}>Newest session</span>
                <span>{formatFleetAge(machine.newestSessionAt)}</span>
              </div>
              <div class={machineFact}>
                <span class={machineFactLabel}>{machine.current ? 'Last observed' : 'Last import'}</span>
                <span>{formatFleetAge(machine.lastSeenAt)}</span>
              </div>
            </div>
          </article>
        )}
      </For>
    </div>
    <Show when={props.skipped > 0}>
      <p class={panelSub} role="status">
        {props.skipped.toLocaleString()} invalid stored rows were excluded from fleet metadata.
      </p>
    </Show>
    <Show when={props.omittedMachines > 0}>
      <p class={panelSub} role="status">
        {props.omittedMachines.toLocaleString()} additional machines were omitted from this bounded fleet view.
      </p>
    </Show>
  </section>
);

const ImportDropTarget = (props: { disabled: boolean; onImport: (file: File | undefined) => void }) => {
  const [dragActive, setDragActive] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  const chooseFile = () => fileInput?.click();
  return (
    <>
      <input
        accept=".json,application/json"
        disabled={props.disabled}
        hidden
        onChange={(event) => {
          props.onImport(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
        ref={(element) => {
          fileInput = element;
        }}
        type="file"
      />
      <button
        class={cx(dropZone, dragActive() && dropZoneActive)}
        disabled={props.disabled}
        onClick={chooseFile}
        onDragEnter={() => setDragActive(true)}
        onDragLeave={() => setDragActive(false)}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (!props.disabled) {
            props.onImport(event.dataTransfer?.files?.[0]);
          }
        }}
        type="button"
      >
        <span class={strongCell}>Drop a merge file here or choose a file</span>

        <span class={panelSub}>JSON only. The file is previewed before any local usage changes.</span>
      </button>
    </>
  );
};

const ManualTransferPanel = (props: {
  importProgress: ManualImportProgress | null;
  mutationsDisabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onExport: () => void;
  onImport: (file: File | undefined) => void;
  pendingOperation: PendingOperation | null;
  preview: { data: UsageEngineMergePreviewOutput; file: File } | null;
}) => (
  <div class={panel}>
    <div class={panelHeader}>
      <div class={panelTitle}>Manual transfer</div>
      <div class={panelSub}>Export usage as a file or import a file from another machine.</div>
    </div>
    <div class={actionRow}>
      <button class={ghostButton} disabled={!!props.pendingOperation} onClick={props.onExport} type="button">
        {props.pendingOperation === 'manual-export' ? 'Exporting' : 'Export current machine'}
      </button>
    </div>
    <ImportDropTarget disabled={props.mutationsDisabled || !!props.pendingOperation} onImport={props.onImport} />

    <Show when={props.preview}>
      {(preview) => (
        <div class={operationPanel} role="status">
          <div class={strongCell}>Review merge import</div>
          <div>
            {preview().file.name} · {preview().data.rows.toLocaleString()} rows ·{' '}
            {formatTransferBytes(preview().data.bytes)}
          </div>
          <div>
            {preview().data.result.inserted} inserted, {preview().data.result.updated} updated,{' '}
            {preview().data.result.unchanged} unchanged, {preview().data.result.superseded} superseded,{' '}
            {preview().data.result.deleted} deleted, {preview().data.warningCount} warnings
          </div>
          <div class={panelSub}>Peer provenance is preserved; local history is not replaced wholesale.</div>
          <div class={actionRow}>
            <button
              class={ghostButton}
              disabled={props.mutationsDisabled || !!props.pendingOperation}
              onClick={props.onConfirm}
              type="button"
            >
              {props.pendingOperation === 'manual-confirm' ? 'Confirming' : 'Confirm import'}
            </button>
            <button class={ghostButton} disabled={!!props.pendingOperation} onClick={props.onCancel} type="button">
              Cancel
            </button>
          </div>
        </div>
      )}
    </Show>
    <Show when={props.importProgress}>{(progress) => <ManualImportProgressView progress={progress()} />}</Show>
  </div>
);

const downloadJsonFile = (filename: string, text: string) => {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isManualPreviewData = (value: unknown): value is UsageEngineMergePreviewOutput => {
  try {
    parseUsageEngineMergePreviewOutput(value);
    return true;
  } catch {
    return false;
  }
};

const isManualImportData = (value: unknown): value is { readonly kind: 'none' } =>
  isRecord(value) && Object.keys(value).length === 1 && value.kind === 'none';

const isManualImportFailure = (value: unknown): value is Extract<ManualImportResult, { ok: false }> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== false || typeof result.error !== 'object' || result.error === null || Array.isArray(result.error)) {
    return false;
  }
  const error = result.error as Record<string, unknown>;
  return typeof error.tag === 'string' && typeof error.message === 'string';
};

const parseImportResponse = <Value,>(
  xhr: XMLHttpRequest,
  isValue: (value: unknown) => value is Value,
): ManualOperationResult<Value> => {
  if (xhr.status < HTTP_OK_MIN || xhr.status >= HTTP_OK_MAX) {
    try {
      const failure = JSON.parse(xhr.responseText) as unknown;
      if (isManualImportFailure(failure)) {
        return failure;
      }
    } catch {
      // The status-specific fallback below is more useful than a JSON parse error.
    }
    return { ok: false, error: { tag: 'HttpError', message: `Manual import failed with HTTP ${xhr.status}.` } };
  }
  try {
    const response = JSON.parse(xhr.responseText) as unknown;
    if (isManualImportFailure(response)) {
      return response;
    }
    if (isRecord(response) && response.ok === true && isValue(response.data)) {
      return { ok: true, data: response.data };
    }
    return { ok: false, error: { tag: 'InvalidResponse', message: 'The server returned an invalid response.' } };
  } catch {
    return { ok: false, error: { tag: 'InvalidResponse', message: 'The server returned an unreadable response.' } };
  }
};

// fetch() cannot report upload progress, so XMLHttpRequest is used to surface
// the upload phase before the server-side parse + merge takes over.
const uploadManualMergeFile = <Value,>(
  file: File,
  action: 'preview' | 'confirm',
  onProgress: (progress: ManualImportProgress) => void,
  isValue: (value: unknown) => value is Value,
  expected?: UsageEngineMergePreviewOutput,
): Promise<ManualOperationResult<Value>> =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/sync');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Ai-Usage-Merge-Action', action);
    if (expected) {
      xhr.setRequestHeader('X-Ai-Usage-Merge-Digest', expected.documentDigest);
      xhr.setRequestHeader('X-Ai-Usage-Merge-Confirmation', expected.confirmationToken);
    }
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress({
          phase: 'uploading',
          fileName: file.name,
          fileSize: file.size,
          loaded: event.loaded,
          total: event.total,
        });
      }
    });
    xhr.upload.addEventListener('load', () => {
      onProgress({ phase: 'processing', fileName: file.name, fileSize: file.size, startedAt: Date.now() });
    });
    xhr.addEventListener('load', () => resolve(parseImportResponse(xhr, isValue)));
    xhr.addEventListener('error', () =>
      resolve({ ok: false, error: { tag: 'NetworkError', message: 'Network error during manual import.' } }),
    );
    xhr.send(file);
  });

function SyncRoute() {
  const fleetResult = Route.useLoaderData();
  const router = useRouter();
  const sourceControl = useSourceControl();
  const mutationAvailability = () => manualTransferMutationAvailability(sourceControl.state().connection);
  const fleetData = () => {
    const result = fleetResult();
    return result.ok ? result.data : null;
  };
  const fleetError = (): ManualOperationError | null => {
    const result = fleetResult();
    return result.ok ? null : result.error;
  };

  const [pendingOperation, setPendingOperation] = createSignal<PendingOperation | null>(null);
  const [operationError, setOperationError] = createSignal<ManualOperationError | null>(null);
  const [operationMessage, setOperationMessage] = createSignal<string | null>(null);
  const [manualImportProgress, setManualImportProgress] = createSignal<ManualImportProgress | null>(null);
  const [manualPreview, setManualPreview] = createSignal<{ data: UsageEngineMergePreviewOutput; file: File } | null>(
    null,
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
        downloadJsonFile(next.data.filename, next.data.text);
        setOperationMessage(
          `Exported ${next.data.filename}: ${next.data.rows.toLocaleString()} rows, ${formatTransferBytes(next.data.bytes)}.`,
        );
        return;
      }
      setOperationError(next.error);
    } finally {
      setPendingOperation(null);
    }
  };

  const manualImport = async (file: File | undefined) => {
    if (!(file && mutationAvailability().available) || pendingOperation()) {
      return;
    }
    setPendingOperation('manual-preview');
    setOperationError(null);
    setOperationMessage(null);
    setManualImportProgress({
      phase: 'uploading',
      fileName: file.name,
      fileSize: file.size,
      loaded: 0,
      total: file.size,
    });
    try {
      const next: ManualPreviewResult = await uploadManualMergeFile(
        file,
        'preview',
        setManualImportProgress,
        isManualPreviewData,
      );
      if (next.ok) {
        setManualPreview({ data: next.data, file });
        setOperationMessage('Preview ready. Review the changes before confirming.');
        return;
      }
      setOperationError(next.error);
    } finally {
      setPendingOperation(null);
      setManualImportProgress(null);
    }
  };

  const confirmManualImport = async () => {
    const preview = manualPreview();
    if (!(preview && mutationAvailability().available) || pendingOperation()) {
      return;
    }
    setPendingOperation('manual-confirm');
    setOperationError(null);
    setOperationMessage(null);
    setManualImportProgress({
      phase: 'uploading',
      fileName: preview.file.name,
      fileSize: preview.file.size,
      loaded: 0,
      total: preview.file.size,
    });
    try {
      const next: ManualImportResult = await uploadManualMergeFile(
        preview.file,
        'confirm',
        setManualImportProgress,
        isManualImportData,
        preview.data,
      );
      if (next.ok) {
        const successMessage = formatManualImportSummary(preview.data);
        await router.invalidate({ filter: (match) => match.routeId === '/sync' });
        setManualPreview(null);
        setOperationMessage(successMessage);
        return;
      }
      if (next.error.reason === 'preview-stale') {
        setManualPreview(null);
      }
      setOperationError(next.error);
    } finally {
      setPendingOperation(null);
      setManualImportProgress(null);
    }
  };

  return (
    <div class={shell}>
      <header class={header}>
        <div class={headerTop}>
          <div class={titleBlock}>
            <p class={meta}>File transfer</p>
            <h1 class={title}>Sync</h1>
          </div>
        </div>
      </header>

      <main class={page}>
        <div class={pageStack}>
          <OperationNotice error={operationError()} message={operationMessage()} />
          <OperationNotice error={fleetError()} message={null} />
          <OperationNotice error={null} message={mutationAvailability().message} />
          <Show when={fleetData()}>
            {(data) => (
              <MachineFleetPanel
                machines={buildSyncFleetMachineViews(data().currentMachine, data().machines)}
                omittedMachines={data().omittedMachines}
                skipped={data().skipped}
              />
            )}
          </Show>
          <ManualTransferPanel
            importProgress={manualImportProgress()}
            mutationsDisabled={!mutationAvailability().available}
            onCancel={() => setManualPreview(null)}
            onConfirm={confirmManualImport}
            onExport={manualExport}
            onImport={manualImport}
            pendingOperation={pendingOperation()}
            preview={manualPreview()}
          />
        </div>
      </main>
    </div>
  );
}
