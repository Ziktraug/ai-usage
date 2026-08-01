import {
  demoBadge,
  eyebrow,
  eyebrowRow,
  header,
  headerTop,
  meta,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import { Show } from 'solid-js';
import { fmtDate } from './shared';

export interface DashboardHeaderProps {
  generatedAt: string;
  hasReportData: boolean;
  isDemo: boolean;
}

export const DashboardHeader = (props: DashboardHeaderProps) => (
  <header class={header}>
    <div class={headerTop}>
      <div class={titleBlock}>
        <div class={eyebrowRow}>
          <div class={eyebrow}>ai-usage</div>
          <Show when={props.isDemo}>
            <span class={demoBadge}>Demo data</span>
          </Show>
        </div>
        <h1 class={title}>Usage report</h1>
        <div class={meta}>
          <Show fallback="Report payload unavailable" when={props.hasReportData}>
            Generated {fmtDate(props.generatedAt)}
          </Show>
        </div>
      </div>
    </div>
  </header>
);
