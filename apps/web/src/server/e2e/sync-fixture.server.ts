import { createHash } from 'node:crypto';
import {
  parseUsageMergeBundle,
  USAGE_MERGE_BUNDLE_VERSION,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import {
  parseUsageEngineHandoffId,
  type UsageEngineFileInput,
  type UsageEngineMergePreviewOutput,
} from '@ai-usage/usage-engine-control';
import type { StagedUsageEngineHandoff } from '@ai-usage/usage-engine-control/handoff';
import type { UsageMachineFleetItem } from '@ai-usage/usage-store/reader';
import type { UsageReadModel } from '../usage-read-model.server';

const CURRENT_MACHINE = { id: 'e2e-current-machine', label: 'E2E current machine' } as const;
const stagedDocuments = new Map<string, Uint8Array>();
const previews = new Map<string, { readonly digest: string; readonly machineId: string }>();
const peerFleet = new Map<string, UsageMachineFleetItem>();
let handoffSequence = 0;
let previewSequence = 0;

const copyBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

const digestFor = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const takeStagedDocument = (input: UsageEngineFileInput): Uint8Array => {
  if (input.kind !== 'inbox-handoff') {
    throw new Error('E2E Sync accepts only in-memory handoffs.');
  }
  const bytes = stagedDocuments.get(input.handoffId);
  if (!bytes) {
    throw new Error('E2E Sync handoff is unavailable.');
  }
  stagedDocuments.delete(input.handoffId);
  return bytes;
};

const parseStagedBundle = (
  input: UsageEngineFileInput,
): { readonly bundle: UsageMergeBundle; readonly bytes: Uint8Array } => {
  const bytes = takeStagedDocument(input);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bundle: parseUsageMergeBundle(text), bytes };
};

const mergeResultFor = (rows: number) => ({
  deleted: 0,
  fleetChanged: rows > 0,
  inserted: rows,
  superseded: 0,
  unchanged: 0,
  updated: 0,
  warnings: 0,
});

export const stageSyncE2EHandoff = (bytes: Uint8Array): Promise<StagedUsageEngineHandoff> => {
  handoffSequence += 1;
  const handoffId = parseUsageEngineHandoffId(`e2e-sync-${handoffSequence}`);
  stagedDocuments.set(handoffId, copyBytes(bytes));
  let cleaned = false;
  return Promise.resolve({
    cleanup: () => {
      if (!cleaned) {
        stagedDocuments.delete(handoffId);
        cleaned = true;
      }
      return Promise.resolve();
    },
    input: { handoffId, kind: 'inbox-handoff' },
  });
};

export const previewSyncE2EHandoff = (input: UsageEngineFileInput): UsageEngineMergePreviewOutput => {
  const { bundle, bytes } = parseStagedBundle(input);
  const documentDigest = digestFor(bytes);
  previewSequence += 1;
  const confirmationToken = `e2e-confirmation-${previewSequence}`;
  previews.set(confirmationToken, { digest: documentDigest, machineId: bundle.machine.id });
  return {
    bytes: bytes.byteLength,
    confirmationToken,
    documentDigest,
    kind: 'merge-preview',
    result: { ...mergeResultFor(bundle.rows.length), warnings: bundle.warnings.length },
    rows: bundle.rows.length,
    warningCount: bundle.warnings.length,
  };
};

export const confirmSyncE2EHandoff = (input: {
  readonly confirmationToken: string;
  readonly documentDigest: string;
  readonly fileInput: UsageEngineFileInput;
}): void => {
  const { bundle, bytes } = parseStagedBundle(input.fileInput);
  const preview = previews.get(input.confirmationToken);
  const digest = digestFor(bytes);
  if (
    !preview ||
    preview.digest !== input.documentDigest ||
    digest !== input.documentDigest ||
    preview.machineId !== bundle.machine.id
  ) {
    throw new Error('E2E Sync confirmation is stale.');
  }
  previews.delete(input.confirmationToken);
  peerFleet.set(bundle.machine.id, {
    ...bundle.machine,
    hasLocalObservedRows: false,
    hasPortableRows: bundle.rows.length > 0,
    lastSeenAt: bundle.generatedAt,
    newestSessionAt: bundle.rows[0]?.date ?? null,
    sessionCount: bundle.rows.length,
  });
};

const localBundle = (): UsageMergeBundle => ({
  generatedAt: new Date().toISOString(),
  machine: { ...CURRENT_MACHINE },
  rows: [],
  version: USAGE_MERGE_BUNDLE_VERSION,
  warnings: [],
});

const unsupportedRead = (): Promise<never> => Promise.reject(new Error('E2E Sync fixture does not serve report data.'));

const readModel: UsageReadModel = {
  queryRevision: unsupportedRead,
  readCurrentBootstrap: unsupportedRead,
  readCurrentLocalProjectSources: unsupportedRead,
  readCurrentManifest: unsupportedRead,
  readLocalMergeBundle: () => Promise.resolve(localBundle()),
  readLocalMachine: () => Promise.resolve({ ...CURRENT_MACHINE }),
  readSyncFleet: () =>
    Promise.resolve({
      currentMachine: { ...CURRENT_MACHINE },
      machines: [...peerFleet.values()].map((machine) => ({ ...machine })),
      omittedMachines: 0,
      skipped: 0,
    }),
};

export const getSyncE2EUsageReadModel = (): UsageReadModel => readModel;

export const resetSyncE2EFixture = (): void => {
  stagedDocuments.clear();
  previews.clear();
  peerFleet.clear();
  handoffSequence = 0;
  previewSequence = 0;
};
