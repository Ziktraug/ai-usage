<script lang="ts">
  import type { SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import { untrack } from 'svelte';
  import { createSkillMarkdownEditorController } from './controller';
  import DiscardConfirmationDialog from './discard-confirmation-dialog.svelte';
  import SkillMarkdownEditor from './skill-markdown-editor.svelte';

  let {
    mode = 'settled',
    showDialog = false,
  }: {
    mode?: 'conflict' | 'dirty' | 'loading' | 'settled';
    showDialog?: boolean;
  } = $props();
  const document = (content: string, sha256: string): SkillMarkdownDocument => ({
    content,
    path: '/synthetic/alpha-skill/SKILL.md',
    sha256,
    skillName: 'alpha-skill',
  });
  const fixtureMode = untrack(() => mode);
  const initial = fixtureMode === 'loading' ? undefined : document('# Alpha synthetic editor\n', 'a'.repeat(64));
  const controller = createSkillMarkdownEditorController(
    {
      loadMarkdown: () => Promise.resolve({ data: document('# Refreshed\n', 'b'.repeat(64)), ok: true }),
      onSaved: () => undefined,
      saveMarkdown: () =>
        Promise.resolve({
          data: { document: document('# Saved\n', 'c'.repeat(64)), snapshot: {} as never },
          ok: true as const,
        }),
    },
    initial,
  );
  if (fixtureMode === 'dirty' || fixtureMode === 'conflict') {
    controller.setDraft('# Exact synthetic draft\n');
  }
  if (fixtureMode === 'conflict') {
    controller.acceptDocument(document('# Changed on disk\n', 'd'.repeat(64)));
  }
</script>

<SkillMarkdownEditor {controller} />
<DiscardConfirmationDialog
  description="Synthetic pending draft decision."
  idPrefix="synthetic-discard"
  onDiscard={() => undefined}
  onKeep={() => undefined}
  open={showDialog}
/>
