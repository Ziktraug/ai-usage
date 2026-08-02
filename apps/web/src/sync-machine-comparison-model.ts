import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageMachineFleetItem } from '@ai-usage/usage-store/reader';
import { buildSyncFleetMachineViews, formatFleetAge, type SyncFleetMachineView } from './manual-transfer-model';

export type SyncFleetComparisonFreshness = 'fresh' | 'stale' | 'unavailable';

export interface SyncFleetComparisonRow {
  current: boolean;
  freshness: SyncFleetComparisonFreshness;
  freshnessLabel: string;
  id: string;
  label: string;
  newestSessionAt: string | null;
  newestSessionLabel: string;
  sessionCount: number;
  sessionShareLabel: string;
  sessionSharePercent: number;
}

const SESSION_SHARE_PERCENT_TOTAL = 100;

const compareSyncFleetContributions = (left: SyncFleetMachineView, right: SyncFleetMachineView): number =>
  Number(right.current) - Number(left.current) ||
  right.sessionCount - left.sessionCount ||
  left.label.localeCompare(right.label) ||
  left.id.localeCompare(right.id);

const comparisonFreshnessFor = (
  machine: SyncFleetMachineView,
  now: number,
): Pick<SyncFleetComparisonRow, 'freshness' | 'freshnessLabel'> => {
  const observedAt = machine.lastSeenAt === null ? Number.NaN : Date.parse(machine.lastSeenAt);
  if (!Number.isFinite(observedAt)) {
    return { freshness: 'unavailable', freshnessLabel: 'Freshness unavailable' };
  }
  const age = formatFleetAge(machine.lastSeenAt, now);
  if (machine.stale) {
    return { freshness: 'stale', freshnessLabel: `Stale · ${age}` };
  }
  return { freshness: 'fresh', freshnessLabel: `Fresh · ${age}` };
};

const apportionSessionSharePercents = (machines: readonly SyncFleetMachineView[]): number[] => {
  const sessionTotal = machines.reduce((total, machine) => total + machine.sessionCount, 0);
  if (!(sessionTotal > 0 && Number.isFinite(sessionTotal))) {
    return machines.map(() => 0);
  }
  const allocations = machines.map((machine, index) => {
    const exactShare = (machine.sessionCount / sessionTotal) * SESSION_SHARE_PERCENT_TOTAL;
    const base = Math.floor(exactShare);
    return { base, index, remainder: exactShare - base };
  });
  const allocated = allocations.reduce((total, allocation) => total + allocation.base, 0);
  const bonusIndexes = new Set(
    allocations
      .slice()
      .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
      .slice(0, SESSION_SHARE_PERCENT_TOTAL - allocated)
      .map((allocation) => allocation.index),
  );
  return allocations.map((allocation) => allocation.base + (bonusIndexes.has(allocation.index) ? 1 : 0));
};

export const buildSyncFleetComparisonRows = (
  currentMachine: UsageMachine,
  machines: readonly UsageMachineFleetItem[],
  now = Date.now(),
): SyncFleetComparisonRow[] => {
  const inputMachineIds = new Set(machines.map(({ id }) => id));
  const orderedMachines = buildSyncFleetMachineViews(currentMachine, machines, now)
    .filter(({ id }) => inputMachineIds.has(id))
    .sort(compareSyncFleetContributions);
  const sessionSharePercents = apportionSessionSharePercents(orderedMachines);
  return orderedMachines.map((machine, index) => {
    const sessionSharePercent = sessionSharePercents[index] ?? 0;
    return {
      ...comparisonFreshnessFor(machine, now),
      current: machine.current,
      id: machine.id,
      label: machine.label,
      newestSessionAt: machine.newestSessionAt,
      newestSessionLabel: formatFleetAge(machine.newestSessionAt, now),
      sessionCount: machine.sessionCount,
      sessionShareLabel: `${sessionSharePercent}%`,
      sessionSharePercent,
    };
  });
};
