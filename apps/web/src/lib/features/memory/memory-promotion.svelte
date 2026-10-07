<script lang="ts">
  import type { MemoryPromotionInput } from '@ai-usage/web-contract/memory';
  import type { SessionAnalysis, SourcedAssertion } from '@ai-usage/web-contract/session-distillation';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { memoryProposalReviewsKey } from '../../query/options/memory';
  import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import {
    memoryButton,
    memoryCopy,
    memoryField,
    memoryHeading,
    memoryInput,
    memoryPanel,
    memoryRow,
    memoryStack,
  } from './memory-styles';
  import { analysisTitle, memoryHref } from './memory-url';

  let {
    analysis,
    elementKey,
    assertion,
    projectName,
    onClose,
  }: {
    analysis: SessionAnalysis;
    elementKey: string;
    assertion: SourcedAssertion;
    projectName: string;
    onClose: () => void;
  } = $props();
  let title = $state(untrack(() => analysisTitle(assertion.text)));
  let formulation = $state(untrack(() => assertion.text));
  let kind = $state<MemoryPromotionInput['kind']>('lesson');
  let sensitivity = $state<'normal' | 'sensitive'>('normal');
  let localOnly = $state(false);
  let pending = $state(false);
  let message = $state('');
  let proposalId = $state<string | null>(null);
  const client = useWebQueryRpcContext().rpc.memory;
  const queryClient = useQueryClient();
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!localOnly || pending) {
      return;
    }
    pending = true;
    message = '';
    try {
      const result = await client.promote({
        analysisId: analysis.id,
        projectId: analysis.projectId,
        elementKey,
        title: title.trim(),
        formulation: formulation.trim(),
        kind,
        sensitivity,
        localOnly: true,
      });
      proposalId = result.proposalId;
      await queryClient.invalidateQueries({ queryKey: memoryProposalReviewsKey() });
    } catch {
      message =
        'The proposal could not be saved. Check the service and retry this same form; identical retries do not create another proposal.';
    } finally {
      pending = false;
    }
  };
</script>
<section aria-labelledby="promote-heading" class={memoryPanel}>
  <div class={memoryRow}>
    <h2 class={memoryHeading} id="promote-heading">Propose as knowledge</h2>
    <button class={memoryButton} onclick={onClose} type="button">Close proposal form</button>
  </div>
  <p class={memoryCopy}>
    Rewrite this passage as reusable guidance. Saving submits a proposal for a separate human review; it does not accept
    the lesson or alter this analysis.
  </p>
  {#if proposalId}
    <p class={memoryCopy} role="status">
      Proposal saved for review.
      <a href={memoryHref('/memory',{view:'review',proposal:proposalId})}>Open Pending review</a>
    </p>
  {:else}
    <form class={memoryStack} onsubmit={submit}>
      <label class={memoryField}
        >Knowledge title<input class={memoryInput} maxlength="512" required bind:value={title}></label
      >
      <div class={memoryRow}>
        <label class={memoryField}
          >Knowledge type<select class={memoryInput} bind:value={kind}>
            {#each ['decision','pattern','pitfall','command','constraint','handoff','lesson','preference'] as option}
              <option value={option}>{option}</option>
            {/each}
          </select></label
        >
        <label class={memoryField}
          >Sensitivity<select class={memoryInput} bind:value={sensitivity}>
            <option value="normal">Normal</option>
            <option value="sensitive">Sensitive</option>
          </select></label
        >
      </div>
      <label class={memoryField}
        >Reusable formulation<textarea
          class={memoryInput}
          maxlength="4096"
          required
          rows="5"
          bind:value={formulation}
        ></textarea></label
      >
      <p class={memoryCopy}>
        Project scope: {projectName}. Evidence stays bound to analysis revision {analysis.revision} and this selected
        passage; the service verifies its source.
      </p>
      <details open>
        <summary class={memoryCopy}>Selected evidence</summary>
        <div class={memoryStack}>
          {#each assertion.evidence as ref}
            <blockquote class={memoryCopy}>{ref.quote}</blockquote>
          {:else}
            <p class={memoryCopy}>
              No primary quotation supports this passage. Its basis is {assertion.basis}; review this limitation before
              proposing guidance.
            </p>
          {/each}
        </div>
      </details>
      <label class={memoryCopy}
        ><input required type="checkbox" bind:checked={localOnly}>
        Keep this knowledge on this device, including after acceptance. Remote publication requires a separate policy
        and consent.</label
      >
      <button
        class={memoryButton}
        disabled={!localOnly || pending || !title.trim() || !formulation.trim()}
        type="submit"
      >
        {pending ? 'Saving proposal…' : 'Submit for human review'}
      </button>
    </form>
  {/if}
  {#if message}
    <p class={memoryCopy} role="alert">{message}</p>
  {/if}
</section>
