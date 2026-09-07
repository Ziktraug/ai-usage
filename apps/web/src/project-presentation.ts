import type { UsageReportProjectGroup } from '@ai-usage/report-core/report-data';
import type { ProjectGroup } from './dashboard-analytics';
import { breakdownLabelMatchesSearch } from './group-panel-presentation';
import { fmtNum } from './lib/foundation/presentation/format';

export type ProjectDataQualityLabel = 'Filename-like' | 'No detected project' | 'Worktree-like';

const FILENAME_LIKE_PATTERN = /\.csv$/i;
const PROJECT_PATH_SEPARATOR_PATTERN = /[/\\]/;
const WORKTREE_LIKE_PATTERN = /^(agent|worktree)-[a-z0-9][a-z0-9-]*$/i;

const projectBasename = (projectLabel: string): string => {
  const segments = projectLabel.split(PROJECT_PATH_SEPARATOR_PATTERN);
  return segments.at(-1) ?? projectLabel;
};

export const projectDataQualityLabel = (projectLabel: string): ProjectDataQualityLabel | null => {
  if (projectLabel === '(unknown)') {
    return 'No detected project';
  }
  const basename = projectBasename(projectLabel);
  if (FILENAME_LIKE_PATTERN.test(basename)) {
    return 'Filename-like';
  }
  if (WORKTREE_LIKE_PATTERN.test(basename)) {
    return 'Worktree-like';
  }
  return null;
};

export interface ProjectIdentityPresentation {
  readonly grouped: boolean;
  readonly machines: readonly string[];
  readonly name: string;
}

const projectMachineLabels = (entry: UsageReportProjectGroup): string[] => {
  const machines = new Map<string, string>();
  for (const source of entry.sources) {
    const label = source.machineLabel.trim();
    if (label && !machines.has(source.machineId)) {
      machines.set(source.machineId, label);
    }
  }
  const labelCounts = new Map<string, number>();
  for (const label of machines.values()) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return [...machines].map(([machineId, label]) =>
    (labelCounts.get(label) ?? 0) > 1 ? `${label} (${machineId})` : label,
  );
};

export const projectIdentityPresentation = (
  project: Pick<ProjectGroup, 'key' | 'label'>,
  catalogue: readonly UsageReportProjectGroup[] | undefined,
): ProjectIdentityPresentation => {
  const entry = catalogue?.find((group) => group.id === project.key);
  if (!entry) {
    return { grouped: false, machines: [], name: project.label };
  }
  const machines = projectMachineLabels(entry);
  if (entry.grouped) {
    return { grouped: true, machines, name: entry.name };
  }
  return { grouped: false, machines, name: entry.sources[0]?.project.trim() || '(unknown)' };
};

export interface ProjectLinesPresentation {
  readonly coverage: string | null;
  readonly label: string;
  readonly status: 'exact' | 'lower-bound' | 'unknown';
  readonly title: string;
}

export const projectLinesPresentation = (
  project: Pick<ProjectGroup, 'lineMeasurement' | 'linesAdded' | 'linesDeleted'>,
): ProjectLinesPresentation => {
  const { measuredSessions, totalSessions } = project.lineMeasurement;
  if (measuredSessions === 0) {
    return {
      coverage: null,
      label: '—',
      status: 'unknown',
      title: `No session in this project reports line changes (0 of ${fmtNum(totalSessions)} measured)`,
    };
  }
  const delta = `+${fmtNum(project.linesAdded)}/-${fmtNum(project.linesDeleted)}`;
  if (measuredSessions < totalSessions) {
    // A lower bound of zero says nothing a reader can use; the coverage line already states the
    // measured scope, so the value reads as the measured zero it is instead of "at least nothing".
    const measuredZero = project.linesAdded === 0 && project.linesDeleted === 0;
    return {
      coverage: `${fmtNum(measuredSessions)} of ${fmtNum(totalSessions)} sessions measured`,
      label: measuredZero ? delta : `≥ ${delta}`,
      status: 'lower-bound',
      title: measuredZero
        ? `No line changes reported by the ${fmtNum(measuredSessions)} of ${fmtNum(totalSessions)} sessions that report line counts; the rest are not counted`
        : `Lines added/deleted summed over the ${fmtNum(measuredSessions)} of ${fmtNum(totalSessions)} sessions that report line changes; the rest are not counted`,
    };
  }
  return {
    coverage: null,
    label: delta,
    status: 'exact',
    title: `Lines added/deleted summed over all ${fmtNum(totalSessions)} sessions`,
  };
};

export const projectSearchRows = <T extends Pick<ProjectGroup, 'key' | 'label'>>(
  groups: readonly T[],
  query: string,
  catalogue: readonly UsageReportProjectGroup[] | undefined,
): T[] =>
  groups.filter((project) => {
    const identity = projectIdentityPresentation(project, catalogue);
    return breakdownLabelMatchesSearch(`${identity.name} ${identity.machines.join(' ')} ${project.label}`, query);
  });

export const projectsEmptyMessage = (query: string): string =>
  query.trim() ? 'No breakdown rows match this search' : 'No projects';
