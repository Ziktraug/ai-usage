<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { meta, panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import type { ProjectSkillMarkdownDocument, SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import type { Snippet } from 'svelte';
  import type { SkillsShellViewModel } from './model';
  import SkillsInspector from './skills-inspector.svelte';
  import SkillsTree from './skills-tree.svelte';

  export interface SkillsShellSlotContext {
    readonly document: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
    readonly snapshot: SkillManagementSnapshot;
    readonly view: SkillsShellViewModel;
  }

  let {
    editorSlot,
    healthSlot,
    matrixSlot,
    selectedDocument,
    snapshot,
    view,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    healthSlot?: Snippet<[SkillsShellViewModel]>;
    matrixSlot?: Snippet<[SkillsShellSlotContext]>;
    selectedDocument?: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
    snapshot: SkillManagementSnapshot;
    view: SkillsShellViewModel;
  } = $props();

  const slotContext = $derived({ document: selectedDocument, snapshot, view });
  const workspaceGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', lg: '240px minmax(0, 1fr)', xl: '240px minmax(0, 1fr) 288px' },
    gap: '16px',
    alignItems: 'start',
  });
  const centerStack = css({ display: 'grid', gap: '16px', minW: 0 });
  const desktopTree = css({ display: { base: 'none', lg: 'block' } });
  const mobilePicker = css({ display: { base: 'block', lg: 'none' }, p: 0, overflow: 'hidden' });
  const mobilePickerSummary = css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    p: '12px 14px',
    cursor: 'pointer',
  });
  const mobilePickerBody = css({ maxH: '70vh', overflow: 'auto', p: '0 10px 10px' });
  const selectedDetail = css({ minW: 0, scrollMarginTop: '12px' });
  const detailStack = css({ display: 'grid', gap: '14px', minW: 0 });
  const detailHeader = css({ display: 'grid', gap: '5px' });
  const detailTitle = css({ fontSize: { base: '22px', md: '28px' }, fontWeight: 750, overflowWrap: 'anywhere' });
  const placeholder = css({
    display: 'grid',
    minH: '220px',
    placeItems: 'center',
    p: '18px',
    border: '1px dashed token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
  });
  const preview = css({
    maxH: '460px',
    overflow: 'auto',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    fontFamily: 'mono',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
  });
  const mobileContext = css({ display: { base: 'block', xl: 'contents' }, gridColumn: { lg: '2', xl: 'auto' } });
</script>

<div class={workspaceGrid} data-skills-workspace>
  <div class={desktopTree}>
    <SkillsTree knownProjects={view.knownProjects} model={view.tree} selection={view.selection} />
  </div>
  <details aria-label="Skill picker" class={cx(panel, mobilePicker)}>
    <summary class={mobilePickerSummary}>
      <span><strong>{view.selectionLabel}</strong><span class={meta}> · Select a skill</span></span
      ><span aria-hidden="true">▾</span>
    </summary>
    <div class={mobilePickerBody}>
      <SkillsTree
        idPrefix="mobile-skill"
        knownProjects={view.knownProjects}
        model={view.tree}
        selection={view.selection}
      />
    </div>
  </details>

  <section aria-label="Selected skill" class={centerStack}>
    {#if view.matrixOpen}
      {#if matrixSlot}
        <div data-skills-matrix-slot>{@render matrixSlot(slotContext)}</div>
      {:else}
        <div class={placeholder}>Skill matrix integration slot</div>
      {/if}
    {:else}
      <article class={cx(panel, selectedDetail)} tabindex="-1">
        <div class={detailStack}>
          <header class={detailHeader}>
            <p class={panelSub}>
              {#if view.selectionDetail.kind === 'global-scope'}
                Global source overview
              {:else if view.selectionDetail.kind === 'global-skill'}
                Global skill
              {:else if view.selectionDetail.kind === 'project-scope'}
                Project scope
              {:else}
                Project skill · read-only
              {/if}
            </p>
            <h2 class={detailTitle}>{view.selectionLabel}</h2>
          </header>
          {#if view.selectionDetail.kind === 'global-skill'}
            <p>{view.selectionDetail.skill.description || 'No description provided.'}</p>
            {#if editorSlot}
              <div data-skills-editor-slot>{@render editorSlot(slotContext)}</div>
            {:else}
              <div class={placeholder}>SKILL.md editor integration slot</div>
            {/if}
          {:else if view.selectionDetail.kind === 'project-skill'}
            <p>{view.selectionDetail.skill.description || 'No description provided.'}</p>
            {#if selectedDocument && 'truncated' in selectedDocument}
              <pre class={preview}>{selectedDocument.content}</pre>
            {:else}
              <div class={placeholder}>Project SKILL.md preview unavailable</div>
            {/if}
          {:else if view.selectionDetail.kind === 'project-scope'}
            <p class={meta}>{view.selectionDetail.project.path}</p>
            <p>{view.selectionDetail.inventories.length} scanned project inventories.</p>
          {:else}
            <h3 class={panelTitle}>Choose a skill</h3>
            <p class={panelSub}>Select a global skill to edit its SKILL.md or inspect a project scope.</p>
          {/if}
        </div>
      </article>
    {/if}
  </section>

  <div class={mobileContext}>
    <SkillsInspector {healthSlot} {snapshot} {view} />
  </div>
</div>
