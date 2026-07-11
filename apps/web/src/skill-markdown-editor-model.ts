import type { SkillManagementSnapshot, SkillMarkdownDocument } from '@ai-usage/skills';
import type { SkillMarkdownSaveResult as SkillMarkdownSaveData, SkillsServerResult } from './server/skills.server';

export type SkillMarkdownDocumentResult = SkillsServerResult<SkillMarkdownDocument>;

export type SkillMarkdownSaveResult = SkillsServerResult<SkillMarkdownSaveData>;

export interface SkillMarkdownEditorState {
  document: SkillMarkdownDocument | undefined;
  draft: string;
  editing: boolean;
  error: string | null;
  loading: boolean;
  message: string | null;
  saving: boolean;
  skillName: string;
}

interface SkillMarkdownEditorDependencies {
  loadMarkdown: (skillName: string) => Promise<SkillMarkdownDocumentResult>;
  onSnapshot?: (snapshot: SkillManagementSnapshot) => void;
  saveMarkdown: (input: { baseSha256: string; content: string; skillName: string }) => Promise<SkillMarkdownSaveResult>;
}

export interface SkillMarkdownEditorController {
  cancelEditing: () => void;
  getState: () => SkillMarkdownEditorState;
  reportUnexpectedError: (error: unknown) => void;
  save: () => Promise<void>;
  select: (skillName: string) => Promise<void>;
  setDraft: (draft: string) => void;
  startEditing: () => void;
  subscribe: (listener: (state: SkillMarkdownEditorState) => void) => () => void;
}

const clientErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const runSkillMarkdownEditorAction = async (
  controller: SkillMarkdownEditorController,
  action: () => Promise<void>,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    controller.reportUnexpectedError(error);
  }
};

export const createSkillMarkdownEditorController = (
  dependencies: SkillMarkdownEditorDependencies,
): SkillMarkdownEditorController => {
  let selectionVersion = 0;
  let state: SkillMarkdownEditorState = {
    document: undefined,
    draft: '',
    editing: false,
    error: null,
    loading: false,
    message: null,
    saving: false,
    skillName: '',
  };
  const listeners = new Set<(nextState: SkillMarkdownEditorState) => void>();

  const update = (nextState: Partial<SkillMarkdownEditorState>) => {
    state = { ...state, ...nextState };
    for (const listener of listeners) {
      listener(state);
    }
  };

  const select = async (skillName: string): Promise<void> => {
    selectionVersion += 1;
    const requestVersion = selectionVersion;
    update({
      document: undefined,
      draft: '',
      editing: false,
      error: null,
      loading: true,
      message: null,
      saving: false,
      skillName,
    });

    try {
      const result = await dependencies.loadMarkdown(skillName);
      if (requestVersion !== selectionVersion) {
        return;
      }
      if (!result.ok) {
        update({ error: result.error.message, loading: false });
        return;
      }
      update({ document: result.data, draft: result.data.content, loading: false });
    } catch (error) {
      if (requestVersion === selectionVersion) {
        update({ error: clientErrorMessage(error), loading: false });
      }
    }
  };

  const save = async (): Promise<void> => {
    const currentDocument = state.document;
    if (!(state.editing && currentDocument) || state.saving) {
      return;
    }

    const requestVersion = selectionVersion;
    const input = {
      baseSha256: currentDocument.sha256,
      content: state.draft,
      skillName: state.skillName,
    };
    update({ message: null, saving: true });

    try {
      const result = await dependencies.saveMarkdown(input);
      if (requestVersion !== selectionVersion) {
        return;
      }
      if (!result.ok) {
        update({ message: result.error.message, saving: false });
        return;
      }
      if (result.data.reason === 'conflict') {
        update({
          message: 'File changed on disk - reload the skill and reapply your edit.',
          saving: false,
        });
        return;
      }
      if (result.data.reason) {
        update({ message: `Could not save SKILL.md: ${result.data.reason}.`, saving: false });
        return;
      }
      const savedDocument = result.data.document;
      if (savedDocument !== undefined && savedDocument.skillName !== input.skillName) {
        update({ message: 'Could not save SKILL.md: server returned a different skill.', saving: false });
        return;
      }
      if (savedDocument === undefined) {
        update({ draft: input.content, editing: false, message: 'SKILL.md saved.', saving: false });
      } else {
        update({
          document: savedDocument,
          draft: savedDocument.content,
          editing: false,
          message: 'SKILL.md saved.',
          saving: false,
        });
      }
      if (result.data.snapshot !== undefined) {
        dependencies.onSnapshot?.(result.data.snapshot);
      }
    } catch (error) {
      if (requestVersion === selectionVersion) {
        update({ message: clientErrorMessage(error), saving: false });
      }
    }
  };

  const reportUnexpectedError = (error: unknown): void => {
    const message = clientErrorMessage(error);
    update({
      ...(state.document === undefined ? { error: message } : { message }),
      loading: false,
      saving: false,
    });
  };

  return {
    cancelEditing: () => {
      if (state.document !== undefined) {
        update({ draft: state.document.content, editing: false, message: null });
      }
    },
    getState: () => state,
    reportUnexpectedError,
    save,
    select,
    setDraft: (draft) => {
      if (state.editing && !state.saving) {
        update({ draft });
      }
    },
    startEditing: () => {
      if (state.document !== undefined) {
        update({ draft: state.document.content, editing: true, message: null });
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
