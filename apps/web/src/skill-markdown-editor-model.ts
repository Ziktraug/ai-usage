import type { SkillManagementSnapshot, SkillMarkdownDocument } from '@ai-usage/skills';
import type { SkillMarkdownSaveResult as SkillMarkdownSaveData, SkillsServerResult } from './server/skills-contracts';

export type SkillMarkdownDocumentResult = SkillsServerResult<SkillMarkdownDocument>;

export type SkillMarkdownSaveResult = SkillsServerResult<SkillMarkdownSaveData>;

export interface SkillMarkdownEditorState {
  conflict: boolean;
  dirty: boolean;
  document: SkillMarkdownDocument | undefined;
  draft: string;
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
  getState: () => SkillMarkdownEditorState;
  reload: () => Promise<boolean>;
  reportUnexpectedError: (error: unknown) => void;
  revertDraft: () => void;
  save: () => Promise<void>;
  select: (skillName: string) => Promise<boolean>;
  setDraft: (draft: string) => void;
  subscribe: (listener: (state: SkillMarkdownEditorState) => void) => () => void;
}

const clientErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const runSkillMarkdownEditorAction = async (
  controller: SkillMarkdownEditorController,
  action: () => Promise<unknown>,
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
    conflict: false,
    dirty: false,
    document: undefined,
    draft: '',
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

  const load = async (skillName: string): Promise<boolean> => {
    selectionVersion += 1;
    const requestVersion = selectionVersion;
    update({
      conflict: false,
      dirty: false,
      document: undefined,
      draft: '',
      error: null,
      loading: true,
      message: null,
      saving: false,
      skillName,
    });

    try {
      const result = await dependencies.loadMarkdown(skillName);
      if (requestVersion !== selectionVersion) {
        return true;
      }
      if (!result.ok) {
        update({ error: result.error.message, loading: false });
        return true;
      }
      update({ document: result.data, draft: result.data.content, loading: false });
    } catch (error) {
      if (requestVersion === selectionVersion) {
        update({ error: clientErrorMessage(error), loading: false });
      }
    }
    return true;
  };

  const select = (skillName: string): Promise<boolean> => {
    if (skillName === state.skillName && state.document !== undefined) {
      return Promise.resolve(true);
    }
    if (state.dirty) {
      return Promise.resolve(false);
    }
    return load(skillName);
  };

  const reload = (): Promise<boolean> => {
    if (state.dirty || state.skillName === '') {
      return Promise.resolve(false);
    }
    return load(state.skillName);
  };

  const save = async (): Promise<void> => {
    const currentDocument = state.document;
    if (currentDocument === undefined || !state.dirty || state.saving) {
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
          conflict: true,
          message: 'Changed on disk',
          saving: false,
        });
        return;
      }
      if (result.data.reason) {
        update({ message: `Could not save SKILL.md: ${result.data.reason}.`, saving: false });
        return;
      }
      const savedDocument = result.data.document;
      if (savedDocument === undefined) {
        update({ message: 'Could not save SKILL.md: server returned no document.', saving: false });
        return;
      }
      if (savedDocument.skillName !== input.skillName) {
        update({ message: 'Could not save SKILL.md: server returned a different skill.', saving: false });
        return;
      }
      update({
        conflict: false,
        dirty: false,
        document: savedDocument,
        draft: savedDocument.content,
        message: 'SKILL.md saved.',
        saving: false,
      });
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
    getState: () => state,
    reportUnexpectedError,
    reload,
    revertDraft: () => {
      if (state.document !== undefined) {
        update({ dirty: false, draft: state.document.content, message: null });
      }
    },
    save,
    select,
    setDraft: (draft) => {
      if (state.document !== undefined && !state.saving) {
        update({ dirty: draft !== state.document.content, draft, message: null });
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
