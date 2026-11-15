<script lang="ts">
  import { type ThreadLifecycleStep, threadLifecycleSummary } from './work-thread-model';

  let { steps }: { steps: readonly ThreadLifecycleStep[] } = $props();
</script>

<!-- One shape per state, so no state is told by colour alone; the label says the rail in words. -->
<div aria-label={`Lifecycle. ${threadLifecycleSummary(steps)}`} class="wt-rail" role="img">
  {#each steps as step (step.key)}
    <span class="wt-rail-step" data-state={step.state} data-step={step.key} title={`${step.name}: ${step.detail}`}>
      <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
        {#if step.state === 'done'}
          <circle cx="6" cy="6" fill="currentColor" r="3.5" />
        {:else if step.state === 'yours'}
          <circle cx="6" cy="6" fill="none" r="5.25" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.25" />
          <circle cx="6" cy="6" fill="currentColor" r="3" />
        {:else if step.state === 'running'}
          <circle cx="6" cy="6" fill="none" r="4.25" stroke="currentColor" stroke-width="1.5" />
          <path d="M6 1.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
        {:else if step.state === 'failed'}
          <rect fill="currentColor" height="7" transform="rotate(45 6 6)" width="7" x="2.5" y="2.5" />
        {:else if step.state === 'upcoming'}
          <circle cx="6" cy="6" fill="none" r="3.75" stroke="currentColor" stroke-width="1.25" />
        {:else if step.state === 'unread'}
          <circle
            cx="6"
            cy="6"
            fill="none"
            r="4"
            stroke="currentColor"
            stroke-dasharray="1.6 1.9"
            stroke-width="1.25"
          />
        {:else if step.state === 'none'}
          <circle cx="6" cy="6" fill="currentColor" r="1.25" />
        {/if}
      </svg>
    </span>
  {/each}
</div>
