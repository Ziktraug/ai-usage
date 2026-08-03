import type { SkillMarkdownDocument, SkillMarkdownSaveResult } from '@ai-usage/web-contract/skills';
import type { StateSubscription } from '../../../foundation/subscription';
import type { SkillsClientResult } from '../../../rpc/skills-client';

export interface SkillMarkdownEditorState {
  readonly conflict: boolean;
  readonly dirty: boolean;
  readonly document: SkillMarkdownDocument | undefined;
  readonly draft: string;
  readonly error: string | null;
  readonly loading: boolean;
  readonly message: string | null;
  readonly saving: boolean;
  readonly skillName: string;
}

export interface SkillMarkdownEditorController extends StateSubscription<SkillMarkdownEditorState> {
  readonly acceptDocument: (document: SkillMarkdownDocument | undefined) => 'accepted' | 'blocked' | 'conflict';
  readonly dirty: StateSubscription<boolean>;
  readonly discardDraft: () => void;
  readonly refresh: () => Promise<void>;
  readonly reportUnexpectedError: (cause: unknown) => void;
  readonly save: () => Promise<void>;
  readonly setDraft: (draft: string) => void;
}

export interface SkillMarkdownEditorDependencies {
  readonly loadMarkdown: (skillName: string) => Promise<SkillsClientResult<SkillMarkdownDocument>>;
  readonly onSaved: (skillName: string, result: SkillsClientResult<SkillMarkdownSaveResult>) => void;
  readonly saveMarkdown: (input: {
    readonly baseSha256: string;
    readonly content: string;
    readonly skillName: string;
  }) => Promise<SkillsClientResult<SkillMarkdownSaveResult>>;
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const savedMessage = (followUpDraft: boolean): string =>
  followUpDraft ? 'SKILL.md saved; newer edits remain unsaved.' : 'SKILL.md saved.';

export const isSkillMarkdownSaveShortcut = (event: Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey'>): boolean =>
  (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';

export const createSkillMarkdownEditorController = (
  dependencies: SkillMarkdownEditorDependencies,
  initialDocument?: SkillMarkdownDocument,
): SkillMarkdownEditorController => {
  let pendingDocument: SkillMarkdownDocument | undefined;
  let generation = 0;
  let state: SkillMarkdownEditorState = {
    conflict: false,
    dirty: false,
    document: initialDocument,
    draft: initialDocument?.content ?? '',
    error: null,
    loading: initialDocument === undefined,
    message: null,
    saving: false,
    skillName: initialDocument?.skillName ?? '',
  };
  const listeners = new Set<(next: SkillMarkdownEditorState) => void>();
  const dirtyListeners = new Set<(dirty: boolean) => void>();

  const publish = (changes: Partial<SkillMarkdownEditorState>): void => {
    const wasDirty = state.dirty;
    state = { ...state, ...changes };
    for (const listener of listeners) {
      listener(state);
    }
    if (state.dirty !== wasDirty) {
      for (const listener of dirtyListeners) {
        listener(state.dirty);
      }
    }
  };

  const acceptDocument = (document: SkillMarkdownDocument | undefined): 'accepted' | 'blocked' | 'conflict' => {
    const changesIdentity =
      document?.skillName !== state.document?.skillName || document?.sha256 !== state.document?.sha256;
    if (document === undefined) {
      if (state.dirty) {
        return 'blocked';
      }
      if (changesIdentity) {
        generation += 1;
      }
      pendingDocument = undefined;
      publish({
        conflict: false,
        document: undefined,
        draft: '',
        error: null,
        loading: true,
        message: null,
        saving: false,
        skillName: '',
      });
      return 'accepted';
    }
    const changesSkill = state.skillName !== '' && document.skillName !== state.skillName;
    const changesRevision = state.document?.sha256 !== document.sha256;
    if (state.dirty && changesSkill) {
      return 'blocked';
    }
    if (state.dirty && !changesRevision) {
      return 'accepted';
    }
    if (state.dirty && changesRevision) {
      generation += 1;
      pendingDocument = document;
      publish({ conflict: true, loading: false, message: 'Changed on disk', saving: false });
      return 'conflict';
    }
    if (changesIdentity) {
      generation += 1;
    }
    pendingDocument = undefined;
    publish({
      conflict: false,
      dirty: false,
      document,
      draft: document.content,
      error: null,
      loading: false,
      message: null,
      saving: false,
      skillName: document.skillName,
    });
    return 'accepted';
  };

  const discardDraft = (): void => {
    const document = pendingDocument ?? state.document;
    pendingDocument = undefined;
    if (document) {
      publish({
        conflict: false,
        dirty: false,
        document,
        draft: document.content,
        message: null,
        skillName: document.skillName,
      });
    }
  };

  const refresh = async (): Promise<void> => {
    if (state.skillName === '' || state.saving) {
      return;
    }
    const requestGeneration = ++generation;
    const skillName = state.skillName;
    publish({ error: null, loading: state.document === undefined, message: null });
    try {
      const result = await dependencies.loadMarkdown(skillName);
      if (requestGeneration !== generation || state.skillName !== skillName) {
        return;
      }
      if (!result.ok) {
        publish({
          ...(state.document === undefined ? { error: result.error.message } : { message: result.error.message }),
          loading: false,
        });
        return;
      }
      acceptDocument(result.data);
    } catch (cause) {
      if (requestGeneration === generation && state.skillName === skillName) {
        const message = errorMessage(cause);
        publish({
          ...(state.document === undefined ? { error: message } : { message }),
          loading: false,
        });
      }
    }
  };

  const save = async (): Promise<void> => {
    const document = state.document;
    if (!(document && state.dirty && !state.saving && !state.conflict)) {
      return;
    }
    const requestGeneration = generation;
    const submittedDraft = state.draft;
    const skillName = state.skillName;
    publish({ message: null, saving: true });
    try {
      const result = await dependencies.saveMarkdown({
        baseSha256: document.sha256,
        content: submittedDraft,
        skillName,
      });
      if (requestGeneration !== generation || state.skillName !== skillName) {
        return;
      }
      if (!result.ok) {
        publish({ message: result.error.message, saving: false });
        return;
      }
      if ('reason' in result.data) {
        publish({
          conflict: result.data.reason === 'conflict',
          message:
            result.data.reason === 'conflict' ? 'Changed on disk' : `Could not save SKILL.md: ${result.data.reason}.`,
          saving: false,
        });
        return;
      }
      if (result.data.document.skillName !== skillName) {
        publish({ message: 'Could not save SKILL.md: server returned a different skill.', saving: false });
        return;
      }
      dependencies.onSaved(skillName, result);
      const followUpDraft = state.draft !== submittedDraft;
      pendingDocument = undefined;
      publish({
        conflict: false,
        dirty: followUpDraft,
        document: result.data.document,
        draft: followUpDraft ? state.draft : result.data.document.content,
        message: savedMessage(followUpDraft),
        saving: false,
      });
    } catch (cause) {
      if (requestGeneration === generation && state.skillName === skillName) {
        publish({ message: errorMessage(cause), saving: false });
      }
    }
  };

  return {
    acceptDocument,
    dirty: {
      getState: () => state.dirty,
      subscribe: (listener) => {
        dirtyListeners.add(listener);
        return () => dirtyListeners.delete(listener);
      },
    },
    discardDraft,
    getState: () => state,
    refresh,
    reportUnexpectedError: (cause) => {
      const message = errorMessage(cause);
      publish({
        ...(state.document === undefined ? { error: message } : { message }),
        loading: false,
        saving: false,
      });
    },
    save,
    setDraft: (draft) => {
      if (state.document) {
        publish({ dirty: draft !== state.document.content, draft, message: null });
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
