<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import { createDirtyGuardRegistry, provideDirtyGuardRegistry } from '../../shell/dirty-navigation-context';
  import SkillsEditorSlot from '../editor/skills-editor-slot.svelte';
  import type { SkillsHealthOperationOwner } from '../management/operation-episode.svelte';
  import SkillsHealthSlot from '../management/skills-health-slot.svelte';
  import {
    syntheticManagementOperationEpisode,
    syntheticManagementSnapshot,
  } from '../management/synthetic-fixture.test-helper';
  import { createSkillsPresentationProjection } from '../presentation';
  import { createSkillsShellViewModel } from './model';
  import SkillsWorkspace from './skills-workspace.svelte';
  import type { SkillsShellSlotContext, SkillsSnapshotUpdatePort } from './slot-context';
  import {
    syntheticExposureTruncatedObservations,
    syntheticInventories,
    syntheticKnownPaths,
    syntheticManagedDocument,
    syntheticObservations,
    syntheticProjectDocument,
    syntheticProvisionalObservations,
    syntheticSnapshot,
  } from './synthetic-fixture.test-helper';

  let {
    healthSnapshot,
    omitObservationName,
    managementNotice = false,
    managementPending,
    observationsError,
    observationsExposureTruncated = false,
    observationsLoading = false,
    retainObservationsOnError = false,
    observationsSkipped = 0,
    producerCompletenessMissing = false,
    observationsProvisional = false,
    pathname = '/skills/global/alpha-skill',
  }: {
    healthSnapshot?: 'management';
    omitObservationName?: string;
    managementNotice?: boolean;
    managementPending?: string;
    observationsError?: string;
    observationsExposureTruncated?: boolean;
    observationsLoading?: boolean;
    retainObservationsOnError?: boolean;
    observationsSkipped?: number;
    producerCompletenessMissing?: boolean;
    observationsProvisional?: boolean;
    pathname?: string;
  } = $props();

  provideDirtyGuardRegistry(createDirtyGuardRegistry());
  const snapshot = $derived(healthSnapshot === 'management' ? syntheticManagementSnapshot() : syntheticSnapshot());
  const view = $derived(
    createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname,
      snapshot,
    }),
  );
  const observations = $derived.by(() => {
    if (observationsLoading || (observationsError !== undefined && !retainObservationsOnError)) {
      return;
    }
    const boundedObservations = observationsProvisional ? syntheticProvisionalObservations : syntheticObservations;
    let selectedObservations = observationsExposureTruncated
      ? syntheticExposureTruncatedObservations
      : boundedObservations;
    if (producerCompletenessMissing) {
      selectedObservations = {
        ...syntheticProvisionalObservations,
        producerCompletenessMissing: true,
        producerProofValidUntil: null,
      };
    }
    const observationsWithSkipped =
      observationsSkipped > 0 ? { ...selectedObservations, skipped: observationsSkipped } : selectedObservations;
    return omitObservationName === undefined
      ? observationsWithSkipped
      : {
          ...observationsWithSkipped,
          skills: observationsWithSkipped.skills.filter((skill) => skill.skillName !== omitObservationName),
        };
  });
  const presentation = $derived(createSkillsPresentationProjection({ observations, observationsError, view }));
  const managementNoticeOwner = $derived<SkillsHealthOperationOwner | undefined>(
    managementNotice ? 'health-page' : undefined,
  );
  const management = $derived(
    syntheticManagementOperationEpisode({
      ...(managementNoticeOwner === undefined
        ? {}
        : {
            notice: {
              message: 'Synthetic operation complete.',
              owner: managementNoticeOwner,
              tone: 'success' as const,
            },
          }),
      pendingOperation: managementPending ?? null,
    }),
  );
  // Mirrors the shell, which resolves a managed document for a global selection and a read-only
  // project document for a project one. A fixture that always handed over the managed document made
  // the project branch render its "preview unavailable" placeholder in every test.
  const selectedDocument = $derived(
    view.selectionDetail.kind === 'project-skill' ? syntheticProjectDocument : syntheticManagedDocument,
  );
  const snapshotUpdates: SkillsSnapshotUpdatePort = {
    pendingDecision: undefined,
    registerDraft: () => undefined,
    unregisterDraft: () => undefined,
  };
</script>

{#snippet editorSlot(_context: SkillsShellSlotContext)}
  <SkillsEditorSlot context={_context} />
{/snippet}
{#snippet healthSlot(_context: SkillsShellSlotContext)}
  <SkillsHealthSlot context={_context} />
{/snippet}

<WebQueryProvider>
  <SkillsWorkspace
    {editorSlot}
    {healthSlot}
    {management}
    {presentation}
    {selectedDocument}
    snapshot={view.snapshot}
    {snapshotUpdates}
    {view}
  />
</WebQueryProvider>
