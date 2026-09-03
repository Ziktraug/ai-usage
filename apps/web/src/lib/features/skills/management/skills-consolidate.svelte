<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    ghostButton,
    meta,
    muted,
    panel,
    skillsDisclosurePanel,
    skillsDisclosureSummary,
    skillsPathText,
    statusPill,
    statusPillInfo,
    statusPillWarn,
    strongCell,
  } from '@ai-usage/design-system/report';
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import { count, type UnmanagedGroup } from '../../../../skills-page-model';

  const body = css({ display: 'grid', gap: '12px', p: '0 16px 16px' });
  const groupRow = css({ borderTop: '1px solid token(colors.line)' });
  const groupSummary = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', md: 'auto minmax(0, 1fr) auto' },
    gap: '8px 12px',
    alignItems: 'center',
    p: '10px 0',
    cursor: 'pointer',
  });
  const entryList = css({
    display: 'grid',
    gap: '6px',
    pb: '10px',
    pl: { base: 0, md: '88px' },
  });
  const entryRow = css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'center',
  });

  let {
    groups,
    onReviewEntry,
    total,
    usageByName,
    usageEvidenceComplete = false,
  }: {
    groups: readonly UnmanagedGroup[];
    /** Optional: the worktable already lists these entries, so it offers no second destination. */
    onReviewEntry?: () => void;
    total: number;
    /**
     * Skill signals per name, joined in by the caller. This is what turns the backlog from a file
     * listing into a decision aid without treating availability as invocation evidence.
     */
    usageByName?: ReadonlyMap<string, { lastObservedAt: string | null; summary: string }>;
    /** Whether an absent invocation row is strong enough to state a complete absence. */
    usageEvidenceComplete?: boolean;
  } = $props();

  const usageFor = (name: string): { lastObservedAt: string | null; summary: string } | undefined =>
    usageByName?.get(name);
</script>

<details class={cx(panel, skillsDisclosurePanel)} data-consolidation-panel>
  <summary class={skillsDisclosureSummary}>
    <span class={strongCell}>To consolidate</span
    ><span class={cx(statusPill, statusPillWarn)}>{count(total, 'entry', 'entries')}</span>
  </summary>
  <div class={body}>
    <p class={muted}>
      These entries live in runtime skill directories without a managed source behind them — copies outright, and
      symlinks whose targets are outside the source repository. Adopting one means moving it into the source repo and
      symlinking back. Nothing is ever deleted automatically.
    </p>
    {#if onReviewEntry}
      <div>
        <button class={ghostButton} onclick={onReviewEntry} type="button">Review in the matrix</button>
      </div>
    {/if}
    {#if groups.length === 0}
      <p class={meta}>No unmanaged target entries.</p>
    {:else}
      {#each groups as group}
        <details class={groupRow}>
          <summary class={groupSummary}>
            <HarnessBadge name={group.targetLabel} />
            <span class={skillsPathText}>{group.targetPath}</span>
            <span class={meta}>{count(group.copies, 'copy', 'copies')} · {count(group.symlinks, 'symlink')}</span>
          </summary>
          <div class={entryList}>
            {#each group.entries as entry}
              {@const usage = usageFor(entry.name)}
              <div
                class={entryRow}
                data-backlog-tone={entry.state === 'unmanaged-copy' ? 'neutral' : 'warning'}
                data-unmanaged-entry
              >
                <span class={cx(statusPill, entry.state === 'unmanaged-copy' ? statusPillInfo : statusPillWarn)}
                  >{entry.state === 'unmanaged-copy' ? 'copy' : 'symlink'}</span
                >
                <span class={skillsPathText} title={entry.path}>{entry.name}</span>
                <span class={meta} data-unmanaged-entry-usage>
                  {#if usage !== undefined && usage.summary.length > 0}
                    {usage.summary}
                  {:else if usageByName !== undefined}
                    {usageEvidenceComplete ? 'no invocation recorded' : 'no invocation in loaded history'}
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </details>
      {/each}
    {/if}
  </div>
</details>
