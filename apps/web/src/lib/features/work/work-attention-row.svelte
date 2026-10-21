<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits closed string ARIA values for the current row -->
<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import type { WorkRoot } from '@ai-usage/report-core/work-attention';
  import {
    formatExactInstant,
    formatRelativeAge,
    workDeclaredStatusLabel,
    workHarnessLabel,
    workRootFactChips,
    workRootId,
    workRootRelevantInstant,
  } from './work-attention-model';
  import {
    workChip,
    workChipOk,
    workChipRow,
    workChipWarn,
    workMarker,
    workQuestion,
    workRowButton,
    workRowMeta,
    workRowTitle,
    workRowTop,
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
  const place = $derived(
    [
      root.project.label,
      root.project.worktreeName ? `${root.project.branch ?? '?'} (${root.project.worktreeName})` : root.project.branch,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
  );
  const undeclared = (harness: string): string => (harness === 'claude' ? 'no declaration' : 'activity only');
  const situation = $derived(
    root.declared ? workDeclaredStatusLabel(root.declared.status) : undeclared(root.key.harness),
  );
</script>

<li>
  <button
    aria-current={selected ? 'true' : undefined}
    class={workRowButton}
    data-work-root={id}
    onclick={() => onSelect(id)}
    {tabindex}
    type="button"
  >
    <span class={workRowTop}>
      <HarnessBadge name={workHarnessLabel(root.key.harness)} />
      <span class={workRowTitle}>{root.title}</span>
      {#if root.archived}
        <span class={workMarker}>archived</span>
      {/if}
    </span>
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
    {#if root.declared?.needsAction}
      <span class={workQuestion}>{root.declared.needsAction}</span>
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
