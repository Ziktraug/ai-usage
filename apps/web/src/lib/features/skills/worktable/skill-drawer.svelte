<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed boolean ARIA values for the controlled Drawer -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    meta,
    muted,
    panelSub,
    panelTitle,
    statusPill,
    statusPillDanger,
    statusPillInfo,
    statusPillOk,
    statusPillWarn,
    strongCell,
  } from '@ai-usage/design-system/report';
  import { Drawer } from '@ai-usage/design-system/svelte';
  import type { ProjectSkillMarkdownDocument, SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
  import { type Snippet, tick } from 'svelte';
  import { count, skillDiagnosticLabel, skillInvocation } from '../../../../skills-page-model';
  import { fmtNum } from '../../../foundation/presentation/format';
  import { MATRIX_DOT_GLYPHS, matrixDotTone, reconcileSkillOperation, toggleOperation } from '../management/model';
  import type { SkillsManagementOperationEpisodePort } from '../management/operation-episode.svelte';
  import SkillSwitch from '../management/skill-switch.svelte';
  import { NAME_SCOPED_COUNTS_TEXT, NOT_OBSERVABLE_TEXT } from '../observations/model';
  import SkillObservationsPanel from '../observations/skill-observations.svelte';
  import type { SkillsPresentationProjection } from '../presentation';
  import type { SkillsShellViewModel } from '../shell/model';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import { worktableExposureCaveat, worktableHistorySentence } from './model';

  let {
    editorSlot,
    management,
    onClose,
    presentation,
    selectedDocument,
    slotContext,
    view,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    management: SkillsManagementOperationEpisodePort;
    onClose: () => void;
    presentation: SkillsPresentationProjection;
    selectedDocument: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
    slotContext: SkillsShellSlotContext;
    view: SkillsShellViewModel;
  } = $props();

  let closeButton = $state<HTMLButtonElement>();
  let projectPreviewElement = $state<HTMLElement | undefined>();
  let previousFocus: HTMLElement | null = $state(null);
  let wasOpen = false;
  /**
   * A scrollable region must be keyboard-reachable, and a region that does not scroll must not be a
   * tab stop that goes nowhere. The document changes between selections, so the decision is
   * re-made from the rendered box rather than from the content's length.
   */
  $effect(() => {
    const projectDocumentContent =
      selectedDocument && 'truncated' in selectedDocument ? selectedDocument.content : undefined;
    const element = projectPreviewElement;
    if (!(element && projectDocumentContent !== undefined)) {
      return;
    }
    const synchronize = (): void => {
      if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
        element.setAttribute('tabindex', '0');
      } else {
        element.removeAttribute('tabindex');
      }
    };
    synchronize();
    const observer = new ResizeObserver(synchronize);
    observer.observe(element);
    return () => observer.disconnect();
  });
  const selectionOpen = $derived(view.selectionDetail.kind !== 'none');
  /**
   * Closing is a navigation, and a navigation can be refused — the unsaved-draft guard cancels it
   * and raises its confirmation. That confirmation is rendered inside this drawer, so a drawer that
   * stayed shut would hide the very question it is asking. `closing` is released as soon as the
   * navigation settles: if the URL still names a skill, the drawer comes back with its draft and
   * its dialog intact.
   */
  let closing = $state(false);
  /**
   * True only while the drawer is coming back from a refused close. The guard's confirmation has
   * already taken focus by then, so the drawer must not pull it back to its own close button.
   */
  let reopening = $state(false);
  const open = $derived(selectionOpen && !closing);
  $effect.pre(() => {
    if (open && !wasOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpen = open;
  });

  const selected = $derived(presentation.selected);
  const globalSkill = $derived(selected.globalSkill);
  const projectSkill = $derived(selected.projectSkill);
  const observationsView = $derived(presentation.observations.view);
  const observationsError = $derived(presentation.observations.errorMessage);
  const pendingOperation = $derived(management.pendingOperation);
  const historySentence = $derived(worktableHistorySentence(selected.observationRow, observationsView));
  const exposureCaveat = $derived(worktableExposureCaveat(observationsView));
  const notObservableHarnesses = $derived(
    (observationsView?.harnesses ?? []).filter((harness) => harness.observability === 'not-observable'),
  );
  const residenceLine = $derived(
    globalSkill
      ? `${globalSkill.path} · Managed — source of truth in the skills repository`
      : `${projectSkill?.observations.at(0)?.path ?? ''} · Owned by its project repository — read-only here`,
  );
  const issueCount = $derived(
    presentation.attention.entries.find((entry) => entry.skill.name === selected.name)?.attention.issueCount ?? 0,
  );
  const placementActionLabel = (state: string, canReconcile: boolean): string | undefined => {
    if (!canReconcile) {
      return;
    }
    return state === 'missing' ? 'Link' : 'Repair link';
  };
  const execute = async (
    pendingLabel: string,
    operation: ReturnType<typeof reconcileSkillOperation>,
  ): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    await management.execute({ kind: 'management', operation, owner: 'skill-drawer', pendingLabel });
  };
  /**
   * Closing the drawer also navigates back to the worktable, and the router moves focus to the
   * document after a navigation. Restoring before that lands would be undone, so the restore waits
   * for the navigation to settle and then for the paint that re-renders the row — otherwise Escape
   * leaves the keyboard on `<body>` with no place in the table to carry on from.
   */
  const closeAndRestoreFocus = async (): Promise<void> => {
    // The drawer also closes because the URL already moved — a discarded draft replaying its
    // navigation, say. Navigating again there would push a second history entry for one departure.
    if (!selectionOpen) {
      return;
    }
    const closedName = selected.name;
    const fallback = previousFocus;
    closing = true;
    // The close has to reach the drawer as its own state change before the navigation is attempted,
    // otherwise a refused navigation collapses `true → false → true` into no change at all and the
    // drawer stays shut over the confirmation it is supposed to be showing.
    await tick();
    await onClose();
    if (selectionOpen) {
      // Refused: the URL still names this skill, so the drawer comes back — quietly, leaving focus
      // where the confirmation put it.
      reopening = true;
      closing = false;
      if (typeof window !== 'undefined') {
        // Whatever the guard put focus on — its own confirmation, or the editor it just kept — is
        // where focus belongs. The reopening drawer must hand it back rather than claim it.
        const guarded = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => {
            reopening = false;
            // A reader who has tabbed on inside the confirmation keeps their place; anywhere else,
            // focus goes back to whatever the guard chose — the drawer's own re-entry must not
            // outrank it.
            const active = document.activeElement;
            const insideConfirmation = active instanceof Element && active.closest('[role="alertdialog"]') !== null;
            if (guarded?.isConnected && !insideConfirmation && active !== guarded) {
              guarded.focus({ preventScroll: true });
            }
          }),
        );
      }
      return;
    }
    closing = false;
    if (typeof window === 'undefined') {
      return;
    }
    // The router moves focus to the document after a navigation, so the restore waits for the paint
    // that re-renders the row. It aims at the row this drawer was opened from rather than at
    // whatever held focus a moment ago — that is the place in the table to carry on from.
    window.requestAnimationFrame(() => {
      const rowLink =
        closedName === undefined
          ? null
          : document.querySelector<HTMLElement>(`[data-worktable-row="${CSS.escape(closedName)}"] a`);
      const target = rowLink ?? (fallback?.isConnected ? fallback : null);
      target?.focus({ preventScroll: true });
    });
  };
  const toggle = async (): Promise<void> => {
    if (globalSkill === undefined || pendingOperation !== null) {
      return;
    }
    await management.execute({
      kind: 'management',
      operation: toggleOperation(globalSkill.name, !globalSkill.enabled),
      owner: 'skill-drawer',
      pendingLabel: `toggle:${globalSkill.name}`,
    });
  };
  const initialDrawerFocus = (): HTMLElement | null => {
    if (!reopening) {
      return closeButton ?? null;
    }
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const drawerContent = css({ w: { base: '100vw', md: 'min(620px, 94vw)' } });
  const stack = css({ display: 'grid', gap: '18px', minW: 0 });
  const header = css({ display: 'grid', gap: '10px' });
  const titleRow = css({ display: 'flex', flexWrap: 'wrap', gap: '8px 10px', alignItems: 'center' });
  const drawerTitleText = css({ fontSize: '22px', fontWeight: 750, overflowWrap: 'anywhere' });
  const closeButtonClass = css({
    appearance: 'none',
    ml: 'auto',
    w: '32px',
    h: '32px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'muted',
    cursor: 'pointer',
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const pathLine = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
  const section = css({ display: 'grid', gap: '10px', minW: 0 });
  const placementList = css({
    display: 'grid',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    overflow: 'hidden',
  });
  const placementRow = css({
    display: 'grid',
    gridTemplateColumns: '132px minmax(0, 1fr) auto',
    gap: '12px',
    alignItems: 'center',
    p: '10px 12px',
    borderTop: '1px solid token(colors.line)',
    _first: { borderTop: 0 },
    fontSize: '12.5px',
  });
  const glyphMark = css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    w: '18px',
    h: '18px',
    borderRadius: 'xs',
    fontFamily: 'mono',
    fontSize: '11px',
    fontWeight: 700,
    '&[data-tone="linked"]': { bg: 'status.okSoft', color: 'status.ok' },
    '&[data-tone="missing"]': { bg: 'surfaceMuted', color: 'ink' },
    '&[data-tone="broken"]': { bg: 'status.dangerSoft', color: 'status.danger' },
    '&[data-tone="copy"]': { bg: 'status.warnSoft', color: 'status.warn' },
    '&[data-tone="none"]': { color: 'muted' },
  });
  const actionButton = css({
    appearance: 'none',
    p: '3px 10px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'accent',
    fontSize: '12px',
    fontWeight: 650,
    cursor: 'pointer',
    _hover: { borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _disabled: { cursor: 'default', opacity: 0.5 },
  });
  const preview = css({
    maxH: '360px',
    overflow: 'auto',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    fontFamily: 'mono',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const previewDocument = css({ m: 0, font: 'inherit', whiteSpace: 'inherit' });
  const findingRow = css({
    display: 'grid',
    gap: '4px',
    minW: 0,
    p: '8px 0',
    border: 0,
    borderTop: '1px solid token(colors.line)',
  });
  const pathText = css({ color: 'muted', fontFamily: 'mono', fontSize: '11px', overflowWrap: 'anywhere' });
</script>

<Drawer
  closeOnInteractOutside
  contentAriaLabel={`${selected.name ?? 'Skill'} detail`}
  contentClass={cx(
    css({
      position: 'fixed',
      top: 0,
      right: 0,
      zIndex: 60,
      display: 'flex',
      flexDirection: 'column',
      // Below the labelled breakpoint the application navigation is a fixed bar at the bottom of
      // the viewport. The drawer stops short of it so the rest of the app stays one tap away.
      h: { base: 'calc(100dvh - 64px)', md: '100dvh' },
      overflow: 'auto',
      p: '20px 24px',
      bg: 'surface',
      borderLeft: '1px solid token(colors.line)',
      boxShadow: 'overlay',
    }),
    drawerContent,
    'skills-drawer-panel',
  )}
  finalFocusEl={() => (previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : null)}
  initialFocusEl={initialDrawerFocus}
  modal={false}
  onFocusOutside={(event) => {
    // The guard's confirmation renders in the shell, so focus entering it reads as an outside
    // interaction and dismisses this drawer — re-attempting the navigation it just refused. The
    // question is about this drawer, so it counts as part of it.
    const target = event.detail.originalEvent.target;
    if (target instanceof Element && target.closest('[role="alertdialog"]') !== null) {
      event.preventDefault();
    }
  }}
  onInteractOutside={(event) => {
    // A click on the application navigation is already a departure, and it closes this drawer by
    // changing the URL. Answering it with a close of this drawer's own puts two destinations in
    // front of the unsaved-draft guard at once, and the one it keeps is decided by which arrives
    // first — so discarding could replay the worktable rather than the link that was clicked.
    const target = event.detail.originalEvent.target;
    if (target instanceof Element && target.closest('[data-app-navigation]') !== null) {
      event.preventDefault();
    }
  }}
  onOpenChange={(nextOpen) => {
    if (!nextOpen) {
      closeAndRestoreFocus().catch(() => undefined);
    }
  }}
  {open}
  trapFocus={false}
>
  <div class={stack} data-skill-drawer={selected.name}>
    <header class={header}>
      <div class={titleRow}>
        <h2 class={drawerTitleText}>{selected.name}</h2>
        {#if globalSkill}
          <SkillSwitch
            disabled={pendingOperation !== null}
            enabled={globalSkill.enabled}
            name={globalSkill.name}
            onToggle={toggle}
            pending={pendingOperation === `toggle:${globalSkill.name}`}
            showTitle
          />
          <span class={cx(statusPill, globalSkill.enabled ? statusPillOk : statusPillInfo)}>
            {globalSkill.enabled ? 'Enabled' : 'Kept in source'}
          </span>
          <span class={cx(statusPill, statusPillInfo)}>
            {skillInvocation(globalSkill) === 'auto' ? 'Auto' : 'Manual'}
          </span>
          {#if issueCount > 0}
            <span class={cx(statusPill, statusPillWarn)}>{count(issueCount, 'issue')}</span>
          {/if}
        {:else}
          <span class={cx(statusPill, statusPillInfo)}>Project-owned · read-only</span>
        {/if}
        <button
          aria-label="Close skill detail"
          class={closeButtonClass}
          onclick={onClose}
          type="button"
          bind:this={closeButton}
        >
          ✕
        </button>
      </div>
      <p class={muted}>{globalSkill?.description || projectSkill?.description || 'No description provided.'}</p>
      <p class={pathLine} data-skill-drawer-residence>{residenceLine}</p>
    </header>

    <section aria-label="What the history says" class={section}>
      <h3 class={panelTitle}>What the history says</h3>
      {#if observationsError !== undefined}
        <p data-skill-drawer-history="unavailable" role="status">
          Skill observations are unavailable. {observationsError}
        </p>
      {:else if selected.observationRowOmitted}
        <p data-skill-drawer-history="omitted" role="status">Omitted from this observation response.</p>
      {:else}
        <p data-skill-drawer-history>{historySentence}</p>
      {/if}
      {#if selected.homonym !== undefined}
        <p class={meta} role="status">{selected.homonym}</p>
      {/if}
      {#if globalSkill}
        <div class={placementList}>
          {#each selected.exposure as item (item.targetId)}
            {@const tone = matrixDotTone(item.state)}
            {@const action = placementActionLabel(item.state, item.canReconcile)}
            <div class={placementRow} data-skill-drawer-placement={item.targetId}>
              <span class={strongCell}>
                <span aria-hidden="true" class={glyphMark} data-tone={tone}>{MATRIX_DOT_GLYPHS[tone]}</span>
                {presentation.targetLabelById.get(item.targetId) ?? item.targetId}
              </span>
              <span class={muted}>{item.label} — {item.expectedPath}</span>
              {#if action}
                <button
                  class={actionButton}
                  disabled={pendingOperation !== null}
                  onclick={() =>
                    execute(`reconcile:${globalSkill.name}`, reconcileSkillOperation(globalSkill.name))}
                  type="button"
                >
                  {action}
                </button>
              {:else}
                <span class={meta}>{tone === 'copy' ? 'Unmanaged content is never overwritten' : 'No action'}</span>
              {/if}
            </div>
          {/each}
        </div>
      {:else if selected.projectPlacementSummary.length > 0}
        <ul class={meta}>
          {#each selected.projectPlacementSummary as placement (placement)}
            <li>{placement}</li>
          {/each}
        </ul>
      {/if}
      {#each notObservableHarnesses as harness (harness.harnessKey)}
        <p class={meta} data-harness-observability="not-observable">
          {harness.label}
          — {NOT_OBSERVABLE_TEXT}. Placement here is not evidence either way.
        </p>
      {/each}
      {#if exposureCaveat !== undefined}
        <p class={meta} data-skill-drawer-lower-bound role="status">{exposureCaveat}</p>
      {/if}
      <p class={meta} data-skill-drawer-name-scope>{NAME_SCOPED_COUNTS_TEXT}</p>
      <!-- The per-harness tiers, spelled out in words. The table's `~` notation is compact by
           design; this is where it is said in full, together with the resolved directories, the
           read qualification, and the deletion sentence a maintainer would act on. -->
      <SkillObservationsPanel
        observationPresentation={presentation.observations}
        selectedPresentation={selected}
        variant="skill"
      />
    </section>

    {#if globalSkill}
      <section aria-label="SKILL.md" class={section}>
        {#if editorSlot}
          <div data-skills-editor-slot>{@render editorSlot(slotContext)}</div>
        {:else}
          <p class={panelSub}>SKILL.md editor integration slot</p>
        {/if}
      </section>
    {:else if selectedDocument && 'truncated' in selectedDocument}
      <section
        aria-label={`${selectedDocument.skillName} SKILL.md preview`}
        class={preview}
        bind:this={projectPreviewElement}
      >
        <pre class={previewDocument}>{selectedDocument.content}</pre>
      </section>
    {:else}
      <p class={muted}>Project SKILL.md preview unavailable.</p>
    {/if}

    <section aria-label="Validation" class={section}>
      <h3 class={panelTitle}>Validation</h3>
      {#if selected.diagnostics.length === 0}
        <p class={meta}>No validation diagnostics.</p>
      {/if}
      {#each selected.diagnostics as diagnostic, index (diagnostic.code)}
        <fieldset
          aria-label={`Finding ${index + 1}: ${diagnostic.severity}`}
          class={findingRow}
          data-severity={diagnostic.severity}
          data-validation-finding={index + 1}
        >
          <span class={cx(statusPill, diagnostic.severity === 'error' ? statusPillDanger : statusPillWarn)}>
            {diagnostic.severity}
          </span>
          <code>{skillDiagnosticLabel(diagnostic.code)}</code>
          <p class={muted}>{diagnostic.message}</p>
          {#if diagnostic.tokenMeasurement}
            <p class={muted} data-token-measurement>
              {fmtNum(diagnostic.tokenMeasurement.observed)}
              / {fmtNum(diagnostic.tokenMeasurement.threshold)} tokens
            </p>
          {/if}
          {#each diagnostic.paths as path (path)}
            <code class={pathText} title={path}>{path}</code>
          {/each}
        </fieldset>
      {/each}
    </section>
  </div>
</Drawer>

<style>
  /*
                             * The drawer is not modal, so the page underneath stays usable — but Ark's positioner spans the
                             * whole viewport and would swallow every click aimed past the panel. Scoped with `:has` to this
                             * drawer so the modal session drawer, whose backdrop is meant to catch those clicks, is untouched.
                             */
  :global([data-scope="drawer"][data-part="positioner"]:has(.skills-drawer-panel)) {
    pointer-events: none;
  }

  :global(.skills-drawer-panel) {
    pointer-events: auto;
  }
</style>
