<script lang="ts">
  import type { SaveSkillMarkdownInput, SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';
  import { fetchManagedSkillMarkdown, skillsMutationOptions } from '../../../query/options/skills';
  import { useOptionalWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import { useDirtyGuardRegistry } from '../../shell/dirty-navigation-context';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import DiscardConfirmationDialog from './discard-confirmation-dialog.svelte';
  import SkillMarkdownEditor from './skill-markdown-editor.svelte';
  import { createSkillsEditorSlotController } from './slot-controller';

  let { context }: { context: SkillsShellSlotContext } = $props();

  const managedDocument = (): SkillMarkdownDocument | undefined => {
    const document = context.document;
    return document && 'sha256' in document ? document : undefined;
  };
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  let browserClient: ReturnType<typeof createSkillsClient> | undefined;
  const resolveClient = (): ReturnType<typeof createSkillsClient> => {
    if (!rpc) {
      throw new Error('The shared browser RPC context is unavailable.');
    }
    browserClient ??= createSkillsClient(rpc.skills);
    return browserClient;
  };
  const queryClient = useQueryClient();
  const saveMutation = createMutation(() =>
    skillsMutationOptions('save-managed-markdown', async (input: SaveSkillMarkdownInput) => {
      const result = await resolveClient().saveManagedSkillMarkdown(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result;
    }),
  );
  const initialContext = untrack(() => context);
  const slot = createSkillsEditorSlotController({
    client: {
      getManagedSkillMarkdown: async (skillName) => {
        try {
          return {
            data: await fetchManagedSkillMarkdown(queryClient, resolveClient(), skillName),
            ok: true as const,
          };
        } catch (error) {
          return {
            error: {
              message: error instanceof Error ? error.message : 'Skills are unavailable.',
              tag: 'Unavailable',
            },
            ok: false as const,
          };
        }
      },
      saveManagedSkillMarkdown: async (input) => await saveMutation.mutateAsync(input),
    },
    dirtyRegistry: useDirtyGuardRegistry(),
    document: untrack(managedDocument),
    queryClient,
    snapshotUpdates: initialContext.snapshotUpdates,
  });
  const pendingDecision = $derived(context.snapshotUpdates.pendingDecision);

  $effect(() => {
    slot.synchronizeDocument(managedDocument());
  });
  onMount(slot.mount);

  const keepPendingSnapshot = (): void => {
    const decision = context.snapshotUpdates.pendingDecision;
    decision?.keep();
    decision?.focus();
  };
  const discardPendingSnapshot = async (): Promise<void> => {
    await context.snapshotUpdates.pendingDecision?.discard();
  };
</script>

<SkillMarkdownEditor controller={slot.editor} onFocusReady={slot.setFocus} />
<DiscardConfirmationDialog
  description="The refreshed snapshot no longer contains this skill. Keep editing to preserve the draft, or discard it to apply the refreshed snapshot."
  idPrefix="discard-dirty-snapshot"
  onDiscard={discardPendingSnapshot}
  onKeep={keepPendingSnapshot}
  open={pendingDecision !== undefined}
/>
