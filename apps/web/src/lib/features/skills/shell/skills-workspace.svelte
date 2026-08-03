<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { meta, panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import type { ProjectSkillMarkdownDocument, SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import type { Snippet } from 'svelte';
  import { type SkillSelection, selectionKey } from '../../../../skills-page-model';
  import { SKILLS_MOBILE_MEDIA_QUERY } from '../../../../skills-responsive';
  import type { SkillsShellViewModel } from './model';
  import SkillsInspector from './skills-inspector.svelte';
  import SkillsTree from './skills-tree.svelte';
  import type { SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';

  let {
    editorSlot,
    healthSlot,
    matrixSlot,
    selectedDocument,
    snapshot,
    snapshotUpdates,
    view,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    healthSlot?: Snippet<[SkillsShellSlotContext]>;
    matrixSlot?: Snippet<[SkillsShellSlotContext]>;
    selectedDocument?: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
    snapshot: SkillManagementSnapshot;
    snapshotUpdates: SkillsSnapshotUpdatePort;
    view: SkillsShellViewModel;
  } = $props();

  const slotContext = $derived({ document: selectedDocument, snapshot, snapshotUpdates, view });
  let filterQuery = $state('');
  let expandedKeys = $state<ReadonlySet<string>>(new Set(['global']));
  let collapsedKeys = $state<ReadonlySet<string>>(new Set());
  let mobilePickerElement = $state<HTMLDetailsElement | undefined>();
  let selectedDetailElement = $state<HTMLElement | undefined>();
  let previousSelectionKey = $state<string | undefined>();
  const activeScopeKey = (selection: SkillSelection): string =>
    selection.type === 'global-scope' || selection.type === 'global-skill'
      ? 'global'
      : selectionKey({ projectPath: selection.projectPath, type: 'project-scope' });
  const toggleScope = (scopeKey: string, isExpanded: boolean): void => {
    const nextExpanded = new Set(expandedKeys);
    const nextCollapsed = new Set(collapsedKeys);
    if (isExpanded) {
      nextExpanded.delete(scopeKey);
      nextCollapsed.add(scopeKey);
    } else {
      nextCollapsed.delete(scopeKey);
      nextExpanded.add(scopeKey);
    }
    expandedKeys = nextExpanded;
    collapsedKeys = nextCollapsed;
  };

  $effect(() => {
    const scopeKey = activeScopeKey(view.selection);
    if (!(expandedKeys.has(scopeKey) || collapsedKeys.has(scopeKey))) {
      expandedKeys = new Set([...expandedKeys, scopeKey]);
    }
  });

  $effect(() => {
    const currentSelectionKey = selectionKey(view.selection);
    if (previousSelectionKey === undefined) {
      previousSelectionKey = currentSelectionKey;
      return;
    }
    if (currentSelectionKey === previousSelectionKey) {
      return;
    }
    previousSelectionKey = currentSelectionKey;
    if (typeof window === 'undefined' || !window.matchMedia(SKILLS_MOBILE_MEDIA_QUERY).matches) {
      return;
    }
    mobilePickerElement?.removeAttribute('open');
    const frame = window.requestAnimationFrame(() => {
      selectedDetailElement?.scrollIntoView({ block: 'start' });
      selectedDetailElement?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  });
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
  const mobilePickerSelection = css({
    minW: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
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
    <SkillsTree
      {collapsedKeys}
      {expandedKeys}
      {filterQuery}
      idPrefix="desktop-skill"
      knownProjects={view.knownProjects}
      model={view.tree}
      onFilterChange={(value) => (filterQuery = value)}
      onScopeToggle={toggleScope}
      selection={view.selection}
    />
  </div>
  <details aria-label="Skill picker" class={cx(panel, mobilePicker)} bind:this={mobilePickerElement}>
    <summary class={mobilePickerSummary}>
      <strong>Browse skills</strong><span class={cx(meta, mobilePickerSelection)}>{view.selectionLabel}</span>
    </summary>
    <div class={mobilePickerBody}>
      <SkillsTree
        ariaLabel="Skill picker scopes"
        {collapsedKeys}
        {expandedKeys}
        {filterQuery}
        idPrefix="mobile-skill"
        knownProjects={view.knownProjects}
        model={view.tree}
        onFilterChange={(value) => (filterQuery = value)}
        onScopeToggle={toggleScope}
        selection={view.selection}
      />
    </div>
  </details>

  <div class={centerStack}>
    {#if view.matrixOpen}
      {#if matrixSlot}
        <div data-skills-matrix-slot>{@render matrixSlot(slotContext)}</div>
      {:else}
        <div class={placeholder}>Skill matrix integration slot</div>
      {/if}
    {:else}
      <section
        aria-label="Selected skill detail"
        class={cx(panel, selectedDetail)}
        tabindex="-1"
        bind:this={selectedDetailElement}
      >
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
      </section>
    {/if}
  </div>

  <div class={mobileContext}>
    <SkillsInspector {healthSlot} {slotContext} {snapshot} {view} />
  </div>
</div>
