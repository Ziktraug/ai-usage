import { Checkbox, Popover } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import { ghostButton, popoverContent, popoverGrid, popoverHeader } from '@ai-usage/design-system/report';
import { type SessionOrigin, sessionOriginLabel, sessionOrigins } from '@ai-usage/report-core/session-query';
import { For } from 'solid-js';
import { defaultDashboardOrigins, isDefaultDashboardOriginSelection } from './dashboard-search';

const originTrigger = css({
  minW: { base: 0, sm: '190px' },
  flex: { base: '1 1 190px', sm: '0 1 220px' },
  justifyContent: 'space-between',
  borderColor: 'accent',
  bg: 'accentTint',
  color: 'ink',
});

const neutralOriginTrigger = css({
  borderColor: 'line',
  bg: 'surface',
});

const normalizedSelection = (origins: readonly SessionOrigin[]): readonly SessionOrigin[] =>
  origins.length === 0 ? sessionOrigins : origins;

export const originFilterLabel = (origins: readonly SessionOrigin[]): string => {
  if (isDefaultDashboardOriginSelection(origins)) {
    return 'Origin: human + delegated';
  }
  if (origins.length === 0) {
    return 'Origin: all';
  }
  return `Origin: ${origins.map((origin) => sessionOriginLabel(origin).toLowerCase()).join(' + ')}`;
};

export const OriginFilter = (props: { onValueChange: (origins: SessionOrigin[]) => void; value: SessionOrigin[] }) => {
  const setOriginChecked = (origin: SessionOrigin, checked: boolean): void => {
    const selected = new Set(normalizedSelection(props.value));
    if (checked) {
      selected.add(origin);
    } else {
      selected.delete(origin);
    }
    const next = sessionOrigins.filter((candidate) => selected.has(candidate));
    props.onValueChange(next.length === sessionOrigins.length ? [] : next);
  };

  return (
    <Popover
      contentClass={popoverContent}
      trigger={<span>{originFilterLabel(props.value)} ▾</span>}
      triggerAriaLabel="Filter by origin"
      triggerClass={props.value.length === 0 ? cx(originTrigger, neutralOriginTrigger) : originTrigger}
    >
      <div class={popoverHeader}>
        <span>Session origin</span>
        <div>
          <button class={ghostButton} onClick={() => props.onValueChange([...defaultDashboardOrigins])} type="button">
            Default
          </button>
          <button class={ghostButton} onClick={() => props.onValueChange([])} type="button">
            All
          </button>
        </div>
      </div>
      <div class={popoverGrid}>
        <For each={sessionOrigins}>
          {(origin) => (
            <Checkbox
              checked={normalizedSelection(props.value).includes(origin)}
              onCheckedChange={(checked) => setOriginChecked(origin, checked)}
            >
              {sessionOriginLabel(origin)}
            </Checkbox>
          )}
        </For>
      </div>
    </Popover>
  );
};
