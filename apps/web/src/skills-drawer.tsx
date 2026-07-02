import { Drawer } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import {
  commandButton,
  drawer,
  drawerBody,
  drawerClose,
  drawerTitle,
  drawerTop,
  ghostButton,
  HarnessBadge,
  meta,
  muted,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { Projection, SkillDiagnostic, SkillManagementSnapshot, SourceSkill } from '@ai-usage/skills';
import { createEffect, createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { getManagedSkillMarkdown, saveManagedSkillMarkdown } from './server/skills';
import { projectionStateLabel, skillInvocation } from './skills-page-model';

type SkillMarkdownResult =
  | { ok: true; data: { content: string; path: string; sha256: string; skillName: string } }
  | { ok: false; error: { message: string; tag: string } };

type SkillMarkdownSaveResult =
  | {
      ok: true;
      data: {
        document?: { content: string; path: string; sha256: string; skillName: string };
        reason?: 'conflict' | 'not-found' | 'too-large';
        snapshot?: SkillManagementSnapshot;
      };
    }
  | { ok: false; error: { message: string; tag: string } };

const section = css({
  display: 'grid',
  gap: '8px',
});

const badgeRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
});

const inlineActionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

const busyButton = css({
  '&[data-pending=true]': {
    _after: {
      content: '" ..."',
      color: 'accent',
    },
  },
});

const exposureRow = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'auto minmax(0, 1fr) auto' },
  gap: '8px 10px',
  alignItems: 'start',
  p: '10px 0',
  borderTop: '1px solid token(colors.line)',
});

const pathText = css({
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'muted',
  overflowWrap: 'anywhere',
});

const stateOk = css({ color: 'status.ok' });
const stateWarn = css({ color: 'status.warn' });
const stateDanger = css({ color: 'status.danger' });

const editorBlock = css({
  maxH: '360px',
  overflow: 'auto',
  p: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  fontFamily: 'mono',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
});

const editorArea = css({
  minH: '280px',
  w: '100%',
  p: '10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '12px',
  resize: 'vertical',
});

const saveBar = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

const diagnosticRow = css({
  display: 'grid',
  gap: '3px',
  p: '8px 0',
  borderTop: '1px solid token(colors.line)',
});

const validationPillClass = (status: string) => {
  if (status === 'invalid') {
    return statusPillDanger;
  }
  if (status === 'warning') {
    return statusPillWarn;
  }
  return statusPillOk;
};

const diagnosticPillClass = (diagnostic: SkillDiagnostic) => {
  if (diagnostic.severity === 'error') {
    return statusPillDanger;
  }
  if (diagnostic.severity === 'warning') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

const exposureStateClass = (projection: Projection) => {
  if (projection.state === 'linked') {
    return stateOk;
  }
  if (projection.state === 'missing') {
    return stateWarn;
  }
  if (
    projection.state === 'broken-link' ||
    projection.state === 'wrong-target' ||
    projection.state === 'missing-target'
  ) {
    return stateDanger;
  }
  return muted;
};

const canReconcileProjection = (projection: Projection) =>
  projection.state === 'missing' || projection.state === 'broken-link' || projection.state === 'wrong-target';

const divergentActualPath = (projection: Projection) => {
  if (
    projection.state !== 'wrong-target' &&
    projection.state !== 'unmanaged-symlink' &&
    projection.state !== 'unmanaged-copy'
  ) {
    return;
  }
  if (projection.actualPath === undefined || projection.actualPath === projection.expectedPath) {
    return;
  }
  return projection.actualPath;
};

export const SkillsDrawer = (props: {
  finalFocusEl: () => HTMLElement | null;
  onClose: () => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  pendingOperation: string | null;
  reconcileSkill: (skillName: string) => void;
  skill: SourceSkill;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  let closeButton: HTMLButtonElement | undefined;
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [message, setMessage] = createSignal<string | null>(null);
  const [document, { mutate, refetch }] = createResource(
    () => props.skill.name,
    async (skillName) => (await getManagedSkillMarkdown({ data: skillName })) as SkillMarkdownResult,
  );
  // Match the matrix and health counters: only enabled runtimes are shown.
  // Disabled-runtime projections (e.g. missing-target on Cursor) are noise here.
  const enabledTargetIds = createMemo(
    () => new Set(props.snapshot.targets.filter((target) => target.enabled).map((target) => target.id)),
  );
  const projections = createMemo(() =>
    props.snapshot.projections.filter(
      (projection) => projection.skillName === props.skill.name && enabledTargetIds().has(projection.targetId),
    ),
  );
  const markdownDocument = createMemo(() => {
    const current = document();
    return current?.ok ? current.data : undefined;
  });
  const markdownError = createMemo(() => {
    const current = document();
    return current?.ok === false ? current.error.message : 'SKILL.md unavailable.';
  });

  createEffect(() => {
    const current = markdownDocument();
    if (current && !editing()) {
      setDraft(current.content);
    }
  });

  const saveMarkdown = async () => {
    const current = markdownDocument();
    if (!current) {
      return;
    }
    setMessage(null);
    const result = (await saveManagedSkillMarkdown({
      data: { baseSha256: current.sha256, content: draft(), skillName: props.skill.name },
    })) as SkillMarkdownSaveResult;
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    if (result.data.reason === 'conflict') {
      setMessage('File changed on disk — reload the skill and reapply your edit.');
      return;
    }
    if (result.data.reason) {
      setMessage(`Could not save SKILL.md: ${result.data.reason}.`);
      return;
    }
    if (result.data.document) {
      mutate({ ok: true, data: result.data.document });
      setDraft(result.data.document.content);
    } else {
      await refetch();
    }
    if (result.data.snapshot) {
      props.onSnapshot(result.data.snapshot);
    }
    setEditing(false);
    setMessage('SKILL.md saved.');
  };

  return (
    <Drawer
      closeOnInteractOutside
      contentAriaLabel="Skill details"
      contentClass={drawer}
      finalFocusEl={props.finalFocusEl}
      initialFocusEl={() => closeButton ?? null}
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      open
      trapFocus={false}
    >
      <div class={drawerTop}>
        <div>
          <div class={drawerTitle}>{props.skill.name}</div>
          <div class={pathText}>
            {props.snapshot.config.sourceRepoPath}/skills/{props.skill.name}
          </div>
        </div>
        <button
          aria-label="Close skill details"
          class={drawerClose}
          onClick={() => props.onClose()}
          ref={(element) => {
            closeButton = element;
          }}
          type="button"
        >
          ×
        </button>
      </div>
      <div class={drawerBody}>
        <div class={section}>
          <div class={badgeRow}>
            <span class={cx(statusPill, validationPillClass(props.skill.validationStatus))}>
              {props.skill.validationStatus}
            </span>
            <span class={cx(statusPill, statusPillInfo)}>
              {skillInvocation(props.skill) === 'auto' ? 'Auto' : 'Manual'}
            </span>
            <Show when={props.skill.tokenCount}>
              {(tokenCount) => <span class={cx(statusPill, statusPillInfo)}>{tokenCount().total} tok</span>}
            </Show>
            <span class={cx(statusPill, statusPillInfo)}>Global</span>
          </div>
          <p class={muted}>{props.skill.description || 'No description'}</p>
          <div class={inlineActionRow}>
            <button
              aria-busy={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
              class={cx(ghostButton, busyButton)}
              data-pending={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
              disabled={props.pendingOperation !== null}
              onClick={() => props.toggleSkill(props.skill.name, !props.skill.enabled)}
              type="button"
            >
              {props.skill.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>

        <section class={section}>
          <h3 class={strongCell}>Exposure</h3>
          <For each={projections()}>
            {(projection) => {
              const target = () => props.snapshot.targets.find((entry) => entry.id === projection.targetId);
              return (
                <div class={exposureRow}>
                  <HarnessBadge name={target()?.label ?? projection.targetId} />
                  <div>
                    <div class={cx(strongCell, exposureStateClass(projection))}>
                      {projectionStateLabel(projection.state)}
                    </div>
                    <div class={pathText}>{projection.expectedPath}</div>
                    <Show when={divergentActualPath(projection)}>
                      {(actualPath) => <div class={pathText}>Actual: {actualPath()}</div>}
                    </Show>
                    <Show when={projection.state === 'unmanaged-copy'}>
                      <div class={meta}>
                        Unmanaged copy - reconcile will never overwrite it. Adopt or remove it manually.
                      </div>
                    </Show>
                  </div>
                  <Show when={canReconcileProjection(projection)}>
                    <button
                      aria-busy={props.pendingOperation === `reconcile:${props.skill.name}` ? 'true' : undefined}
                      class={cx(ghostButton, busyButton)}
                      data-pending={props.pendingOperation === `reconcile:${props.skill.name}` ? 'true' : undefined}
                      disabled={props.pendingOperation !== null}
                      onClick={() => props.reconcileSkill(props.skill.name)}
                      type="button"
                    >
                      Reconcile
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
        </section>

        <section class={section}>
          <h3 class={strongCell}>SKILL.MD</h3>
          <Show fallback={<p class={meta}>Loading SKILL.md…</p>} when={!document.loading}>
            <Show fallback={<p class={meta}>{markdownError()}</p>} when={markdownDocument()}>
              {(current) => (
                <Show
                  fallback={
                    <>
                      <pre class={editorBlock}>{current().content}</pre>
                      <button class={ghostButton} onClick={() => setEditing(true)} type="button">
                        Edit
                      </button>
                    </>
                  }
                  when={editing()}
                >
                  <textarea
                    class={editorArea}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    value={draft()}
                  />
                  <div class={saveBar}>
                    <button class={commandButton} onClick={saveMarkdown} type="button">
                      Save
                    </button>
                    <button
                      class={ghostButton}
                      onClick={() => {
                        setDraft(current().content);
                        setEditing(false);
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                    <span class={meta}>Writes to the source repository only — never into runtime folders.</span>
                  </div>
                </Show>
              )}
            </Show>
          </Show>
          <Show when={message()}>{(value) => <p class={meta}>{value()}</p>}</Show>
        </section>

        <Show when={props.skill.diagnostics.length > 0}>
          <section class={section}>
            <h3 class={strongCell}>Diagnostics</h3>
            <For each={props.skill.diagnostics}>
              {(diagnostic) => (
                <div class={diagnosticRow}>
                  <span class={cx(statusPill, diagnosticPillClass(diagnostic))}>{diagnostic.severity}</span>
                  <div class={strongCell}>{diagnostic.code}</div>
                  <div class={meta}>{diagnostic.message}</div>
                </div>
              )}
            </For>
          </section>
        </Show>
      </div>
    </Drawer>
  );
};
