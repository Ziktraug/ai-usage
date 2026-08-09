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
  import HarnessBadge from '@ai-usage/design-system/svelte/harness-badge';
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
  }: { groups: readonly UnmanagedGroup[]; onReviewEntry: () => void; total: number } = $props();
</script>

<details class={cx(panel, skillsDisclosurePanel)} data-consolidation-panel>
  <summary class={skillsDisclosureSummary}>
    <span class={strongCell}>To consolidate</span
    ><span class={cx(statusPill, statusPillWarn)}>{count(total, 'entry', 'entries')}</span>
  </summary>
  <div class={body}>
    <p class={muted}>
      These skills live directly in runtime folders, outside your source repository. Adopting them means moving them
      into the source repo and symlinking back. Nothing is ever deleted automatically.
    </p>
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
              <div
                class={entryRow}
                data-backlog-tone={entry.state === 'unmanaged-copy' ? 'neutral' : 'warning'}
                data-unmanaged-entry
              >
                <span class={cx(statusPill, entry.state === 'unmanaged-copy' ? statusPillInfo : statusPillWarn)}
                  >{entry.state === 'unmanaged-copy' ? 'copy' : 'symlink'}</span
                >
                <span class={skillsPathText} title={entry.path}>{entry.name}</span>
                <button class={ghostButton} onclick={onReviewEntry} type="button">Review consolidation</button>
              </div>
            {/each}
          </div>
        </details>
      {/each}
    {/if}
  </div>
</details>
