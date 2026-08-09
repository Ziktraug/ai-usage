import type { FocusedMachineFreshness } from '@ai-usage/report-core/focused-report-query';

const MILLISECONDS_PER_DAY = 86_400_000;
export const MACHINE_FLEET_FRESHNESS_WINDOW_DAYS = 30;
export const MACHINE_FLEET_STALE_AFTER_MS = MACHINE_FLEET_FRESHNESS_WINDOW_DAYS * MILLISECONDS_PER_DAY;

export interface MachineFreshnessObservation {
  id: string;
  label: string;
  lastSeenAt: string;
}

export type MachineFreshnessSnapshot =
  | {
      kind: 'available';
      machines: readonly MachineFreshnessObservation[];
      observedAt: number;
      omittedMachines: number;
      skippedRows: number;
    }
  | {
      kind: 'unavailable';
      observedAt: number;
      omittedMachines: number;
      reason: 'bootstrap-budget' | 'not-captured';
      skippedRows: number;
    };

export interface MachineLabelPresentation {
  freshness: 'fresh' | 'stale' | 'unavailable';
  label: string;
  value: string;
}

export const machineFreshnessSnapshotFromFocused = (freshness: FocusedMachineFreshness): MachineFreshnessSnapshot => {
  const observedAt = Date.parse(freshness.observedAt);
  if (!Number.isFinite(observedAt)) {
    throw new Error('Focused report machine freshness has an invalid observation timestamp');
  }
  if (freshness.kind === 'unavailable') {
    return {
      kind: freshness.kind,
      observedAt,
      omittedMachines: freshness.omittedMachines,
      reason: freshness.reason,
      skippedRows: freshness.skippedRows,
    };
  }
  return {
    kind: freshness.kind,
    machines: freshness.machines.map((machine) => ({ ...machine })),
    observedAt,
    omittedMachines: freshness.omittedMachines,
    skippedRows: freshness.skippedRows,
  };
};

export const machineFreshnessIsStale = (lastSeenAt: string | null, now: number): boolean => {
  if (lastSeenAt === null) {
    return true;
  }
  const observedAt = Date.parse(lastSeenAt);
  return !Number.isFinite(observedAt) || observedAt < now - MACHINE_FLEET_STALE_AFTER_MS;
};

export const machineLabelPresentation = (
  machine: MachineFreshnessObservation,
  now = Date.now(),
): MachineLabelPresentation => {
  const stale = machineFreshnessIsStale(machine.lastSeenAt, now);
  return {
    freshness: stale ? 'stale' : 'fresh',
    label: stale ? `${machine.label} · Stale` : machine.label,
    value: machine.id,
  };
};

export const machineFreshnessStatusLabel = (snapshot: MachineFreshnessSnapshot): string | null =>
  snapshot.kind === 'unavailable' || snapshot.omittedMachines > 0 || snapshot.skippedRows > 0
    ? 'Freshness unavailable'
    : null;

export const machineLabelPresentationForSnapshot = (
  machine: Pick<MachineFreshnessObservation, 'id' | 'label'>,
  snapshot: MachineFreshnessSnapshot,
): MachineLabelPresentation => {
  const observation =
    snapshot.kind === 'available' ? snapshot.machines.find((candidate) => candidate.id === machine.id) : undefined;
  if (observation) {
    return machineLabelPresentation(observation, snapshot.observedAt);
  }
  return {
    freshness: 'unavailable',
    label: `${machine.label} · Freshness unavailable`,
    value: machine.id,
  };
};
