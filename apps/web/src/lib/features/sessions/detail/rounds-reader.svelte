<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed boolean ARIA values for aria-current and aria-expanded -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const reader = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(220px, 0.36fr) minmax(0, 1fr)' },
    gap: { base: '16px', md: '20px' },
    minW: 0,
    alignItems: 'start',
  });
  const rail = css({
    display: 'grid',
    gap: '2px',
    minW: 0,
    m: 0,
    p: 0,
    listStyle: 'none',
    position: { md: 'sticky' },
    top: { md: 0 },
    maxH: { base: '32vh', md: 'calc(100dvh - 120px)' },
    overflowY: 'auto',
    overscrollBehaviorY: 'contain',
    pr: '4px',
  });
  const railItem = css({ contentVisibility: 'auto', containIntrinsicSize: 'auto 72px' });
  const railButton = css({
    display: 'grid',
    gridTemplateColumns: '30px minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'start',
    w: 'full',
    p: '8px 8px',
    border: '1px solid transparent',
    borderRadius: 'sm',
    bg: 'transparent',
    color: 'ink',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { bg: 'accentTint' },
    '&[aria-current="true"]': { bg: 'accentTint', borderColor: 'line' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  });
  const railIndex = css({ textStyle: 'numeric', color: 'muted', fontSize: '11px', pt: '2px' });
  const railExcerpt = css({
    lineClamp: 2,
    fontSize: '12px',
    lineHeight: 1.4,
    minW: 0,
  });
  const railExcerptMuted = css({ color: 'muted', fontStyle: 'italic' });
  const railMeta = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 8px',
    alignItems: 'center',
    mt: '4px',
    color: 'muted',
    fontSize: '10.5px',
    lineHeight: 1.4,
  });
  const railCost = css({ textStyle: 'numeric', color: 'ink', fontSize: '11px', whiteSpace: 'nowrap', pt: '2px' });
  const chip = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    px: '6px',
    py: '1px',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    color: 'ink',
    fontFamily: 'mono',
    fontSize: '10px',
    whiteSpace: 'nowrap',
  });
  const chipAgent = css({ bg: 'accentTint', color: 'accent' });
  const pane = css({ display: 'grid', gap: '16px', minW: 0 });
  const paneHeader = css({ display: 'grid', gap: '4px' });
  const paneTitle = css({ color: 'ink', fontSize: '15px', fontWeight: 650, lineHeight: 1.3, m: 0 });
  const paneMeta = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });
  const statsRow = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 14px',
    color: 'ink',
    fontSize: '12px',
    textStyle: 'numeric',
  });
  const sectionLabel = css({ textStyle: 'label', color: 'muted', mb: '6px' });
  const promptBlock = css({
    position: 'relative',
    maxW: '78ch',
    p: '12px 14px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
    color: 'ink',
    fontSize: '13px',
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  });
  const promptFade = css({
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    h: '56px',
    borderRadius: '0 0 4px 4px',
    bgGradient: 'to-b',
    gradientFrom: 'transparent',
    gradientTo: 'surfaceMuted',
    pointerEvents: 'none',
  });
  const promptEntry = css({ display: 'grid', gap: '6px' });
  const promptEntryMeta = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    alignItems: 'center',
    color: 'muted',
    fontSize: '11px',
  });
  const pill = css({
    px: '7px',
    py: '1px',
    borderRadius: 'full',
    bg: 'status.warnSoft',
    color: 'status.warn',
    fontSize: '10px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
  });
  const linkButton = css({
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    minH: { base: '44px', md: 'auto' },
    border: 0,
    p: 0,
    bg: 'transparent',
    color: 'accent',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const interactionList = css({ display: 'grid', gap: '6px', m: 0, p: 0, listStyle: 'none' });
  const interactionRow = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) auto' },
    gap: { base: '6px', md: '10px' },
    alignItems: 'start',
    p: '8px 10px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
  });
  const interactionTitleClass = css({ color: 'ink', fontSize: '12.5px', fontWeight: 600, lineHeight: 1.35 });
  const interactionMeta = css({ color: 'muted', fontSize: '11px', lineHeight: 1.45, mt: '2px' });
  const interactionValue = css({
    textStyle: 'numeric',
    color: 'ink',
    fontSize: '12px',
    textAlign: { base: 'left', md: 'right' },
    whiteSpace: { base: 'normal', md: 'nowrap' },
  });
  const idChip = css({ whiteSpace: 'normal', overflowWrap: 'anywhere' });
  const scopeNote = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });
  const preamble = css({ display: 'grid', gap: '10px', mb: '14px' });
  const unroundedBlock = css({
    p: '6px 12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    '& > summary': {
      display: 'flex',
      alignItems: 'center',
      minH: { base: '44px', md: '32px' },
      color: 'ink',
      fontSize: '12.5px',
      fontWeight: 600,
      cursor: 'pointer',
    },
  });
  const interactionValueSub = css({ display: 'block', color: 'muted', fontSize: '10px' });
  const noteList = css({ display: 'grid', gap: '4px', m: 0, p: 0, listStyle: 'none' });
  const note = css({ color: 'muted', fontSize: '11px', lineHeight: 1.45 });
  const noteWarning = css({ color: 'status.warn' });
  const empty = css({
    p: '14px',
    border: '1px dashed token(colors.lineStrong)',
    borderRadius: 'md',
    color: 'muted',
    fontSize: '12px',
    textAlign: 'center',
  });
  const statePanel = css({
    display: 'grid',
    placeItems: 'center',
    gap: '10px',
    minH: '200px',
    p: '24px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
    textAlign: 'center',
  });
  const stateTitleClass = css({ color: 'ink', fontSize: '15px', fontWeight: 700 });
  const retryButton = css({
    minH: '44px',
    px: '12px',
    py: '7px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 650,
    _hover: { borderColor: 'accent', color: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const visuallyHidden = css({ srOnly: true });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SessionDetailUnavailableReason } from '@ai-usage/report-core/session-detail';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import { tick } from 'svelte';
  import type { SessionAnalysisError } from '../../../../session-analysis-error';
  import { formatSessionDuration } from '../../../../session-analysis-model';
  import { fmtCompact, fmtDate, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';
  import {
    type ChildView,
    type InteractionView,
    interactionTitle,
    promptOpening,
    type RoundsView,
    type RoundView,
    roundTitle,
  } from './rounds-model';

  let {
    error: analysisError = null,
    loading,
    onOpenChild,
    onRetry,
    scopeNote: scopeNoteText = null,
    selectedRoundId = $bindable(null),
    unavailable = null,
    view,
  }: {
    error?: SessionAnalysisError | null;
    loading: boolean;
    onOpenChild?: ((row: SessionPresentationRow) => void) | undefined;
    onRetry?: (() => void) | undefined;
    /** Names what the rounds read when the panel's numbers cover more than one session. */
    scopeNote?: string | null;
    /** Owned by the drawer so switching tabs and back keeps the reader's place. */
    selectedRoundId?: string | null;
    unavailable?: { message: string; reason: SessionDetailUnavailableReason } | null;
    view: RoundsView | null;
  } = $props();

  const unavailableTitles: Record<SessionDetailUnavailableReason, string> = {
    'history-unavailable': 'Local history unavailable',
    'not-found': 'Local session history not found',
    'not-local': 'Local history required',
    'report-provenance-unavailable': 'Session provenance unavailable',
    'report-row-not-found': 'Session not found in report',
    'revision-expired': 'Report revision expired',
    unsupported: 'Rounds not supported',
  };

  let expandedPrompts = $state<ReadonlySet<string>>(new Set());
  let railButtons: HTMLButtonElement[] = [];
  const selectedRound = $derived.by((): RoundView | null => {
    if (!view || view.rounds.length === 0) {
      return null;
    }
    return view.rounds.find((round) => round.id === selectedRoundId) ?? view.rounds[0] ?? null;
  });
  $effect(() => {
    const first = view?.rounds[0]?.id ?? null;
    if (selectedRoundId === null || !view?.rounds.some((round) => round.id === selectedRoundId)) {
      selectedRoundId = first;
      expandedPrompts = new Set();
    }
  });

  const selectRound = (round: RoundView): void => {
    selectedRoundId = round.id;
    expandedPrompts = new Set();
  };
  const moveSelection = async (delta: number, toEdge = false): Promise<void> => {
    if (!(view && selectedRound)) {
      return;
    }
    const total = view.rounds.length;
    let index = selectedRound.index + delta;
    if (toEdge) {
      index = delta < 0 ? 0 : total - 1;
    }
    const next = view.rounds[Math.max(0, Math.min(total - 1, index))];
    if (!next) {
      return;
    }
    selectRound(next);
    await tick();
    railButtons[next.index]?.focus({ preventScroll: false });
  };
  const handleRailKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveSelection(event.key === 'Home' ? -1 : 1, true);
    }
  };
  const togglePrompt = (promptId: string): void => {
    const next = new Set(expandedPrompts);
    if (next.has(promptId)) {
      next.delete(promptId);
    } else {
      next.add(promptId);
    }
    expandedPrompts = next;
  };
  const costLabel = (round: Pick<RoundView, 'cost' | 'costKind'>): string => {
    if (round.cost === null) {
      return '—';
    }
    return round.costKind === 'approximate' ? `≈ ${fmtMoney(round.cost)}` : fmtMoney(round.cost);
  };
  const spanLabel = (round: Pick<RoundView, 'observedSpanMs' | 'recordedActiveMs'>): string =>
    round.recordedActiveMs === null
      ? `${formatSessionDuration(round.observedSpanMs)} observed`
      : `${formatSessionDuration(round.recordedActiveMs)} recorded`;
  const roundAccessibleLabel = (round: RoundView): string =>
    `Round ${round.index + 1} of ${view?.rounds.length ?? 0}: ${roundTitle(round)}. ${costLabel(round)}, ${spanLabel(round)}, ${fmtNum(round.tools)} tools, ${round.interactions.length} agent interactions.`;
  const rowValue = (row: SessionPresentationRow | null): { primary: string; secondary: string } | null => {
    if (!row) {
      return null;
    }
    return {
      primary: `${apiValuePresentation(row).label} API`,
      secondary: `${fmtCompact(row.freshTokens)} fresh · ${fmtNum(row.turns)} turns · ${fmtNum(row.tools)} tools`,
    };
  };
  const childValue = (interaction: InteractionView): { primary: string; secondary: string } | null =>
    rowValue(interaction.child?.row ?? null);
  const childTitle = (child: ChildView): string => child.label ?? child.agentType ?? child.sourceSessionId;
  const noInteractionText = $derived(
    view?.interactionEvidence === 'unavailable'
      ? 'This harness does not record which round launched or messaged a child, so an empty list here is not evidence of none. Its child sessions are listed above the rounds.'
      : 'No sub-agent was launched or messaged in this round.',
  );
  const stateTitleFor = (): string => {
    if (analysisError) {
      return analysisError.kind === 'transient' ? 'Rounds failed to load' : 'Rounds unavailable';
    }
    return unavailable ? unavailableTitles[unavailable.reason] : 'No rounds loaded';
  };
  const stateMessage = $derived(analysisError?.message ?? unavailable?.message ?? 'Select a locally recorded session.');
  const canRetry = $derived(
    Boolean(onRetry && (analysisError?.kind === 'transient' || unavailable?.reason === 'history-unavailable')),
  );
</script>

<section aria-label="Session rounds" data-session-rounds>
  <div aria-atomic="true" aria-live="polite" class={visuallyHidden} role="status">
    {#if loading}
      Loading rounds
    {:else if view}
      {fmtNum(view.rounds.length)}
      rounds loaded
    {/if}
  </div>
  {#if analysisError}
    <div role="alert">
      <div class={statePanel}>
        <div class={stateTitleClass}>{stateTitleFor()}</div>
        <div>{stateMessage}</div>
        {#if canRetry}
          <button class={retryButton} onclick={() => onRetry?.()} type="button">Retry</button>
        {/if}
      </div>
    </div>
  {:else if loading && !view}
    <div aria-busy="true" class={statePanel}>
      <div class={stateTitleClass}>Loading rounds</div>
      <div>Reading the bounded local session trace…</div>
    </div>
  {:else if unavailable}
    <div class={statePanel} data-session-rounds-unavailable={unavailable.reason}>
      <div class={stateTitleClass}>{stateTitleFor()}</div>
      <div>{stateMessage}</div>
      {#if canRetry}
        <button class={retryButton} onclick={() => onRetry?.()} type="button">Retry</button>
      {/if}
    </div>
  {:else if view}
    {@const unrounded = view.unroundedChildren.length + view.unattributedInteractions.length}
    <div class={preamble}>
      {#if scopeNoteText}
        <p class={scopeNote} data-session-rounds-scope>{scopeNoteText}</p>
      {/if}
      {#if view.coverageNotes.length > 0}
        <ul class={noteList} data-session-rounds-coverage>
          {#each view.coverageNotes as coverageNote (coverageNote.key)}
            <li class={cx(note, coverageNote.tone === 'warning' && noteWarning)}>{coverageNote.text}</li>
          {/each}
        </ul>
      {/if}
      {#if unrounded > 0}
        <details class={unroundedBlock} data-session-rounds-unrounded>
          <summary>
            {fmtNum(unrounded)}
            {unrounded === 1 ? 'child session or launch' : 'child sessions and launches'}
            without a known round
          </summary>
          <ul class={interactionList} style="margin: 6px 0 8px">
            {#each view.unroundedChildren as child (child.sourceSessionId)}
              {@const value = rowValue(child.row)}
              <li class={interactionRow}>
                <div>
                  <div class={interactionTitleClass}>{childTitle(child)}</div>
                  <div class={interactionMeta}>
                    {child.agentType ?? 'child session'}
                    · <span class={cx(chip, idChip)}>{child.sourceSessionId}</span>
                    {#if child.row && onOpenChild}
                      ·
                      <button class={linkButton} onclick={() => onOpenChild?.(child.row!)} type="button">
                        Open session
                      </button>
                    {:else if !child.row}
                      · usage not loaded for this member yet
                    {/if}
                  </div>
                </div>
                <div class={interactionValue}>
                  {#if value}
                    {value.primary}
                    <span class={interactionValueSub}>{value.secondary}</span>
                  {:else}
                    —
                  {/if}
                </div>
              </li>
            {/each}
            {#each view.unattributedInteractions as interaction (interaction.toolUseId)}
              <li class={interactionRow}>
                <div>
                  <div class={interactionTitleClass}>{interactionTitle(interaction)}</div>
                  <div class={interactionMeta}>
                    <time datetime={interaction.at}>{fmtDate(interaction.at)}</time>
                    · not attributable to a prompt
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>
    {#if !selectedRound}
      <div class={empty}>No rounds were recorded in local history for this session.</div>
    {:else}
      <div class={reader}>
        <ol aria-label="Rounds" class={rail} data-session-rounds-rail>
          {#each view.rounds as round (round.id)}
            <li class={railItem}>
              <button
                aria-current={round.id === selectedRound.id ? 'true' : 'false'}
                aria-label={roundAccessibleLabel(round)}
                class={railButton}
                data-session-round={round.index}
                onclick={() => selectRound(round)}
                onkeydown={handleRailKey}
                tabindex={round.id === selectedRound.id ? 0 : -1}
                type="button"
                bind:this={railButtons[round.index]}
              >
                <span aria-hidden="true" class={railIndex}>{String(round.index + 1).padStart(2, '0')}</span>
                <span>
                  <span class={cx(railExcerpt, !round.excerpt && railExcerptMuted)}>{roundTitle(round)}</span>
                  <span class={railMeta}>
                    {#each round.interactions as interaction (interaction.toolUseId)}
                      <span class={cx(chip, chipAgent)}
                        >{interaction.child?.agentType ?? (interaction.kind === 'spawn' ? 'agent' : 'message')}</span
                      >
                    {/each}
                    <span>{fmtNum(round.tools)} tools</span>
                    <span>{spanLabel(round)}</span>
                  </span>
                </span>
                <span class={railCost}>{costLabel(round)}</span>
              </button>
            </li>
          {/each}
        </ol>
        <article aria-label={`Round ${selectedRound.index + 1}`} class={pane} data-session-round-pane>
          <header class={paneHeader}>
            <h3 class={paneTitle}>
              Round {selectedRound.index + 1} <span class={paneMeta}>of {fmtNum(view.rounds.length)}</span>
            </h3>
            <div class={paneMeta}>
              <time datetime={selectedRound.startAt}>{fmtDate(selectedRound.startAt)}</time>
              →
              <time datetime={selectedRound.endAt}>{fmtDate(selectedRound.endAt)}</time>
              · {spanLabel(selectedRound)}
            </div>
            <div class={statsRow}>
              <span>{costLabel(selectedRound)}</span>
              <span>{fmtCompact(selectedRound.tokens.total)} tokens</span>
              <span
                >{selectedRound.calls === null ? 'calls not recorded' : `${fmtNum(selectedRound.calls)} calls`}</span
              >
              <span>{fmtNum(selectedRound.tools)} tools</span>
              <span>{selectedRound.model}</span>
            </div>
          </header>
          <div>
            <div class={sectionLabel}>
              {selectedRound.prompts.length === 1 ? 'Prompt' : `Prompts · ${selectedRound.prompts.length}`}
            </div>
            {#if selectedRound.prompts.length === 0}
              <div class={empty}>
                {selectedRound.kind === 'unattributed'
                ? 'Recorded activity that no prompt owns. It stays visible instead of being folded into a neighbour.'
                : 'No prompt text was available in local history.'}
              </div>
            {/if}
            {#each selectedRound.prompts as prompt (prompt.id)}
              {@const opening = promptOpening(prompt.text)}
              {@const expanded = expandedPrompts.has(prompt.id)}
              <div class={promptEntry}>
                <div class={promptEntryMeta}>
                  <time datetime={prompt.timestamp}>{fmtDate(prompt.timestamp)}</time>
                  {#if prompt.truncated}
                    <span class={pill}>{prompt.text.length === 0 ? 'Body not retained' : 'Truncated'}</span>
                  {/if}
                </div>
                {#if prompt.text.length > 0}
                  <div class={promptBlock} data-session-round-prompt>
                    {expanded ? prompt.text : opening.text}
                    {#if opening.truncated && !expanded}
                      <span aria-hidden="true" class={promptFade}></span>
                    {/if}
                  </div>
                  {#if opening.truncated}
                    <button
                      aria-expanded={expanded ? 'true' : 'false'}
                      class={linkButton}
                      onclick={() => togglePrompt(prompt.id)}
                      type="button"
                    >
                      {expanded ? 'Show the opening only' : `Continue reading (${fmtCompact(prompt.text.length)} characters)`}
                    </button>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
          <div>
            <div class={sectionLabel}>Sub-agents in this round</div>
            {#if selectedRound.interactions.length === 0}
              <div class={empty} data-session-round-no-interactions={view.interactionEvidence}>{noInteractionText}</div>
            {:else}
              <ul class={interactionList} data-session-round-interactions>
                {#each selectedRound.interactions as interaction (interaction.toolUseId)}
                  {@const value = childValue(interaction)}
                  <li class={interactionRow}>
                    <div>
                      <div class={interactionTitleClass}>{interactionTitle(interaction)}</div>
                      <div class={interactionMeta}>
                        {#if interaction.child}
                          {interaction.child.agentType ?? 'agent'}
                          · <span class={cx(chip, idChip)}>{interaction.child.sourceSessionId}</span>
                          {#if interaction.child.row && onOpenChild}
                            ·
                            <button
                              class={linkButton}
                              onclick={() => onOpenChild?.(interaction.child!.row!)}
                              type="button"
                            >
                              Open session
                            </button>
                          {:else if !interaction.child.row}
                            · usage not loaded for this member yet
                          {/if}
                        {:else}
                          The launch never recorded which agent it started.
                        {/if}
                      </div>
                    </div>
                    <div class={interactionValue}>
                      {#if value}
                        {value.primary}
                        <span class={interactionValueSub}>{value.secondary}</span>
                      {:else}
                        —
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </article>
      </div>
    {/if}
  {:else}
    <div class={statePanel}>
      <div class={stateTitleClass}>No rounds loaded</div>
      <div>{stateMessage}</div>
    </div>
  {/if}
</section>
