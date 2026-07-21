import { css } from '@ai-usage/design-system/css';
import {
  field,
  ghostButton,
  header,
  headerActions,
  headerNavigation,
  headerTop,
  inlineFieldLabel,
  meta,
  navButton,
  page,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  strongCell,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type { ManualMergeImportResult, ManualMergePreviewResult } from '@ai-usage/usage-merge';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import { enforceReportOnlyDemoNavigation } from '../demo-route-guard';
import type { ManualOperationError, ManualOperationResult } from '../manual-transfer-contract';
import { formatManualImportSummary, formatTransferBytes } from '../manual-transfer-model';
import { exportManualMergeBundle } from '../server/sync';
import { handleSyncUploadRequest } from '../server/sync-upload.server';

export const Route = createFileRoute('/sync')({
  beforeLoad: enforceReportOnlyDemoNavigation,
  server: {
    handlers: {
      POST: ({ request }) => handleSyncUploadRequest(request),
    },
  },
  component: SyncRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

const formField = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
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

type ManualImportResult = ManualOperationResult<ManualMergeImportResult>;
type ManualPreviewResult = ManualOperationResult<ManualMergePreviewResult>;
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

const ManualTransferPanel = (props: {
  pendingOperation: PendingOperation | null;
  importProgress: ManualImportProgress | null;
  onExport: () => void;
  onImport: (file: File | undefined) => void;
  onConfirm: () => void;
  onCancel: () => void;
  preview: { data: ManualMergePreviewResult; file: File } | null;
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
    <Show when={props.preview}>
      {(preview) => (
        <div class={operationPanel} role="status">
          <div class={strongCell}>Review import from {preview().data.machine.label}</div>
          <div>
            {preview().file.name} · {preview().data.rows.toLocaleString()} rows ·{' '}
            {formatTransferBytes(preview().data.bytes)}
          </div>
          <div>
            {preview().data.inserted} inserted, {preview().data.updated} updated, {preview().data.unchanged} unchanged,{' '}
            {preview().data.superseded} superseded, {preview().data.deleted} deleted
          </div>
          <div class={panelSub}>Peer provenance is preserved; local history is not replaced wholesale.</div>
          <div class={actionRow}>
            <button class={ghostButton} disabled={!!props.pendingOperation} onClick={props.onConfirm} type="button">
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

const isNonNegativeSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

const isImportResult = (value: unknown): boolean =>
  isRecord(value) &&
  ['deleted', 'inserted', 'superseded', 'unchanged', 'updated', 'warnings'].every((key) =>
    isNonNegativeSafeInteger(value[key]),
  );

const isMachine = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && typeof value.label === 'string';

const isManualPreviewData = (value: unknown): value is ManualMergePreviewResult =>
  isImportResult(value) &&
  isRecord(value) &&
  isNonNegativeSafeInteger(value.bytes) &&
  typeof value.digest === 'string' &&
  typeof value.generatedAt === 'string' &&
  isMachine(value.machine) &&
  isNonNegativeSafeInteger(value.rows) &&
  isNonNegativeSafeInteger(value.storeGeneration) &&
  typeof value.storeStateToken === 'string' &&
  isNonNegativeSafeInteger(value.warningCount) &&
  Array.isArray(value.warningItems) &&
  value.warningItems.every((item) => typeof item === 'string');

const isManualImportData = (value: unknown): value is ManualMergeImportResult =>
  isRecord(value) &&
  typeof value.generatedAt === 'string' &&
  isMachine(value.machine) &&
  isImportResult(value.result) &&
  isNonNegativeSafeInteger(value.rows) &&
  isNonNegativeSafeInteger(value.warnings);

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
  expected?: ManualMergePreviewResult,
): Promise<ManualOperationResult<Value>> =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/sync');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Ai-Usage-Merge-Action', action);
    if (expected) {
      xhr.setRequestHeader('X-Ai-Usage-Merge-Digest', expected.digest);
      xhr.setRequestHeader('X-Ai-Usage-Store-Generation', String(expected.storeGeneration));
      xhr.setRequestHeader('X-Ai-Usage-Store-State', expected.storeStateToken);
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
  const [pendingOperation, setPendingOperation] = createSignal<PendingOperation | null>(null);
  const [operationError, setOperationError] = createSignal<ManualOperationError | null>(null);
  const [operationMessage, setOperationMessage] = createSignal<string | null>(null);
  const [manualImportProgress, setManualImportProgress] = createSignal<ManualImportProgress | null>(null);
  const [manualPreview, setManualPreview] = createSignal<{ data: ManualMergePreviewResult; file: File } | null>(null);

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
        setOperationMessage(`Exported ${next.data.rows.toLocaleString()} rows from ${next.data.machine.label}.`);
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
    if (!preview || pendingOperation()) {
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
        setManualPreview(null);
        setOperationMessage(formatManualImportSummary(next.data));
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
          <div class={headerActions}>
            <nav aria-label="Primary navigation" class={headerNavigation}>
              <Link class={navButton} search={dashboardSearchDefaults} to="/">
                Dashboard
              </Link>
              <Link class={navButton} to="/sources">
                Sources
              </Link>
            </nav>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main class={page}>
        <div class={pageStack}>
          <OperationNotice error={operationError()} message={operationMessage()} />
          <ManualTransferPanel
            importProgress={manualImportProgress()}
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
