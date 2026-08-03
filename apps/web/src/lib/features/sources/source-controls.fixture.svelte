<script lang="ts">
  import {
    collectionSourceDefinitions,
    type SourceControlCommand,
    type SourceControlEntryView,
    type SourceControlView,
  } from '@ai-usage/report-core/source-control';
  import type { SourceControlClientState } from '../../../source-control-client';
  import { provideSourceControl } from './context.svelte';
  import SourceActions from './source-actions.svelte';
  import SourceControlSummary from './source-control-summary.svelte';

  let { pending = false }: { pending?: boolean } = $props();

  const definition = collectionSourceDefinitions[0];
  if (definition === undefined) {
    throw new Error('The source-control catalogue must expose a synthetic fixture source.');
  }
  const source: SourceControlEntryView = {
    availability: 'detected',
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'success',
    lifecycle: 'scheduled',
    policy: 'enabled',
    reason: { code: 'none' },
    warnings: [],
  };
  const snapshot: SourceControlView = {
    generatedAt: '2026-08-03T10:00:00.000Z',
    generation: 1,
    instanceId: 'synthetic-source-controls',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 0,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: [source],
  };
  const state = $derived<SourceControlClientState>({
    commandError: null,
    connection: 'live',
    pendingCommand: pending ? { command: 'run-now', sourceId: source.id } : null,
    publication: null,
    snapshot,
  });
  const execute = (_command: SourceControlCommand): Promise<boolean> => Promise.resolve(true);

  provideSourceControl({ execute, state: () => state });
</script>

<div data-source-actions-fixture>
  <SourceActions available {execute} {pending} {source} />
</div>
<div data-source-summary-fixture>
  <SourceControlSummary />
</div>
