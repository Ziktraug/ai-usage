import type { FocusedMachineFreshness } from '@ai-usage/report-core/focused-report-query';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ManualMergeImportResult } from '@ai-usage/usage-merge';
import type { UsageMachineFleetItem } from '@ai-usage/usage-store';

const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const MACHINE_FLEET_FRESHNESS_WINDOW_DAYS = 30;
export const MACHINE_FLEET_STALE_AFTER_MS = MACHINE_FLEET_FRESHNESS_WINDOW_DAYS * MILLISECONDS_PER_DAY;

export const INVALID_STORED_ROWS_EXPLANATION = 'Rows failed stored-row validation; details were not retained.';

export const invalidStoredRowsSummary = (skippedRows: number): string =>
  `${skippedRows.toLocaleString()} invalid stored ${skippedRows === 1 ? 'row was' : 'rows were'} excluded from fleet metadata.`;

export const STALE_MACHINE_COLLECTION_GUIDANCE = {
  command: 'bun run cli -- snapshot --out <path>',
  description: `This machine is outside the ${MACHINE_FLEET_FRESHNESS_WINDOW_DAYS}-day freshness window. Run this command on that machine, then import the snapshot here.`,
} as const;

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

export interface SyncFleetMachineView {
  current: boolean;
  hasLocalObservedRows: boolean;
  hasPortableRows: boolean;
  id: string;
  label: string;
  lastSeenAt: string | null;
  newestSessionAt: string | null;
  sessionCount: number;
  stale: boolean;
}

export const formatTransferBytes = (bytes: number): string => {
  if (bytes < BYTES_PER_UNIT) {
    return `${bytes} B`;
  }

  let value = bytes / BYTES_PER_UNIT;
  let unitIndex = 0;
  while (value >= BYTES_PER_UNIT && unitIndex < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${SIZE_UNITS[unitIndex]}`;
};

export const formatManualImportSummary = (result: ManualMergeImportResult): string => {
  const changed = result.result.inserted + result.result.updated + result.result.superseded + result.result.deleted;
  return `Imported ${result.machine.label}: ${changed.toLocaleString()} changed, ${result.result.unchanged.toLocaleString()} unchanged.`;
};

const fleetMachineIsStale = (lastSeenAt: string | null, now: number): boolean => {
  if (lastSeenAt === null) {
    return true;
  }
  const observedAt = Date.parse(lastSeenAt);
  return !Number.isFinite(observedAt) || observedAt < now - MACHINE_FLEET_STALE_AFTER_MS;
};

export interface MachineLabelPresentation {
  freshness: 'fresh' | 'stale' | 'unavailable';
  label: string;
  value: string;
}

export const machineLabelPresentation = (
  machine: MachineFreshnessObservation,
  now = Date.now(),
): MachineLabelPresentation => {
  const stale = fleetMachineIsStale(machine.lastSeenAt, now);
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

export const buildSyncFleetMachineViews = (
  currentMachine: UsageMachine,
  machines: readonly UsageMachineFleetItem[],
  now = Date.now(),
): SyncFleetMachineView[] => {
  const views: SyncFleetMachineView[] = machines.map((machine) => ({
    ...machine,
    current: machine.id === currentMachine.id,
    stale: fleetMachineIsStale(machine.lastSeenAt, now),
  }));
  if (!views.some((machine) => machine.current)) {
    views.push({
      current: true,
      hasLocalObservedRows: false,
      hasPortableRows: false,
      id: currentMachine.id,
      label: currentMachine.label,
      lastSeenAt: null,
      newestSessionAt: null,
      sessionCount: 0,
      stale: true,
    });
  }
  return views.sort(
    (left, right) => Number(right.current) - Number(left.current) || left.label.localeCompare(right.label),
  );
};

export const formatFleetAge = (timestamp: string | null, now = Date.now()): string => {
  if (timestamp === null) {
    return 'No activity recorded';
  }
  const observedAt = Date.parse(timestamp);
  if (!Number.isFinite(observedAt)) {
    return 'Unknown';
  }
  const age = Math.max(0, now - observedAt);
  if (age < MILLISECONDS_PER_MINUTE) {
    return 'just now';
  }
  if (age < MILLISECONDS_PER_HOUR) {
    return `${Math.floor(age / MILLISECONDS_PER_MINUTE)}m ago`;
  }
  if (age < MILLISECONDS_PER_DAY) {
    return `${Math.floor(age / MILLISECONDS_PER_HOUR)}h ago`;
  }
  return `${Math.floor(age / MILLISECONDS_PER_DAY)}d ago`;
};
