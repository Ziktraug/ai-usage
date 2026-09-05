import { type ProjectSourceSelector, projectSourceSelectorLabel } from '@ai-usage/report-core/project-group';
import type { UsageReportWarning } from '@ai-usage/report-core/report-data';

/**
 * One machine's share of a warning's unmatched selectors. Paths collapse to their common directory
 * so a reader sees "11 paths under ~/projects/x" before any individual path; a path selector that
 * also constrains project or remote keeps those predicates beside the path.
 */
export interface ReportNoticeSelectorGroup {
  readonly machine: string;
  /** Machine id (or '' for "any machine") — the stable key; `machine` is only a label. */
  readonly machineId: string;
  readonly otherSelectors: readonly string[];
  readonly paths: readonly string[];
  readonly prefix: string | null;
}

export interface ReportNotice {
  readonly harness?: string;
  readonly headline: string;
  readonly selectorCount: number;
  readonly selectorGroups: readonly ReportNoticeSelectorGroup[];
  readonly warning: UsageReportWarning;
}

const HOME_PATTERN = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

/** Directory-boundary common prefix; `null` when the paths share nothing usable or there is one path. */
export const commonDirectoryPrefix = (paths: readonly string[]): string | null => {
  if (paths.length < 2) {
    return null;
  }
  const segments = paths.map((path) => path.split('/'));
  const first = segments[0] ?? [];
  let depth = 0;
  while (depth < first.length && segments.every((parts) => parts[depth] === first[depth])) {
    depth += 1;
  }
  // Every path is inside the prefix, never equal to it: a prefix that *is* one of the paths would
  // print that path as an empty relative entry.
  while (depth > 0 && segments.some((parts) => parts.length <= depth)) {
    depth -= 1;
  }
  const prefix = first.slice(0, depth).join('/');
  return prefix.length > 1 ? prefix : null;
};

const relativeTo = (path: string, prefix: string | null): string =>
  prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;

/** Home directories read as `~`; the account name adds nothing a reader can act on. */
export const tildePath = (path: string): string => path.replace(HOME_PATTERN, '~');

const machineName = (machineId: string, presentMachineLabel: (id: string) => string): string => {
  if (!machineId) {
    return 'Any machine';
  }
  const label = presentMachineLabel(machineId);
  return label === machineId ? `Unknown machine ${machineId.slice(0, 8)}` : label;
};

/** The non-path predicates of a selector, rendered the way the config editor names them. */
const extraPredicates = ({ gitRemote, project }: ProjectSourceSelector): string =>
  projectSourceSelectorLabel({
    ...(gitRemote === undefined ? {} : { gitRemote }),
    ...(project === undefined ? {} : { project }),
  });

export const groupSelectorsByMachine = (
  selectors: readonly ProjectSourceSelector[],
  presentMachineLabel: (id: string) => string,
): ReportNoticeSelectorGroup[] => {
  const byMachine = new Map<string, ProjectSourceSelector[]>();
  for (const selector of selectors) {
    const key = selector.machineId ?? '';
    byMachine.set(key, [...(byMachine.get(key) ?? []), selector]);
  }
  return [...byMachine.entries()].map(([machineId, group]) => {
    const pathSelectors = group.filter((selector) => selector.sourcePath !== undefined);
    const rawPaths = pathSelectors.map((selector) => selector.sourcePath ?? '');
    const prefix = commonDirectoryPrefix(rawPaths);
    return {
      machine: machineName(machineId, presentMachineLabel),
      machineId,
      otherSelectors: group
        .filter((selector) => selector.sourcePath === undefined)
        .map(extraPredicates)
        .filter((label) => label.length > 0),
      paths: pathSelectors.map((selector) => {
        const path = tildePath(relativeTo(selector.sourcePath ?? '', prefix));
        const extras = extraPredicates(selector);
        return extras ? `${path} (${extras})` : path;
      }),
      prefix: prefix === null ? null : tildePath(prefix),
    };
  });
};

const plural = (count: number, noun: string): string => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Headline first, evidence on demand. A project-group warning names the group and the size of the
 * gap; the raw selector list (machine ids, absolute paths) stays behind the notice for the reader
 * who is about to clean it up. Other warnings keep their collector-written message.
 */
export const presentReportWarning = (
  warning: UsageReportWarning,
  presentMachineLabel: (id: string) => string = (id) => id,
): ReportNotice => {
  const selectors = warning.selectors ?? [];
  const base = {
    ...(warning.harness === undefined ? {} : { harness: warning.harness }),
    selectorCount: selectors.length,
    selectorGroups: selectors.length > 0 ? groupSelectorsByMachine(selectors, presentMachineLabel) : [],
    warning,
  };
  if (warning.reason === 'partial-group' && warning.groupName && selectors.length > 0) {
    return {
      ...base,
      headline: `Project group "${warning.groupName}": ${plural(selectors.length, 'configured source')} matched nothing`,
    };
  }
  if (warning.reason === 'unmatched-group' && warning.groupName) {
    return { ...base, headline: `Project group "${warning.groupName}" matches no sources` };
  }
  return { ...base, headline: warning.message };
};

const isGroupingWarning = (warning: UsageReportWarning): boolean => warning.reason !== undefined;

/**
 * The one line a closed notice shows: how many, and what each kind actually costs the reader. A
 * grouping gap leaves sessions ungrouped; a collector warning means totals were built from the rows
 * that survived; a bounded summary omits support items. None is claimed unless its kind is present.
 */
export const reportNoticesSummary = (
  warnings: readonly UsageReportWarning[],
  omittedSupportItemCount: number,
): string => {
  const counts = [] as string[];
  const consequences = [] as string[];
  if (warnings.length > 0) {
    counts.push(plural(warnings.length, 'notice'));
  }
  if (warnings.some(isGroupingWarning)) {
    // A grouping warning says a configured selector matched nothing; the matched sources are still
    // grouped. What is incomplete is the configuration, not the report's rows.
    consequences.push('project grouping is incomplete');
  }
  if (warnings.some((warning) => !isGroupingWarning(warning))) {
    consequences.push('totals use available rows only');
  }
  if (omittedSupportItemCount > 0) {
    counts.push(`${plural(omittedSupportItemCount, 'support item')} omitted`);
    consequences.push('bounded summary');
  }
  return consequences.length > 0 ? `${counts.join(' · ')} — ${consequences.join(', ')}` : counts.join(' · ');
};
