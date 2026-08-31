<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import type { ProjectSkillMarkdownDocument, SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import type { SkillsManagementOperationEpisodePort } from '../management/operation-episode.svelte';
  import SkillsConfiguration from '../management/skills-configuration.svelte';
  import SkillsConsolidate from '../management/skills-consolidate.svelte';
  import type { SkillsPresentationProjection } from '../presentation';
  import { createSkillsWorktableModel } from '../worktable/model';
  import SkillDrawer from '../worktable/skill-drawer.svelte';
  import SkillsWorktable from '../worktable/skills-worktable.svelte';
  import type { SkillsShellViewModel } from './model';
  import type { SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';

  let {
    editorSlot,
    healthSlot,
    hydrated = false,
    management,
    onSourceChange,
    presentation,
    selectedDocument,
    snapshot,
    snapshotUpdates,
    view,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    healthSlot?: Snippet<[SkillsShellSlotContext]>;
    hydrated?: boolean;
    management: SkillsManagementOperationEpisodePort;
    onSourceChange?: (source: string) => void;
    presentation: SkillsPresentationProjection;
    selectedDocument?: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
    snapshot: SkillManagementSnapshot;
    snapshotUpdates: SkillsSnapshotUpdatePort;
    view: SkillsShellViewModel;
  } = $props();

  $effect(() => onSourceChange?.(snapshot.config.sourceRepoPath ?? 'not configured'));
  const slotContext = $derived({
    document: selectedDocument,
    management,
    presentation,
    snapshot,
    snapshotUpdates,
    view,
  });
  const worktable = $derived(createSkillsWorktableModel({ presentation, view }));
  const closeDrawer = async (): Promise<void> => {
    await goto('/skills', { noScroll: true });
  };

  const page = css({ display: 'grid', gap: '16px', minW: 0 });
  const headline = css({ color: 'muted', fontSize: '12px' });
  const folds = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', '2xl': 'minmax(0, 0.9fr) minmax(360px, 1.1fr)' },
    gap: '16px',
    alignItems: 'start',
  });
</script>

<div class={page} data-skills-hydrated={hydrated} data-skills-workspace>
  <p class={headline} data-skills-headline>{worktable.headline}</p>

  {#if healthSlot}
    <div data-skills-page-actions>{@render healthSlot(slotContext)}</div>
  {/if}

  <SkillsWorktable {management} model={worktable} {presentation} selectedName={presentation.selected.name} />

  <!-- Two folds, not a second page: the runtime copies this product has never adopted, and the
       configuration that decides where the source repository is. Neither is a decision the table
       ranks, and both were reachable only through the retired matrix page. -->
  <div class={folds}>
    <SkillsConsolidate
      groups={presentation.unmanagedGroups}
      total={presentation.health.consolidateCount}
      {...(presentation.unmanagedUsageByName === undefined
        ? {}
        : { usageByName: presentation.unmanagedUsageByName })}
      usageEvidenceComplete={presentation.observations.view?.invocationEvidenceComplete ?? false}
    />
    <SkillsConfiguration context={slotContext} />
  </div>
</div>

<SkillDrawer
  {...(editorSlot === undefined ? {} : { editorSlot })}
  {management}
  onClose={closeDrawer}
  {presentation}
  {selectedDocument}
  {slotContext}
  {view}
/>
