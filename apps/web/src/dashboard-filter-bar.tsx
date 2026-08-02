import { MultiSelect, Tooltip } from '@ai-usage/design-system';
import { css } from '@ai-usage/design-system/css';
import { searchInput, summaryPill } from '@ai-usage/design-system/report';
import type { SessionOrigin } from '@ai-usage/report-core/session-query';
import { Show } from 'solid-js';
import { SourceControlSummary } from './components/source-control-summary';
import { OriginFilter } from './origin-filter';

const toolbar = css({
  position: { base: 'static', md: 'sticky' },
  top: '0',
  zIndex: 20,
  display: 'flex',
  flexDirection: { base: 'column', sm: 'row' },
  flexWrap: { base: 'nowrap', sm: 'wrap' },
  gap: { base: '8px', sm: '10px' },
  alignItems: 'center',
  py: { base: '8px', sm: '12px' },
  bg: 'canvas',
  borderBottom: '1px solid token(colors.line)',
  _print: { display: 'none' },
  '& > input': {
    flex: { base: 'none', sm: '1 1 240px' },
    minW: { base: 0, sm: '180px' },
    w: { base: 'full', sm: 'auto' },
  },
});

const controls = css({
  display: { base: 'grid', sm: 'contents' },
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  w: { base: 'full', sm: 'auto' },
  gap: { base: '8px', sm: '0' },
  alignItems: 'center',
  '& > *': { minW: 0, w: { base: 'full', sm: 'auto' } },
  '& > :last-child:nth-child(odd)': { gridColumn: { base: '1 / -1', sm: 'auto' } },
});

interface MultiValueFilter {
  onChange: (value: string[]) => void;
  options: string[];
  value: string[];
}

interface MachineFilter extends MultiValueFilter {
  attention: boolean;
  labelFor: (value: string) => string;
}

interface QueryFilter {
  inputRef: (element: HTMLInputElement) => void;
  onCommit: () => void;
  onInput: (value: string) => void;
  value: string;
}

export interface DashboardFilterBarProps {
  freshnessStatus: string | null;
  freshnessUnavailable: boolean;
  harness: MultiValueFilter;
  isDemo: boolean;
  machine: MachineFilter;
  onOriginChange: (value: SessionOrigin[]) => void;
  origin: SessionOrigin[];
  query: QueryFilter;
}

export const DashboardFilterBar = (props: DashboardFilterBarProps) => (
  <div class={toolbar} data-dashboard-filter-stack>
    <input
      aria-label="Filter sessions by title, project, model, provider, or harness"
      class={searchInput}
      onBlur={props.query.onCommit}
      onInput={(event) => props.query.onInput(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          props.query.onCommit();
        }
      }}
      placeholder="Filter by title, project, model…  ( / )"
      ref={props.query.inputRef}
      value={props.query.value}
    />
    <div class={controls}>
      <MultiSelect
        label="Filter by harness"
        noun="harnesses"
        onValueChange={props.harness.onChange}
        options={props.harness.options}
        placeholder="All harnesses"
        value={props.harness.value}
      />
      <OriginFilter onValueChange={props.onOriginChange} value={props.origin} />
      <Show when={props.freshnessStatus}>
        {(label) => (
          <Show
            fallback={
              <span aria-live="polite" class={summaryPill}>
                {label()}
              </span>
            }
            when={props.freshnessUnavailable}
          >
            <Tooltip content="No source freshness observation is available for this report revision.">
              <span aria-live="polite" class={summaryPill}>
                {label()}
              </span>
            </Tooltip>
          </Show>
        )}
      </Show>
      <Show when={props.machine.options.length > 1 || props.machine.attention}>
        <MultiSelect
          label="Filter by machine"
          noun="machines"
          onValueChange={props.machine.onChange}
          optionLabel={props.machine.labelFor}
          options={props.machine.options}
          placeholder="All machines"
          value={props.machine.value}
        />
      </Show>
      <Show when={!props.isDemo}>
        <SourceControlSummary />
      </Show>
    </div>
  </div>
);
