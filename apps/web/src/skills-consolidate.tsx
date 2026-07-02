import { css, cx } from '@ai-usage/design-system/css';
import {
  HarnessBadge,
  meta,
  muted,
  panel,
  statusPill,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import { For, Show } from 'solid-js';
import type { UnmanagedGroup } from './skills-page-model';

const fold = css({
  p: '0',
  overflow: 'hidden',
});

const summaryRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  p: '14px 16px',
  cursor: 'pointer',
});

const body = css({
  display: 'grid',
  gap: '12px',
  p: '0 16px 16px',
});

const groupRow = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'auto minmax(0, 1fr) auto' },
  gap: '8px 12px',
  alignItems: 'center',
  p: '10px 0',
  borderTop: '1px solid token(colors.line)',
});

const monoPath = css({
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'muted',
  overflowWrap: 'anywhere',
});

export const SkillsConsolidate = (props: { groups: readonly UnmanagedGroup[]; total: number }) => (
  <details class={cx(panel, fold)}>
    <summary class={summaryRow}>
      <span class={strongCell}>To consolidate</span>
      <span class={cx(statusPill, statusPillWarn)}>{props.total}</span>
    </summary>
    <div class={body}>
      <p class={muted}>
        These skills live directly in runtime folders, outside your source repository. Adopting them means moving them
        into the source repo and symlinking back. Nothing is ever deleted automatically.
      </p>
      <Show fallback={<p class={meta}>No unmanaged target entries.</p>} when={props.groups.length > 0}>
        <For each={props.groups}>
          {(group) => (
            <div class={groupRow}>
              <HarnessBadge name={group.targetLabel} />
              <span class={monoPath}>{group.targetPath}</span>
              <span class={meta}>
                {group.copies} copies · {group.symlinks} symlinks
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  </details>
);
