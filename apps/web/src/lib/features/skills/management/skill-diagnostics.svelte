<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { SkillDiagnostic } from '@ai-usage/skills';
  import { skillDiagnosticLabel } from '../../../../skills-page-model';
  import { fmtNum } from '../../../foundation/presentation/format';
  import { diagnosticRow, heading, infoPill, muted, pill, stack } from './styles';

  let { diagnostics }: { diagnostics: readonly SkillDiagnostic[] } = $props();
</script>

{#if diagnostics.length > 0}
  <section class={stack}>
    <h3 class={heading}>Diagnostics</h3>
    {#each diagnostics as diagnostic}
      <div class={diagnosticRow}>
        <span class={css(pill, diagnostic.severity !== 'error' && diagnostic.severity !== 'warning' && infoPill)}
          >{diagnostic.severity}</span
        >
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
