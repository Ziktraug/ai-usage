<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    meta,
    muted,
    panel,
    panelSub,
    panelTitle,
    statusPill,
    statusPillDanger,
    statusPillInfo,
    statusPillOk,
    statusPillWarn,
    strongCell,
  } from '@ai-usage/design-system/svelte';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import type {
    ProjectSkillMarkdownDocument,
    SkillMarkdownDocument,
    SkillObservations,
  } from '@ai-usage/web-contract/skills';
  import { onDestroy, type Snippet, tick } from 'svelte';
  import {
    buildSkillHealthSummary,
    count,
    globalSkillAttention,
    healthyLinkTone,
    type SkillHealthTone,
    type SkillSelection,
    selectionKey,
  } from '../../../../skills-page-model';
  import { SKILLS_MOBILE_MEDIA_QUERY } from '../../../../skills-responsive';
  import SkillObservationsPanel from '../observations/skill-observations.svelte';
  import {
    createSkillsManagementPlanController,
    type SkillsManagementPlanController,
  } from './management-plan-controller';
  import type { SkillsShellViewModel } from './model';
  import SelectionLink from './selection-link.svelte';
  import SkillsInspector from './skills-inspector.svelte';
  import SkillsTree from './skills-tree.svelte';
  import type { SkillsHealthSlotPlacement, SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';

  let {
    editorSlot,
    healthSlot,
    hydrated = false,
    matrixSlot,
    observations,
    observationsError,
    onSourceChange,
    selectedDocument,
    snapshot,
    snapshotUpdates,
    view,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    healthSlot?: Snippet<[SkillsShellSlotContext, SkillsManagementPlanController, SkillsHealthSlotPlacement]>;
    hydrated?: boolean;
    matrixSlot?: Snippet<[SkillsShellSlotContext, SkillsManagementPlanController]>;
    observations?: SkillObservations | undefined;
    observationsError?: string | undefined;
    onSourceChange?: (source: string) => void;
    selectedDocument?: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
    snapshot: SkillManagementSnapshot;
    snapshotUpdates: SkillsSnapshotUpdatePort;
    view: SkillsShellViewModel;
  } = $props();

  const managementPlan = createSkillsManagementPlanController();
  const ATTENTION_SKILL_LIMIT = 6;
  $effect(() => onSourceChange?.(snapshot.config.sourceRepoPath ?? 'not configured'));
  const slotContext = $derived({
    document: selectedDocument,
    observations,
    observationsError,
    snapshot,
    snapshotUpdates,
    view,
  });
  const health = $derived(buildSkillHealthSummary(snapshot));
  const attentionSkills = $derived(
    snapshot.skills
      .map((skill) => ({ attention: globalSkillAttention(snapshot, skill), skill }))
      .filter(
        (entry) => entry.attention.issueCount > 0 || entry.skill.validationStatus !== 'valid' || !entry.skill.enabled,
      )
      .sort((left, right) => {
        if (left.attention.issueCount !== right.attention.issueCount) {
          return right.attention.issueCount - left.attention.issueCount;
        }
        return left.skill.name.localeCompare(right.skill.name);
      })
      .slice(0, ATTENTION_SKILL_LIMIT),
  );
  const attentionPillClass = (enabled: boolean, validationStatus: string, issueCount: number): string => {
    if (!enabled) {
      return statusPillInfo;
    }
    if (validationStatus === 'invalid') {
      return statusPillDanger;
    }
    return issueCount > 0 ? statusPillWarn : statusPillInfo;
  };
  const attentionPillText = (enabled: boolean, validationStatus: string, issueCount: number): string => {
    if (!enabled) {
      return 'disabled';
    }
    if (validationStatus === 'invalid') {
      return 'invalid';
    }
    return count(issueCount, 'issue');
  };
  let filterQuery = $state('');
  let expandedKeys = $state<ReadonlySet<string>>(new Set(['global']));
  let collapsedKeys = $state<ReadonlySet<string>>(new Set());
  let mobilePickerElement = $state<HTMLDetailsElement | undefined>();
  let selectedDetailElement = $state<HTMLElement | undefined>();
  let previousSelectionKey: string | undefined;
  let mobileFocusFrame: number | undefined;
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    if (mobileFocusFrame !== undefined) {
      window.cancelAnimationFrame(mobileFocusFrame);
    }
  });
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
  const focusSelectedMobileDetail = async (): Promise<void> => {
    await tick();
    if (destroyed) {
      return;
    }
    if (mobileFocusFrame !== undefined) {
      window.cancelAnimationFrame(mobileFocusFrame);
    }
    mobileFocusFrame = window.requestAnimationFrame(() => {
      mobileFocusFrame = undefined;
      selectedDetailElement?.scrollIntoView({ block: 'start' });
      selectedDetailElement?.focus({ preventScroll: true });
    });
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
    focusSelectedMobileDetail().catch(() => undefined);
  });
  const workspaceGrid = css({
    display: 'grid',
    gridTemplateColumns: {
      base: '1fr',
      lg: '240px minmax(0, 1fr)',
      xl: '240px minmax(0, 1fr) 288px',
      '2xl': '280px minmax(0, 1fr) 288px',
    },
    columnGap: '16px',
    rowGap: '16px',
    alignItems: 'start',
    '&[data-matrix-open="true"]': {
      gridTemplateColumns: { xl: '240px minmax(0, 1fr)', '2xl': '280px minmax(0, 1fr)' },
    },
  });
  const centerStack = css({ display: 'grid', gap: '16px', minW: 0 });
  const desktopTree = css({ display: { base: 'none', lg: 'block' } });
  const mobilePicker = css({ display: { base: 'block', lg: 'none' }, overflow: 'hidden' });
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
  const selectedDetail = css({
    minW: 0,
    scrollMarginTop: '12px',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '3px' },
  });
  const detailStack = css({ display: 'grid', gap: '14px', minW: 0 });
  const hero = css({ display: 'grid', gap: '8px' });
  const detailHeader = css({ display: 'grid', gap: '5px' });
  const titleRow = css({ display: 'flex', flexWrap: 'wrap', gap: '8px 10px', alignItems: 'center' });
  const detailTitle = css({ fontSize: { base: '22px', md: '28px' }, fontWeight: 750, overflowWrap: 'anywhere' });
  const metadataGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
    gap: '10px',
  });
  const metadataItem = css({
    display: 'grid',
    gap: '3px',
    p: '10px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    minW: 0,
  });
  const metadataLink = css({
    color: 'ink',
    textDecoration: 'none',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const dangerValue = css({ color: 'status.danger' });
  const warningValue = css({ color: 'status.warn' });
  const okValue = css({ color: 'status.ok' });
  const healthToneClass = (tone: SkillHealthTone): string | undefined => {
    if (tone === 'danger') {
      return dangerValue;
    }
    if (tone === 'warn') {
      return warningValue;
    }
    return tone === 'ok' ? okValue : undefined;
  };
  const metadataLabel = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 650,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  });
  const section = css({ display: 'grid', gap: '10px' });
  const sectionHeader = css({ display: 'grid', gap: '2px' });
  const compactList = css({ display: 'grid', gap: '8px' });
  const compactRow = css({
    appearance: 'none',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'center',
    p: '10px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    color: 'ink',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
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
  const mobileContext = css({
    display: { base: 'block', xl: 'contents' },
    gridColumn: { lg: '2', xl: 'auto' },
    '&[data-matrix-open="true"]': { display: { xl: 'block' }, gridColumn: { xl: '2' } },
  });
</script>

<!--
  One mount for every per-skill detail branch. It is a snippet rather than two copies because the
  defect this replaced was precisely a missing copy: the panel was mounted in the global branch and
  nowhere else, so every project-local skill's counts were invisible. Parity is now structural.

  Below the document at both call sites, deliberately: the SKILL.md source stays the primary object
  of the page, and observed usage is the axis you consult about it. `installScope` is what keeps the
  managed-derived verdict from being told about the wrong installation of a shared name.
-->
{#snippet skillObservations()}
  {#if view.selectionDetail.kind === 'global-skill' || view.selectionDetail.kind === 'project-skill'}
    <div class={section}>
      <SkillObservationsPanel
        errorMessage={observationsError}
        installScope={view.selectionDetail.kind === 'global-skill' ? 'global' : 'project'}
        {observations}
        skillName={view.selectionDetail.skill.name}
        variant="skill"
      />
    </div>
  {/if}
{/snippet}

<div class={workspaceGrid} data-matrix-open={view.matrixOpen} data-skills-hydrated={hydrated} data-skills-workspace>
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
        <div data-skills-matrix-slot>{@render matrixSlot(slotContext, managementPlan)}</div>
      {:else}
        <div class={placeholder}>Skill matrix integration slot</div>
      {/if}
    {:else}
      <section
        aria-label="Selected skill detail"
        class={selectedDetail}
        tabindex="-1"
        bind:this={selectedDetailElement}
      >
        <section aria-label="Skill detail" class={cx(panel, detailStack)}>
          {#if view.selectionDetail.kind === 'global-scope'}
            <div class={hero}>
              <div class={titleRow}>
                <h2 class={detailTitle}>Global skills</h2>
                <span class={cx(statusPill, statusPillInfo)}>{count(snapshot.skills.length, 'skill')}</span>
              </div>
              <p class={muted}>
                Shared source skills managed from {snapshot.config.sourceRepoPath ?? 'an unconfigured source'}.
              </p>
            </div>
            <div class={metadataGrid}>
              <a class={cx(metadataItem, metadataLink)} data-sveltekit-noscroll href="/skills/matrix">
                <span class={metadataLabel}>Healthy links</span>
                <span class={healthToneClass(healthyLinkTone(health))} data-health-tone={healthyLinkTone(health)}
                  >{health.healthyLinkCount}/{health.expectedLinkCount}</span
                >
              </a>
              <a class={cx(metadataItem, metadataLink)} data-sveltekit-noscroll href="/skills/matrix">
                <span class={metadataLabel}>To repair</span>
                <span
                  class={health.toRepairCount > 0 ? dangerValue : undefined}
                  data-health-tone={health.toRepairCount > 0 ? 'danger' : 'neutral'}
                  >{health.toRepairCount}</span
                >
              </a>
              <a class={cx(metadataItem, metadataLink)} data-sveltekit-noscroll href="/skills/matrix">
                <span class={metadataLabel}>Blocked</span>
                <span
                  class={health.blockedCount > 0 ? dangerValue : undefined}
                  data-health-tone={health.blockedCount > 0 ? 'danger' : 'neutral'}
                  >{health.blockedCount}</span
                >
              </a>
              <div class={metadataItem}>
                <span class={metadataLabel}>To consolidate</span>
                <span
                  class={health.consolidateCount > 0 ? warningValue : undefined}
                  data-health-tone={health.consolidateCount > 0 ? 'warn' : 'neutral'}
                  >{health.consolidateCopies}
                  copies / {health.consolidateSymlinks} symlinks</span
                >
              </div>
            </div>
            <section class={section}>
              <div class={sectionHeader}>
                <h3 class={panelTitle}>Needs attention</h3>
                <p class={panelSub}>Exposure issues first, then invalid or disabled skills.</p>
              </div>
              {#if attentionSkills.length === 0}
                <p class={meta}>No skills need attention.</p>
              {:else}
                <div class={compactList}>
                  {#each attentionSkills as entry (entry.skill.name)}
                    <SelectionLink
                      class={compactRow}
                      knownProjects={view.knownProjects}
                      selection={{ skillName: entry.skill.name, type: 'global-skill' }}
                    >
                      <span>
                        <span class={strongCell}>{entry.skill.name}</span>
                        <span class={meta}> {entry.skill.description || 'No description'}</span>
                      </span>
                      <span
                        class={cx(
                          statusPill,
                          attentionPillClass(
                            entry.skill.enabled,
                            entry.skill.validationStatus,
                            entry.attention.issueCount,
                          ),
                        )}
                        title={entry.attention.attentionSummary || undefined}
                      >
                        {attentionPillText(entry.skill.enabled, entry.skill.validationStatus, entry.attention.issueCount)}
                      </span>
                    </SelectionLink>
                  {/each}
                </div>
              {/if}
            </section>
            {#if healthSlot}
              <div data-skills-health-detail>{@render healthSlot(slotContext, managementPlan, 'detail')}</div>
            {/if}
          {:else if view.selectionDetail.kind === 'global-skill'}
            <div class={hero}>
              <header class={detailHeader}>
                <div class={titleRow}>
                  <h2 class={detailTitle}>{view.selectionLabel}</h2>
                  <span class={cx(statusPill, statusPillOk)}>{view.selectionDetail.skill.validationStatus}</span>
                  <span class={cx(statusPill, statusPillOk)}
                    >{view.selectionDetail.skill.enabled ? 'Enabled' : 'Disabled'}</span
                  >
                </div>
              </header>
              <p class={muted}>{view.selectionDetail.skill.description || 'No description provided.'}</p>
            </div>
            {#if editorSlot}
              <div data-skills-editor-slot>{@render editorSlot(slotContext)}</div>
            {:else}
              <div class={placeholder}>SKILL.md editor integration slot</div>
            {/if}
            {@render skillObservations()}
          {:else}
            <header class={detailHeader}>
              <p class={panelSub}>
                {view.selectionDetail.kind === 'project-scope' ? 'Project scope' : 'Project skill · read-only'}
              </p>
              <h2 class={detailTitle}>{view.selectionLabel}</h2>
            </header>
            {#if view.selectionDetail.kind === 'project-skill'}
              <p class={muted}>{view.selectionDetail.skill.description || 'No description provided.'}</p>
              {#if selectedDocument && 'truncated' in selectedDocument}
                <pre class={preview}>{selectedDocument.content}</pre>
              {:else}
                <div class={placeholder}>Project SKILL.md preview unavailable</div>
              {/if}
              <!-- A project-local skill needs this more, not less: it is outside the managed source
                   repository, so it is the population that carries the "observed but unmanaged"
                   adoption verdict, and read-only here means observation is the only thing this page
                   can tell you about it. -->
              {@render skillObservations()}
            {:else if view.selectionDetail.kind === 'project-scope'}
              <p class={meta}>{view.selectionDetail.project.path}</p>
              <p>{view.selectionDetail.inventories.length} scanned project inventories.</p>
            {:else}
              <h3 class={panelTitle}>Choose a skill</h3>
              <p class={panelSub}>Select a global skill to edit its SKILL.md or inspect a project scope.</p>
            {/if}
          {/if}
        </section>
      </section>
    {/if}
  </div>

  <div class={mobileContext} data-matrix-open={view.matrixOpen}>
    <SkillsInspector {...(healthSlot === undefined ? {} : { healthSlot })} {managementPlan} {slotContext} {view} />
  </div>
</div>
