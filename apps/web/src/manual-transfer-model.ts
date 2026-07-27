import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ManualMergeImportResult } from '@ai-usage/usage-merge';
import type { UsageMachineFleetItem } from '@ai-usage/usage-store';

const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
export const MACHINE_FLEET_STALE_AFTER_MS = 30 * MILLISECONDS_PER_DAY;

export interface MachineFreshnessObservation {
  id: string;
  label: string;
  lastSeenAt: string | null;
}

export interface MachineFreshnessSnapshot {
  machines: MachineFreshnessObservation[];
  observedAt: number;
}

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
  label: string;
  stale: boolean;
  value: string;
}

export const machineLabelPresentation = (
  machine: MachineFreshnessObservation,
  now = Date.now(),
): MachineLabelPresentation => {
  const stale = fleetMachineIsStale(machine.lastSeenAt, now);
  return { label: stale ? `${machine.label} · Stale` : machine.label, stale, value: machine.id };
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
