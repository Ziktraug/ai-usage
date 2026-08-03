import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageEngineMergePreviewOutput } from '@ai-usage/usage-engine-control';
import type { UsageMachineFleetItem } from '@ai-usage/usage-store/reader';
import { MACHINE_FLEET_FRESHNESS_WINDOW_DAYS, machineFreshnessIsStale } from './machine-freshness-presentation';
import type { SourceControlConnectionState } from './source-control-client';

export {
  MACHINE_FLEET_STALE_AFTER_MS,
  type MachineFreshnessObservation,
  type MachineFreshnessSnapshot,
  type MachineLabelPresentation,
  machineFreshnessSnapshotFromFocused,
  machineFreshnessStatusLabel,
  machineLabelPresentation,
  machineLabelPresentationForSnapshot,
} from './machine-freshness-presentation';

const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
export const INVALID_STORED_ROWS_EXPLANATION = 'Rows failed stored-row validation; details were not retained.';

export const invalidStoredRowsSummary = (skippedRows: number): string =>
  `${skippedRows.toLocaleString()} invalid stored ${skippedRows === 1 ? 'row was' : 'rows were'} excluded from fleet metadata.`;

export const STALE_MACHINE_COLLECTION_GUIDANCE = {
  command: 'bun run cli -- snapshot --out <path>',
  description: `This machine is outside the ${MACHINE_FLEET_FRESHNESS_WINDOW_DAYS}-day freshness window. Run this command on that machine, then import the snapshot here.`,
} as const;

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

export const formatManualImportSummary = (result: UsageEngineMergePreviewOutput): string => {
  const changed = result.result.inserted + result.result.updated + result.result.superseded + result.result.deleted;
  return `Imported usage: ${changed.toLocaleString()} changed, ${result.result.unchanged.toLocaleString()} unchanged.`;
};

export interface ManualTransferMutationAvailability {
  readonly available: boolean;
  readonly message: string | null;
}

export const manualTransferMutationAvailability = (
  connection: SourceControlConnectionState,
): ManualTransferMutationAvailability => {
  if (connection === 'live') {
    return { available: true, message: null };
  }
  if (connection === 'protocol-mismatch') {
    return {
      available: false,
      message:
        'This usage engine version is incompatible. Imports are disabled; exports and stored fleet reads remain available.',
    };
  }
  if (connection === 'disconnected') {
    return {
      available: false,
      message:
        'The usage engine is disconnected. Imports are disabled while reconnecting; exports and stored fleet reads remain available.',
    };
  }
  return {
    available: false,
    message: 'Connecting to the usage engine. Imports are disabled; exports and stored fleet reads remain available.',
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
    stale: machineFreshnessIsStale(machine.lastSeenAt, now),
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
