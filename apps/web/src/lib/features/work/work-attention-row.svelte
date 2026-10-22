<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed string ARIA values for the current row -->
<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import type { WorkRoot } from '@ai-usage/report-core/work-attention';
  import {
    formatExactInstant,
    formatRelativeAge,
    WORK_STANDING_LABELS,
    workDeclaredStatusLabel,
    workHarnessLabel,
    workRootFactChips,
    workRootId,
    workRootLastDecision,
    workRootNextAction,
    workRootRelevantInstant,
    workRootStanding,
    workUndeclaredSituation,
  } from './work-attention-model';
  import {
    workChip,
    workChipOk,
    workChipRow,
    workChipWarn,
    workMarker,
    workQuestion,
    workQuestionSettled,
    workQuestionToReconsider,
    workRowButton,
    workRowDecision,
    workRowMeta,
    workRowNext,
    workRowTitle,
    workRowTop,
    workStandingMarker,
  } from './work-styles';

  let {
    root,
    reference,
    selected,
    tabindex,
    onSelect,
  }: {
    root: WorkRoot;
    /** The dataset's own instant; ages are relative to it, never to the wall clock. */
    reference: string;
    selected: boolean;
    tabindex: 0 | -1;
    onSelect: (id: string) => void;
  } = $props();
  const id = $derived(workRootId(root));
  const instant = $derived(workRootRelevantInstant(root));
  const chips = $derived(workRootFactChips(root));
  const standing = $derived(workRootStanding(root));
  const decision = $derived(workRootLastDecision(root));
  const next = $derived(workRootNextAction(root));
  const settled = $derived(standing === 'answered' || standing === 'handled' || standing === 'archived');
  // One complete class per standing: layered atoms would resolve by stylesheet order, not by intent.
  const questionClass = $derived.by(() => {
    if (standing === 'reconsider') {
      return workQuestionToReconsider;
    }
    return settled ? workQuestionSettled : workQuestion;
  });
  const place = $derived(
    [
      root.project.label,
      root.project.worktreeName ? `${root.project.branch ?? '?'} (${root.project.worktreeName})` : root.project.branch,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
  );
  const situation = $derived(
    root.declared ? workDeclaredStatusLabel(root.declared.status) : workUndeclaredSituation(root),
  );
  const request = $derived(
    root.declared?.needsAction ?? (root.declared?.status === 'review_ready' ? 'Review requested' : null),
  );
</script>

<li>
  <button
    aria-current={selected ? 'true' : undefined}
    class={workRowButton}
    data-work-root={id}
    data-work-standing={standing}
    onclick={() => onSelect(id)}
    {tabindex}
    type="button"
  >
    <span class={workRowTop}>
      <HarnessBadge name={workHarnessLabel(root.key.harness)} />
      <span class={workRowTitle}>{root.title}</span>
      {#if standing === 'reconsider' || settled}
        <span class={workStandingMarker} data-work-standing-marker>{WORK_STANDING_LABELS[standing]}</span>
      {/if}
      {#if standing === 'not-declared'}
        <!-- ADR 0059: unknown, never "nothing pending"; said in words, not by colour alone. -->
        <span class={workMarker} data-work-not-declared>wait not declared</span>
      {/if}
      {#if root.archived}
        <span class={workMarker}>archived</span>
      {/if}
    </span>
    {#if request}
      <span class={questionClass}>{request}</span>
    {/if}
    <span class={workRowMeta}>
      <span>{place}</span>
      <span aria-hidden="true">·</span>
      <span
        >{situation}
        ·
        <time datetime={instant ?? undefined} title={formatExactInstant(instant)}
          >{formatRelativeAge(instant, reference)}</time
        ></span
      >
    </span>
    {#if decision}
      <span class={workRowDecision} data-work-decision
        >{decision.text}
        {#if decision.instant}
          ·
          <time datetime={decision.instant} title={formatExactInstant(decision.instant)}
            >{decision.instantLabel} {formatRelativeAge(decision.instant, reference)}</time
          >
        {/if}</span
      >
    {/if}
    {#if next}
      <span class={workRowNext} data-work-next>Next: {next}</span>
    {/if}
    {#if chips.length > 0}
      <span class={workChipRow}>
        {#each chips as chip (chip.id)}
          <span class={cx(workChip, chip.tone === 'warn' && workChipWarn, chip.tone === 'ok' && workChipOk)}>
            {chip.label}
            {#if chip.instant}
              <time datetime={chip.instant} title={formatExactInstant(chip.instant)}>
                · {chip.instantLabel ? `${chip.instantLabel} ` : ''}{formatRelativeAge(chip.instant, reference)}
              </time>
            {/if}
          </span>
        {/each}
      </span>
    {/if}
  </button>
</li>
