import { type ProjectGroupConfig, projectSourceSelectorKey } from '@ai-usage/report-core/project-group';
import type { UsageReportWarning } from '@ai-usage/report-core/report-data';

export type SaveProjectGroups = (groups: readonly ProjectGroupConfig[], revision: string) => Promise<void>;

export const saveProjectGroupsAtRevision = async (
  groups: readonly ProjectGroupConfig[],
  revision: string,
  currentRevision: () => string,
  save: SaveProjectGroups,
): Promise<void> => {
  if (currentRevision() !== revision) {
    throw new Error('The report changed before project groups could be saved.');
  }
  await save(groups, revision);
};

export const projectGroupsAfterWarningCleanup = (
  groups: readonly ProjectGroupConfig[],
  warning: UsageReportWarning,
): readonly ProjectGroupConfig[] => {
  const groupId = warning.groupId;
  if (!groupId) {
    throw new Error('This project-group warning does not identify a group to clean up.');
  }
  if (!groups.some((group) => group.id === groupId)) {
    throw new Error(`Project group ${groupId} is no longer available to clean up.`);
  }
  const removed = new Set((warning.selectors ?? []).map(projectSourceSelectorKey));
  return groups
    .filter((group) => warning.reason !== 'unmatched-group' || group.id !== groupId)
    .map((group) =>
      group.id === groupId
        ? { ...group, sources: group.sources.filter((source) => !removed.has(projectSourceSelectorKey(source))) }
        : group,
    )
    .filter((group) => group.sources.length > 0);
};
