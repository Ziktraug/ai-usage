import {
  matchesProjectSourceSelector,
  type ProjectGroupConfig,
  type ProjectSourceSelector,
  projectSourceSelectorFor,
  uniqueProjectSourceSelectors,
} from '@ai-usage/report-core/project-group';
import type { UsageReportProjectSource } from '@ai-usage/report-core/report-data';

interface MoveProjectSourcesToGroupInput {
  createGroupId: string;
  groupName: string;
  projectGroups: ProjectGroupConfig[];
  projectSources: UsageReportProjectSource[];
  selectedSources: UsageReportProjectSource[];
}

const matchesSource = (source: UsageReportProjectSource, selector: ProjectSourceSelector) =>
  matchesProjectSourceSelector(
    {
      gitRemote: source.gitRemote,
      machineId: source.machineId,
      project: source.project,
      sourcePath: source.sourcePath,
    },
    selector,
  );

const removeSelectedSourcesFromGroup = (
  group: ProjectGroupConfig,
  projectSources: UsageReportProjectSource[],
  selectedSourceIds: Set<string>,
): ProjectGroupConfig | null => {
  const sources: ProjectSourceSelector[] = [];
  for (const selector of group.sources) {
    const matchingSources = projectSources.filter((source) => matchesSource(source, selector));
    const matchesSelection = matchingSources.some((source) => selectedSourceIds.has(source.id));
    if (!matchesSelection) {
      sources.push(selector);
      continue;
    }
    for (const source of matchingSources) {
      if (!selectedSourceIds.has(source.id)) {
        sources.push(projectSourceSelectorFor(source));
      }
    }
  }
  const uniqueSources = uniqueProjectSourceSelectors(sources);
  return uniqueSources.length ? { ...group, sources: uniqueSources } : null;
};

export const moveProjectSourcesToGroup = ({
  createGroupId,
  groupName,
  projectGroups,
  projectSources,
  selectedSources,
}: MoveProjectSourcesToGroupInput): ProjectGroupConfig[] => {
  const existingTarget = projectGroups.find((group) => group.name.toLowerCase() === groupName.toLowerCase());
  const selectedSourceIds = new Set(selectedSources.map((source) => source.id));
  const target: ProjectGroupConfig = {
    id: existingTarget?.id ?? createGroupId,
    name: groupName,
    sources: uniqueProjectSourceSelectors([
      ...(existingTarget?.sources ?? []),
      ...selectedSources.map(projectSourceSelectorFor),
    ]),
  };
  const updatedGroupsById = new Map<string, ProjectGroupConfig>();
  for (const group of projectGroups) {
    if (group.id === target.id) {
      continue;
    }
    const updated = removeSelectedSourcesFromGroup(group, projectSources, selectedSourceIds);
    if (updated) {
      updatedGroupsById.set(updated.id, updated);
    }
  }

  const result: ProjectGroupConfig[] = [];
  for (const group of projectGroups) {
    if (group.id === target.id) {
      result.push(target);
      continue;
    }
    const updated = updatedGroupsById.get(group.id);
    if (updated) {
      result.push(updated);
    }
  }
  if (!existingTarget) {
    result.push(target);
  }
  return result;
};
