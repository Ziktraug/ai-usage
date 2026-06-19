import { css } from '@ai-usage/design-system/css';
import {
  dateCell,
  eyebrow,
  eyebrowRow,
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
import {
  getSyncState as getSyncStateForRoute,
  pullSyncRemote,
  removeSyncRemote,
  setSyncRemoteEnabled,
  upsertSyncRemote,
  validateSyncRemote,
} from '../server/sync';
import {
  buildSyncSummary,
  enabledStatusLabel,
  formatSyncDateTime,
  remoteMachineLabel,
  syncOperationErrorHint,
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
type SyncOperationResult = Extract<SyncStateResult, { ok: false }>['error'];

interface RemoteFormState {
  mode: 'add' | 'edit';
  name: string;
  url: string;
  tokenEnv: string;
  validationToken: string;
}

const emptyRemoteForm = (): RemoteFormState => ({
  mode: 'add',
  name: '',
  url: '',
  tokenEnv: '',
  validationToken: '',
});

const remoteFormFrom = (remote: SyncRemoteState): RemoteFormState => ({
  mode: 'edit',
  name: remote.name,
  url: remote.url,
  tokenEnv: remote.tokenEnv ?? '',
  validationToken: '',
});

const formGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  gap: '10px',
});

const formField = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
});

const fullWidthField = css({
  gridColumn: { base: 'auto', md: '1 / -1' },
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

const MetricPanel = (props: { label: string; value: number; detail: string }) => (
  <div class={panel}>
    <div class={panelHeader}>
      <div class={panelSub}>{props.label}</div>
      <div class={panelTitle}>{props.value}</div>
      <div class={panelSub}>{props.detail}</div>
    </div>
  </div>
);

const RemoteRows = (props: {
  remotes: SyncRemoteState[];
  pendingOperation: string | null;
  onEdit: (remote: SyncRemoteState) => void;
  onPull: (remote: SyncRemoteState) => void;
  onSetEnabled: (remote: SyncRemoteState, enabled: boolean) => void;
  onRemove: (remote: SyncRemoteState) => void;
}) => (
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
            <th>Actions</th>
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
                <td>
                  <div class={actionRow}>
                    <button
                      class={ghostButton}
                      type="button"
                      disabled={!!props.pendingOperation}
                      onClick={() => props.onPull(remote)}
                    >
                      Pull now
                    </button>
                    <button
                      class={ghostButton}
                      type="button"
                      disabled={!!props.pendingOperation}
                      onClick={() => props.onSetEnabled(remote, !remote.enabled)}
                    >
                      {remote.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button class={ghostButton} type="button" disabled={!!props.pendingOperation} onClick={() => props.onEdit(remote)}>
                      Edit
                    </button>
                    <button
                      class={ghostButton}
                      type="button"
                      disabled={!!props.pendingOperation}
                      onClick={() => props.onRemove(remote)}
                    >
                      Remove
                    </button>
                  </div>
                </td>
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

const OperationNotice = (props: { error: SyncOperationResult | null; message: string | null }) => (
  <Show when={props.error || props.message}>
    <div class={operationPanel} role={props.error ? 'alert' : 'status'}>
      <Show
        when={props.error}
        fallback={<div>{props.message}</div>}
      >
        {(error) => (
          <>
            <div class={strongCell}>{error().message}</div>
            <Show when={syncOperationErrorHint(error())}>{(hint) => <div class={muted}>{hint()}</div>}</Show>
          </>
        )}
      </Show>
    </div>
  </Show>
);

const RemoteForm = (props: {
  form: RemoteFormState;
  pendingOperation: string | null;
  onChange: (form: RemoteFormState) => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onValidate: () => void;
}) => {
  const update = (patch: Partial<RemoteFormState>) => props.onChange({ ...props.form, ...patch });
  const disabled = () => !!props.pendingOperation;
  return (
    <form
      class={panelStack}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <div class={formGrid}>
        <label class={formField}>
          <span class={inlineFieldLabel}>Remote name</span>
          <input
            class={field}
            value={props.form.name}
            disabled={disabled() || props.form.mode === 'edit'}
            onInput={(event) => update({ name: event.currentTarget.value })}
            placeholder="macbook"
          />
        </label>
        <label class={formField}>
          <span class={inlineFieldLabel}>Token env</span>
          <input
            class={field}
            value={props.form.tokenEnv}
            disabled={disabled()}
            onInput={(event) => update({ tokenEnv: event.currentTarget.value })}
            placeholder="AI_USAGE_SYNC_TOKEN"
          />
        </label>
        <label class={`${formField} ${fullWidthField}`}>
          <span class={inlineFieldLabel}>Snapshot URL</span>
          <input
            class={field}
            value={props.form.url}
            disabled={disabled()}
            onInput={(event) => update({ url: event.currentTarget.value })}
            placeholder="http://192.168.1.20:3847/snapshot"
          />
        </label>
        <label class={`${formField} ${fullWidthField}`}>
          <span class={inlineFieldLabel}>Validation token</span>
          <input
            class={field}
            value={props.form.validationToken}
            disabled={disabled()}
            onInput={(event) => update({ validationToken: event.currentTarget.value })}
            placeholder="Used once for /health, not saved"
            type="password"
            autocomplete="off"
          />
        </label>
      </div>
      <div class={actionRow}>
        <button class={ghostButton} type="button" disabled={disabled() || !props.form.url} onClick={props.onValidate}>
          Validate
        </button>
        <button class={ghostButton} type="submit" disabled={disabled() || !props.form.name || !props.form.url}>
          {props.form.mode === 'edit' ? 'Save remote' : 'Add remote'}
        </button>
        <Show when={props.form.mode === 'edit'}>
          <button class={ghostButton} type="button" disabled={disabled()} onClick={props.onCancelEdit}>
            Cancel
          </button>
        </Show>
      </div>
    </form>
  );
};

const SyncStateView = (props: {
  state: SyncState;
  refreshing: boolean;
  pendingOperation: string | null;
  operationError: SyncOperationResult | null;
  operationMessage: string | null;
  remoteForm: RemoteFormState;
  onRemoteFormChange: (form: RemoteFormState) => void;
  onRemoteFormReset: () => void;
  onRemoteEdit: (remote: SyncRemoteState) => void;
  onRemoteSave: () => void;
  onRemoteValidate: () => void;
  onRemotePull: (remote: SyncRemoteState) => void;
  onRemoteSetEnabled: (remote: SyncRemoteState, enabled: boolean) => void;
  onRemoteRemove: (remote: SyncRemoteState) => void;
  onRefresh: () => void;
}) => {
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
            <OperationNotice error={props.operationError} message={props.operationMessage} />
            <RemoteRows
              remotes={props.state.remotes}
              pendingOperation={props.pendingOperation}
              onEdit={props.onRemoteEdit}
              onPull={props.onRemotePull}
              onSetEnabled={props.onRemoteSetEnabled}
              onRemove={props.onRemoteRemove}
            />
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
              <div class={panelTitle}>{props.remoteForm.mode === 'edit' ? 'Edit remote' : 'Add remote'}</div>
              <div class={panelSub}>Validate with an optional one-time token; save only name, URL, and token env.</div>
            </div>
            <RemoteForm
              form={props.remoteForm}
              pendingOperation={props.pendingOperation}
              onChange={props.onRemoteFormChange}
              onCancelEdit={props.onRemoteFormReset}
              onSave={props.onRemoteSave}
              onValidate={props.onRemoteValidate}
            />
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
  const [pendingOperation, setPendingOperation] = createSignal<string | null>(null);
  const [operationError, setOperationError] = createSignal<SyncOperationResult | null>(null);
  const [operationMessage, setOperationMessage] = createSignal<string | null>(null);
  const [remoteForm, setRemoteForm] = createSignal<RemoteFormState>(emptyRemoteForm());
  const setOperationResult = (next: SyncStateResult, successMessage: string) => {
    if (next.ok) {
      setResult(next);
      setOperationError(null);
      setOperationMessage(successMessage);
      return true;
    }
    setResult(next);
    setOperationError(next.error);
    setOperationMessage(null);
    return false;
  };
  const runStateMutation = async (operation: string, mutation: () => Promise<SyncStateResult>, successMessage: string) => {
    if (pendingOperation()) return;
    setPendingOperation(operation);
    setOperationError(null);
    setOperationMessage(null);
    try {
      return setOperationResult(await mutation(), successMessage);
    } finally {
      setPendingOperation(null);
    }
  };
  const refresh = async () => {
    if (refreshing() || pendingOperation()) return;
    setRefreshing(true);
    try {
      setResult(await getSyncStateForRoute());
      setOperationError(null);
    } finally {
      setRefreshing(false);
    }
  };
  const saveRemote = async () => {
    const form = remoteForm();
    const saved = await runStateMutation(
      'save-remote',
      () =>
        upsertSyncRemote({
          data: {
            name: form.name.trim(),
            url: form.url.trim(),
            tokenEnv: form.tokenEnv.trim() || null,
          },
        }),
      form.mode === 'edit' ? `Updated ${form.name.trim()}.` : `Added ${form.name.trim()}.`,
    );
    if (saved) setRemoteForm(emptyRemoteForm());
  };
  const validateRemote = async () => {
    const form = remoteForm();
    if (pendingOperation()) return;
    setPendingOperation('validate-remote');
    setOperationError(null);
    setOperationMessage(null);
    try {
      const validation = await validateSyncRemote({
        data: {
          url: form.url.trim(),
          token: form.validationToken || null,
        },
      });
      if (validation.ok) {
        setOperationMessage(`Validated ${validation.data.machine.label}.`);
      } else {
        setOperationError(validation.error);
      }
    } finally {
      setPendingOperation(null);
    }
  };
  const setRemoteEnabled = (remote: SyncRemoteState, enabled: boolean) =>
    void runStateMutation(
      `set-enabled-${remote.name}`,
      () => setSyncRemoteEnabled({ data: { name: remote.name, enabled } }),
      `${enabled ? 'Enabled' : 'Disabled'} ${remote.name}.`,
    );
  const pullRemote = (remote: SyncRemoteState) =>
    void runStateMutation(
      `pull-${remote.name}`,
      () => pullSyncRemote({ data: { name: remote.name } }),
      `Pulled ${remote.name}.`,
    );
  const removeRemote = (remote: SyncRemoteState) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove sync remote "${remote.name}"?`)) return;
    void runStateMutation(
      `remove-${remote.name}`,
      () => removeSyncRemote({ data: { name: remote.name } }),
      `Removed ${remote.name}.`,
    );
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
            pendingOperation={pendingOperation()}
            operationError={operationError()}
            operationMessage={operationMessage()}
            remoteForm={remoteForm()}
            onRemoteFormChange={setRemoteForm}
            onRemoteFormReset={() => setRemoteForm(emptyRemoteForm())}
            onRemoteEdit={(remote) => setRemoteForm(remoteFormFrom(remote))}
            onRemoteSave={() => void saveRemote()}
            onRemoteValidate={() => void validateRemote()}
            onRemotePull={pullRemote}
            onRemoteSetEnabled={setRemoteEnabled}
            onRemoteRemove={removeRemote}
            onRefresh={() => void refresh()}
          />
        </Show>
      </div>
    </main>
  );
}
