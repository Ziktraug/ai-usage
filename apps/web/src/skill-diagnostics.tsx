import { css, cx } from '@ai-usage/design-system/css';
import {
  meta,
  panelHeader,
  panelTitle,
  skillsDiagnosticRow,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { SkillDiagnostic } from '@ai-usage/skills';
import { For, Show } from 'solid-js';
import { fmtNum } from './shared';
import { skillDiagnosticLabel } from './skills-page-model';

const section = css({
  display: 'grid',
  gap: '10px',
});

const diagnosticPillClass = (diagnostic: SkillDiagnostic): string => {
  if (diagnostic.severity === 'error') {
    return statusPillDanger;
  }
  if (diagnostic.severity === 'warning') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

export const SkillDiagnostics = (props: { diagnostics: readonly SkillDiagnostic[] }) => (
  <Show when={props.diagnostics.length > 0}>
    <section class={section}>
      <div class={panelHeader}>
        <h3 class={panelTitle}>Diagnostics</h3>
      </div>
      <For each={props.diagnostics}>
        {(diagnostic) => (
          <div class={skillsDiagnosticRow}>
            <span class={cx(statusPill, diagnosticPillClass(diagnostic))}>{diagnostic.severity}</span>
            <div class={strongCell}>{skillDiagnosticLabel(diagnostic.code)}</div>
            <div class={meta}>{diagnostic.message}</div>
            <Show when={diagnostic.tokenMeasurement}>
              {(measurement) => (
                <div class={meta} data-token-measurement>
                  {fmtNum(measurement().observed)} / {fmtNum(measurement().threshold)} tokens
                </div>
              )}
            </Show>
          </div>
        )}
      </For>
    </section>
  </Show>
);
