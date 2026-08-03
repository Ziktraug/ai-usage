import { css } from '@ai-usage/design-system/css';
import { detailItem, detailLabel, detailValue, popoverContent } from '@ai-usage/design-system/report';
import { Popover } from '@ai-usage/design-system/solid';
import { Show } from 'solid-js';

const detailLabelRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '6px',
});

const detailInfoButton = css({
  display: 'inline-grid',
  placeItems: 'center',
  w: '24px',
  h: '24px',
  p: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '12px',
  fontWeight: 700,
  cursor: 'pointer',
  _hover: { borderColor: 'lineStrong', color: 'ink' },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const detailHintContent = css({
  maxW: '320px',
  color: 'ink',
  fontSize: '13px',
  lineHeight: 1.5,
});

export const DrawerDetailItem = (props: { hint?: string; label: string; value: string }) => (
  <div class={detailItem} data-detail-item={props.label}>
    <div class={detailLabelRow}>
      <div class={detailLabel}>{props.label}</div>
      <Show when={props.hint}>
        {(hint) => (
          <Popover
            contentClass={popoverContent}
            trigger={<span aria-hidden="true">i</span>}
            triggerAriaLabel={`About ${props.label}`}
            triggerClass={detailInfoButton}
          >
            <div class={detailHintContent}>{hint()}</div>
          </Popover>
        )}
      </Show>
    </div>
    <div class={detailValue}>{props.value}</div>
  </div>
);
