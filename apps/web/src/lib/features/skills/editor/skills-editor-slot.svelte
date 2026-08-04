<script lang="ts">
  import type { SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
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
  let browserClient: ReturnType<typeof createSkillsClient> | undefined;
  const resolveClient = (): ReturnType<typeof createSkillsClient> => {
    browserClient ??= createSkillsClient(createBrowserWebRpcClient('skills-editor').skills);
    return browserClient;
  };
  const queryClient = useQueryClient();
  const initialContext = untrack(() => context);
  const slot = createSkillsEditorSlotController({
    client: {
      getManagedSkillMarkdown: async (skillName) => await resolveClient().getManagedSkillMarkdown(skillName),
      saveManagedSkillMarkdown: async (input) => await resolveClient().saveManagedSkillMarkdown(input),
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
