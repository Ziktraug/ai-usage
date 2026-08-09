<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SkillDiagnostic } from '@ai-usage/skills';
  import { skillDiagnosticLabel } from '../../../../skills-page-model';
  import { fmtNum } from '../../../foundation/presentation/format';
  import { dangerPill, diagnosticRow, heading, infoPill, muted, pill, stack, warningPill } from './styles';

  let { diagnostics }: { diagnostics: readonly SkillDiagnostic[] } = $props();
  const tone = (severity: SkillDiagnostic['severity']): string => {
    if (severity === 'error') {
      return dangerPill;
    }
    if (severity === 'warning') {
      return warningPill;
    }
    return infoPill;
  };
</script>

{#if diagnostics.length > 0}
  <section class={stack}>
    <h3 class={heading}>Diagnostics</h3>
    {#each diagnostics as diagnostic}
      <div class={diagnosticRow}>
        <span class={cx(pill, tone(diagnostic.severity))}>{diagnostic.severity}</span>
        <strong>{skillDiagnosticLabel(diagnostic.code)}</strong>
        <div class={muted}>{diagnostic.message}</div>
        {#if diagnostic.tokenMeasurement}
          <div class={muted} data-token-measurement>
            {fmtNum(diagnostic.tokenMeasurement.observed)}
            / {fmtNum(diagnostic.tokenMeasurement.threshold)} tokens
          </div>
        {/if}
      </div>
    {/each}
  </section>
{/if}
