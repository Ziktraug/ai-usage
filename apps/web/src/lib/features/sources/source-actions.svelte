<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { SourceControlCommand, SourceControlEntryView } from '@ai-usage/report-core/source-control';
  import {
    pendingAriaBusyAttributes,
    sourceCanRun,
    sourceMutationDisabledReason,
    sourceRunDisabledReason,
  } from './model';
  import { actionRow, ghostButton } from './styles';

  let {
    available,
    execute,
    pending,
    source,
  }: {
    available: boolean;
    execute: (command: SourceControlCommand) => Promise<boolean>;
    pending: boolean;
    source: SourceControlEntryView;
  } = $props();

  const switchLabel = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    fontSize: '12px',
    fontWeight: 650,
  });

  const setEnabled = (event: Event): void => {
    if (!(event.currentTarget instanceof HTMLInputElement)) {
      return;
    }
    execute({
      command: 'set-enabled',
      enabled: event.currentTarget.checked,
      sourceId: source.id,
    }).catch(() => undefined);
  };
</script>

<div class={actionRow} data-source-actions>
  <label class={switchLabel}>
    <input
      checked={source.policy === 'enabled'}
      disabled={!available || pending}
      onchange={setEnabled}
      title={sourceMutationDisabledReason(pending, available)}
      type="checkbox"
    >
    Enabled
  </label>
  <button
    {...pendingAriaBusyAttributes(pending)}
    class={ghostButton}
    disabled={!available || pending || !sourceCanRun(source)}
    onclick={() => execute({ command: 'run-now', sourceId: source.id }).catch(() => undefined)}
    title={sourceRunDisabledReason(source, pending, available)}
    type="button"
  >
    Run now
  </button>
</div>
