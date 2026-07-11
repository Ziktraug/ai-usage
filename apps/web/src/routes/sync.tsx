import { css } from '@ai-usage/design-system/css';
import {
  field,
  ghostButton,
  header,
  headerActions,
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
import type { ManualMergeImportResult } from '@ai-usage/usage-merge';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import { formatManualImportSummary, formatTransferBytes } from '../manual-transfer-model';
import { exportManualMergeBundle } from '../server/sync';

export const Route = createFileRoute('/sync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ importManualMergeBundleForServer }, { handleManualMergeUpload }] = await Promise.all([
          import('../server/manual-merge.server'),
          import('../server/manual-merge-upload.server'),
        ]);
        return handleManualMergeUpload(request, {
          importBundle: (text) => importManualMergeBundleForServer({ text }),
        });
      },
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

type ManualOperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { tag: string; message: string; reason?: string } };
type ManualImportResult = ManualOperationResult<ManualMergeImportResult>;
type ManualOperationError = Extract<ManualOperationResult<unknown>, { ok: false }>['error'];
type PendingOperation = 'manual-export' | 'manual-import';

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
      <div class={progressTrack}>
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
    <Show when={props.importProgress}>{(progress) => <ManualImportProgressView progress={progress()} />}</Show>
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

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

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

const parseImportResponse = (xhr: XMLHttpRequest): ManualImportResult => {
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
    return JSON.parse(xhr.responseText) as ManualImportResult;
  } catch {
    return { ok: false, error: { tag: 'InvalidResponse', message: 'The server returned an unreadable response.' } };
  }
};

// fetch() cannot report upload progress, so XMLHttpRequest is used to surface
// the upload phase before the server-side parse + merge takes over.
const importManualMergeFile = (
  file: File,
  onProgress: (progress: ManualImportProgress) => void,
): Promise<ManualImportResult> =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/sync');
    xhr.setRequestHeader('Content-Type', 'application/json');
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
    xhr.addEventListener('load', () => resolve(parseImportResponse(xhr)));
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
    setManualImportProgress({
      phase: 'uploading',
      fileName: file.name,
      fileSize: file.size,
      loaded: 0,
      total: file.size,
    });
    try {
      const next = await importManualMergeFile(file, setManualImportProgress);
      if (next.ok) {
        setOperationMessage(formatManualImportSummary(next.data));
        return;
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
            <Link class={navButton} search={dashboardSearchDefaults} to="/">
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main class={page}>
        <div class={pageStack}>
          <OperationNotice error={operationError()} message={operationMessage()} />
          <ManualTransferPanel
            importProgress={manualImportProgress()}
            onExport={manualExport}
            onImport={manualImport}
            pendingOperation={pendingOperation()}
          />
        </div>
      </main>
    </div>
  );
}
