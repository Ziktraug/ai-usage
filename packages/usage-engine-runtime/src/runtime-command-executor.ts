import type {
  CollectionSourceId,
  SourceControlEntryView,
  SourceControlView,
} from '@ai-usage/report-core/source-control';
import {
  type UsageEngineCollectionOutput,
  type UsageEngineCommand,
  type UsageEngineCursorImportOutput,
  type UsageEngineMachineOutput,
  type UsageEngineMergePreviewOutput,
  type UsageEnginePublicationOutput,
  usageEngineReportSourceIdsFor,
} from '@ai-usage/usage-engine-control';
import type { UsageEngineRuntimeDependencies } from './runtime';
import { UsageEngineSoftSourceError } from './runtime-errors';

export type UsageEngineCommandOutput =
  | UsageEngineCollectionOutput
  | UsageEngineCursorImportOutput
  | UsageEngineMachineOutput
  | UsageEngineMergePreviewOutput
  | UsageEnginePublicationOutput
  | undefined;

interface RuntimeCommandExecutorState {
  readonly currentPublicationFor: (
    sourceControl: SourceControlView,
  ) => UsageEnginePublicationOutput['publication'] | null;
  readonly sourceControl: () => SourceControlView;
  readonly withCurrentPublication: (snapshot: SourceControlView) => SourceControlView;
}

export const createRuntimeCommandExecutor = (
  dependencies: UsageEngineRuntimeDependencies,
  state: RuntimeCommandExecutorState,
): ((command: UsageEngineCommand, signal: AbortSignal) => Promise<UsageEngineCommandOutput>) => {
  const runWithoutObservation = async (
    command: UsageEngineCommand,
    signal: AbortSignal,
  ): Promise<UsageEngineCommandOutput> => {
    const runSourceSoftly = async (sourceId: CollectionSourceId): Promise<SourceControlView> => {
      try {
        return state.withCurrentPublication(await dependencies.sourceControl.runSource(sourceId, signal));
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        if (error instanceof UsageEngineSoftSourceError && error.sourceId === sourceId) {
          return state.withCurrentPublication(error.snapshot);
        }
        throw error;
      }
    };
    const collectSources = async (sourceIds: readonly CollectionSourceId[]): Promise<UsageEngineCollectionOutput> => {
      const sources: SourceControlEntryView[] = [];
      let finalSnapshot = state.sourceControl();
      for (const sourceId of sourceIds) {
        const snapshot = await runSourceSoftly(sourceId);
        const source = snapshot.sources.find(({ id }) => id === sourceId);
        if (!source) {
          throw new Error(`Source-control snapshot omitted ${sourceId}.`);
        }
        sources.push(source);
        finalSnapshot = snapshot;
      }
      const publication = state.currentPublicationFor(finalSnapshot);
      if (!publication) {
        throw new Error('A fresh collection command completed without a durable publication.');
      }
      return { kind: 'collection', publication, sources };
    };

    switch (command.command) {
      case 'detect-all':
        await dependencies.sourceControl.detectAll(signal);
        return;
      case 'collect-fresh-report':
        return await collectSources(usageEngineReportSourceIdsFor(command));
      case 'run-all-enabled':
        await dependencies.sourceControl.runAllEnabled(signal);
        return;
      case 'run-source':
        await dependencies.sourceControl.runSource(command.sourceId, signal);
        return;
      case 'publish': {
        const publication = state.currentPublicationFor(await dependencies.sourceControl.publish(signal));
        if (!publication) {
          throw new Error('A publication command completed without a durable revision.');
        }
        return { kind: 'publication', publication };
      }
      case 'set-source-enabled':
        await dependencies.sourceControl.setSourceEnabled(command.sourceId, command.enabled, signal);
        return;
      case 'replace-project-groups':
        await dependencies.mutation.replaceProjectGroups(command, signal);
        await dependencies.sourceControl.publish(signal);
        return;
      case 'replace-project-groups-by-reference':
        await dependencies.mutation.replaceProjectGroupsByReference(command, signal);
        await dependencies.sourceControl.publish(signal);
        return;
      case 'replace-project-aliases':
        await dependencies.mutation.replaceProjectAliases(command, signal);
        await dependencies.sourceControl.publish(signal);
        return;
      case 'set-machine-label': {
        const machine = await dependencies.mutation.setMachineLabel(command.label, signal);
        await dependencies.sourceControl.publish(signal);
        return { kind: 'machine', machine };
      }
      case 'set-campaign-label-override':
        await dependencies.mutation.setCampaignLabelOverride(command, signal);
        return;
      case 'collect-fresh-quota':
        return await collectSources(['codex.usage-limits']);
      case 'import-cursor': {
        const output = await dependencies.mutation.importCursor(command, signal);
        try {
          await dependencies.sourceControl.redetectAndRunSource('cursor.sessions', signal);
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
        }
        return output;
      }
      case 'preview-merge':
        return await dependencies.mutation.previewMerge(command, signal);
      case 'confirm-merge':
        await dependencies.mutation.confirmMerge(command, signal);
        try {
          await dependencies.sourceControl.publish(signal);
        } catch {
          // The durable merge succeeded. Publication demand remains durable and retries independently.
        }
        return;
      default: {
        const unsupportedCommand: never = command;
        throw new Error(`Unsupported usage engine command: ${JSON.stringify(unsupportedCommand)}`);
      }
    }
  };

  return async (command, signal) =>
    dependencies.observeCommand
      ? await dependencies.observeCommand(command.command, async () => await runWithoutObservation(command, signal))
      : await runWithoutObservation(command, signal);
};
