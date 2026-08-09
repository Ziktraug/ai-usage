import type { SkillMarkdownDocument, SkillMarkdownSaveResult } from '@ai-usage/web-contract/skills';
import type { QueryClient } from '@tanstack/svelte-query';
import {
  applyManagedMarkdownSaveToCache,
  managedSkillMarkdownKey,
  skillsSnapshotKey,
} from '../../../query/options/skills';
import type { SkillsClient, SkillsClientResult } from '../../../rpc/skills-client';
import type { DirtyGuardRegistry } from '../../shell/dirty-navigation-context';
import type { SkillsSnapshotUpdatePort } from '../shell/slot-context';
import { createSkillMarkdownEditorController, type SkillMarkdownEditorController } from './controller';

export interface SkillsEditorSlotController {
  readonly editor: SkillMarkdownEditorController;
  readonly mount: () => () => void;
  readonly setFocus: (focus: () => void) => void;
  readonly synchronizeDocument: (document: SkillMarkdownDocument | undefined) => void;
}

export const createSkillsEditorSlotController = (options: {
  readonly client: Pick<SkillsClient, 'getManagedSkillMarkdown' | 'saveManagedSkillMarkdown'>;
  readonly dirtyRegistry: DirtyGuardRegistry;
  readonly document: SkillMarkdownDocument | undefined;
  readonly queryClient: QueryClient;
  readonly snapshotUpdates: SkillsSnapshotUpdatePort;
}): SkillsEditorSlotController => {
  let focusEditor = (): void => undefined;
  const editor = createSkillMarkdownEditorController(
    {
      loadMarkdown: async (skillName) => {
        const result = await options.client.getManagedSkillMarkdown(skillName);
        if (result.ok) {
          options.queryClient.setQueryData(managedSkillMarkdownKey(skillName), result.data);
        }
        return result;
      },
      onSaved: (skillName: string, result: SkillsClientResult<SkillMarkdownSaveResult>): void => {
        if (!applyManagedMarkdownSaveToCache(options.queryClient, skillName, result)) {
          return;
        }
        if (result.ok && 'snapshot' in result.data) {
          options.queryClient.setQueryData(skillsSnapshotKey(), result.data.snapshot);
        }
      },
      saveMarkdown: async (input) => await options.client.saveManagedSkillMarkdown(input),
    },
    options.document,
  );
  const guard = {
    discard: (): void => editor.discardDraft(),
    get dirty(): boolean {
      return editor.getState().dirty;
    },
    focus: (): void => focusEditor(),
    get skillName(): string {
      return editor.getState().skillName;
    },
  };
  let mounted = false;

  return {
    editor,
    mount: () => {
      if (mounted) {
        throw new Error('The Skills editor slot is already mounted');
      }
      mounted = true;
      options.snapshotUpdates.registerDraft(guard);
      const stopDirtyGuard = options.dirtyRegistry.register({
        dirty: editor.dirty,
        discard: guard.discard,
        focus: guard.focus,
      });
      let disposed = false;
      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        mounted = false;
        stopDirtyGuard();
        options.snapshotUpdates.unregisterDraft(guard);
      };
    },
    setFocus: (focus) => {
      focusEditor = focus;
    },
    synchronizeDocument: (document) => {
      editor.acceptDocument(document);
    },
  };
};
