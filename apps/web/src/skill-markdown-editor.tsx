import { css, cx } from '@ai-usage/design-system/css';
import {
  commandButton,
  ghostButton,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { useBlocker } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { DiscardConfirmationDialog } from './discard-confirmation-dialog';
import { getManagedSkillMarkdown, saveManagedSkillMarkdown } from './server/skills';
import {
  createSkillMarkdownEditorController,
  runSkillMarkdownEditorAction,
  type SkillMarkdownEditorState,
} from './skill-markdown-editor-model';
import type { SkillMarkdownDraftGuard } from './skills-workspace';

const SAVED_MESSAGE = 'SKILL.md saved.';

const editorSection = css({
  display: 'grid',
  gridTemplateAreas: {
    base: '"header" "editor" "actions"',
    md: '"header actions" "editor editor"',
  },
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  columnGap: { base: '12px', md: 0 },
  rowGap: '12px',
  minW: 0,
});

const documentToolbar = css({
  gridArea: 'header',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRightWidth: { base: '1px', md: 0 },
  borderTopLeftRadius: 'sm',
  borderTopRightRadius: { base: 'sm', md: 0 },
  borderBottomRightRadius: { base: 'sm', md: 0 },
  borderBottomLeftRadius: 'sm',
  bg: 'surfaceMuted',
});

const documentActions = css({
  gridArea: 'actions',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  justifyContent: { base: 'flex-start', md: 'flex-end' },
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderTopLeftRadius: { base: 'sm', md: 0 },
  borderTopRightRadius: 'sm',
  borderBottomRightRadius: 'sm',
  borderBottomLeftRadius: { base: 'sm', md: 0 },
  bg: 'surfaceMuted',
});

const editorArea = css({
  gridArea: 'editor',
  boxSizing: 'border-box',
  minH: { base: '60vh', md: 'clamp(480px, 65vh, 900px)' },
  maxW: '100%',
  w: '100%',
  overflowX: 'auto',
  p: '14px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '13px',
  lineHeight: 1.6,
  resize: 'vertical',
  tabSize: 2,
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const loadingBlock = css({
  gridArea: 'editor',
  display: 'grid',
  minH: { base: '60vh', md: 'clamp(480px, 65vh, 900px)' },
  placeItems: 'center',
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});

interface DocumentStatus {
  label: string;
  tone: string;
}

const documentStatus = (state: SkillMarkdownEditorState): DocumentStatus => {
  if (state.loading || (state.document === undefined && state.error === null)) {
    return { label: 'Loading…', tone: statusPillInfo };
  }
  if (state.saving) {
    return { label: 'Saving…', tone: statusPillInfo };
  }
  if (state.conflict) {
    return { label: 'Changed on disk', tone: statusPillDanger };
  }
  if (state.error !== null) {
    return { label: state.error, tone: statusPillDanger };
  }
  if (state.message !== null && state.message !== SAVED_MESSAGE) {
    return { label: state.message, tone: statusPillDanger };
  }
  if (state.dirty) {
    return { label: 'Unsaved changes', tone: statusPillWarn };
  }
  return { label: 'Saved', tone: statusPillOk };
};

export const SkillMarkdownEditor = (props: {
  onDraftStateChange: (guard: SkillMarkdownDraftGuard | undefined) => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  refreshVersion: number;
  skillName: string;
}) => {
  const controller = createSkillMarkdownEditorController({
    loadMarkdown: (skillName) => getManagedSkillMarkdown({ data: skillName }),
    onSnapshot: (snapshot) => props.onSnapshot(snapshot),
    saveMarkdown: (input) => saveManagedSkillMarkdown({ data: input }),
  });
  const [editorState, setEditorState] = createSignal(controller.getState());
  const [reloadRequested, setReloadRequested] = createSignal(false);
  let editorElement: HTMLTextAreaElement | undefined;
  const unsubscribe = controller.subscribe((state) => setEditorState(state));
  onCleanup(unsubscribe);

  const focusEditor = (): void => {
    editorElement?.focus();
  };

  createEffect(() => {
    props.onDraftStateChange({
      discard: controller.revertDraft,
      dirty: editorState().dirty,
      focus: focusEditor,
      skillName: props.skillName,
    });
  });
  onCleanup(() => props.onDraftStateChange(undefined));

  const navigationBlocker = useBlocker({
    enableBeforeUnload: () => editorState().dirty,
    shouldBlockFn: () => editorState().dirty,
    withResolver: true,
  });

  createEffect(() => {
    runSkillMarkdownEditorAction(controller, () => controller.select(props.skillName)).catch(
      controller.reportUnexpectedError,
    );
  });

  let observedRefreshVersion = props.refreshVersion;
  const reloadFromDisk = async (): Promise<void> => {
    if (editorState().dirty) {
      setReloadRequested(true);
      return;
    }
    await runSkillMarkdownEditorAction(controller, controller.reload);
  };

  const saveDraft = async (): Promise<void> => {
    await runSkillMarkdownEditorAction(controller, controller.save);
  };

  const keepEditing = (): void => {
    setReloadRequested(false);
    const blocker = navigationBlocker();
    if (blocker.status === 'blocked') {
      blocker.reset();
    }
  };

  const discardChanges = async (): Promise<void> => {
    controller.revertDraft();
    setReloadRequested(false);
    const blocker = navigationBlocker();
    if (blocker.status === 'blocked') {
      blocker.proceed();
      return;
    }
    await runSkillMarkdownEditorAction(controller, controller.reload);
  };

  createEffect(() => {
    const refreshVersion = props.refreshVersion;
    if (refreshVersion === observedRefreshVersion) {
      return;
    }
    observedRefreshVersion = refreshVersion;
    reloadFromDisk().catch(controller.reportUnexpectedError);
  });

  const status = createMemo(() => documentStatus(editorState()));
  const statusIsError = createMemo(() => {
    const state = editorState();
    return state.conflict || state.error !== null || (state.message !== null && state.message !== SAVED_MESSAGE);
  });

  return (
    <section
      aria-busy={
        editorState().loading ||
        editorState().saving ||
        (editorState().document === undefined && editorState().error === null)
          ? 'true'
          : undefined
      }
      class={editorSection}
    >
      <div class={documentToolbar}>
        <h3 class={strongCell}>SKILL.md</h3>
        <span
          aria-live={statusIsError() ? undefined : 'polite'}
          class={cx(statusPill, status().tone)}
          role={statusIsError() ? 'alert' : undefined}
        >
          {status().label}
        </span>
      </div>
      <Show fallback={<div aria-hidden="true" class={loadingBlock} />} when={editorState().document}>
        <textarea
          aria-label={`${editorState().skillName} SKILL.md`}
          class={editorArea}
          disabled={editorState().saving}
          onInput={(event) => controller.setDraft(event.currentTarget.value)}
          onKeyDown={async (event) => {
            const saveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
            if (!saveShortcut) {
              return;
            }
            event.preventDefault();
            if (!(editorState().dirty && !editorState().saving && !editorState().conflict)) {
              return;
            }
            await saveDraft();
          }}
          ref={(element) => {
            editorElement = element;
          }}
          value={editorState().draft}
          wrap="off"
        />
      </Show>
      <div class={documentActions}>
        <button
          aria-busy={editorState().saving ? 'true' : undefined}
          class={commandButton}
          disabled={
            editorState().document === undefined ||
            !editorState().dirty ||
            editorState().loading ||
            editorState().saving ||
            editorState().conflict
          }
          onClick={saveDraft}
          type="button"
        >
          Save
        </button>
        <button
          class={ghostButton}
          disabled={!editorState().dirty || editorState().loading || editorState().saving}
          onClick={controller.revertDraft}
          type="button"
        >
          Revert changes
        </button>
        <button
          class={ghostButton}
          disabled={editorState().loading || editorState().saving || editorState().skillName === ''}
          onClick={reloadFromDisk}
          type="button"
        >
          Reload from disk
        </button>
      </div>
      <Show when={reloadRequested() || navigationBlocker().status === 'blocked'}>
        <DiscardConfirmationDialog
          description="Your SKILL.md draft has not been saved. Discarding it cannot be undone."
          idPrefix="discard-skill-draft"
          onDiscard={discardChanges}
          onKeep={keepEditing}
          restoreFocus={focusEditor}
        />
      </Show>
    </section>
  );
};
