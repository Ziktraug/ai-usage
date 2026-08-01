import { type ProjectGroupConfig, projectSourceSelectorKey } from '@ai-usage/report-core/project-group';
import { type Accessor, createSignal } from 'solid-js';
import { type FocusedReportSource, type FocusedReportStore, fetchFocusedBreakdown } from './focused-report-client';
import type { WebReportPayload } from './web-report-payload';

type ReportWarning = NonNullable<WebReportPayload['warnings']>[number];

export interface ProjectWarningCleanupOptions {
  focusedQueryScope: () => Parameters<FocusedReportSource['getBreakdown']>[0]['query'];
  focusedSource?: FocusedReportSource;
  focusedStore?: FocusedReportStore;
  onError: (message: string) => void;
  projectGroupConfigs: () => ProjectGroupConfig[];
  save: (projectGroups: ProjectGroupConfig[]) => Promise<void>;
}

export interface ProjectWarningCleanup {
  cleaningGroupId: Accessor<string | undefined>;
  cleanup: (warning: ReportWarning) => void;
}

const removeWarningSelectors = (group: ProjectGroupConfig, warning: ReportWarning): ProjectGroupConfig => {
  const removed = new Set((warning.selectors ?? []).map(projectSourceSelectorKey));
  return {
    ...group,
    sources: group.sources.filter((source) => !removed.has(projectSourceSelectorKey(source))),
  };
};

const loadProjectGroupConfigs = async (options: ProjectWarningCleanupOptions): Promise<ProjectGroupConfig[]> => {
  const { focusedSource, focusedStore } = options;
  if (!(focusedSource && focusedStore)) {
    return options.projectGroupConfigs();
  }
  let breakdown = focusedStore.breakdown();
  if (!breakdown?.context.projectGroupConfigs) {
    const request = { query: options.focusedQueryScope() };
    const result = await fetchFocusedBreakdown(focusedSource, request);
    const applied = focusedStore.applyBreakdown(request, result);
    if (!applied.applied) {
      throw new Error(`Project-group context rejected: ${applied.reason}`);
    }
    breakdown = result;
  }
  return breakdown.context.projectGroupConfigs ?? [];
};

const cleanupProjectWarning = async (options: ProjectWarningCleanupOptions, warning: ReportWarning): Promise<void> => {
  const groupId = warning.groupId;
  if (!groupId) {
    throw new Error('This project-group warning does not identify a group to clean up');
  }
  const configs = await loadProjectGroupConfigs(options);
  if (!configs.some((group) => group.id === groupId)) {
    throw new Error(`Project group ${groupId} is no longer available to clean up`);
  }
  const nextGroups = configs
    .filter((group) => warning.reason !== 'unmatched-group' || group.id !== groupId)
    .map((group) => (group.id === groupId ? removeWarningSelectors(group, warning) : group))
    .filter((group) => group.sources.length > 0);
  await options.save(nextGroups);
};

export const createProjectWarningCleanup = (options: ProjectWarningCleanupOptions): ProjectWarningCleanup => {
  const [cleaningGroupId, setCleaningGroupId] = createSignal<string>();
  const cleanup = (warning: ReportWarning): void => {
    const groupId = warning.groupId;
    if (!groupId || cleaningGroupId()) {
      return;
    }
    setCleaningGroupId(groupId);
    cleanupProjectWarning(options, warning)
      .catch((error: unknown) => {
        options.onError(error instanceof Error ? error.message : 'Failed to clean up the project group');
      })
      .finally(() => setCleaningGroupId());
  };
  return { cleaningGroupId, cleanup };
};
