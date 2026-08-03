<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { HarnessBadge, panel } from '@ai-usage/design-system/svelte';
  import { count, type UnmanagedGroup } from '../../../../skills-page-model';
  import {
    button,
    compactStack,
    disclosure,
    disclosureSummary,
    infoPill,
    muted,
    pathText,
    pill,
    stack,
    strong,
    warningPill,
  } from './styles';

  let {
    groups,
    onReviewEntry,
    total,
  }: { groups: readonly UnmanagedGroup[]; onReviewEntry: () => void; total: number } = $props();
</script>

<details class={cx(panel, disclosure)} data-consolidation-panel>
  <summary class={disclosureSummary}>
    <span class={strong}>To consolidate</span
    ><span class={cx(pill, warningPill)}>{count(total, 'entry', 'entries')}</span>
  </summary>
  <div class={stack}>
    <p class={muted}>
      These skills live directly in runtime folders, outside your source repository. Adopting them means moving them
      into the source repo and symlinking back. Nothing is ever deleted automatically.
    </p>
    {#if groups.length === 0}
      <p class={muted}>No unmanaged target entries.</p>
    {:else}
      {#each groups as group}
        <details>
          <summary class={disclosureSummary}>
            <HarnessBadge name={group.targetLabel} />
            <span class={pathText}>{group.targetPath}</span>
            <span class={muted}>{count(group.copies, 'copy', 'copies')} · {count(group.symlinks, 'symlink')}</span>
          </summary>
          <div class={compactStack}>
            {#each group.entries as entry}
              <div
                class={compactStack}
                data-backlog-tone={entry.state === 'unmanaged-copy' ? 'neutral' : 'warning'}
                data-unmanaged-entry
              >
                <span class={cx(pill, entry.state === 'unmanaged-copy' ? infoPill : warningPill)}
                  >{entry.state === 'unmanaged-copy' ? 'copy' : 'symlink'}</span
                >
                <span class={pathText} title={entry.path}>{entry.name}</span>
                <button class={button} onclick={onReviewEntry} type="button">Review consolidation</button>
              </div>
            {/each}
          </div>
        </details>
      {/each}
    {/if}
  </div>
</details>
