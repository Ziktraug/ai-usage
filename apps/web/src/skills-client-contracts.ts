import type { ProjectionAction, ProjectSkillInventory, SkillManagementSnapshot } from '@ai-usage/skills';
import type { KnownSkillProjectPath } from './server/skills-contracts';

export type SkillSnapshotResult =
  | { ok: true; data: SkillManagementSnapshot }
  | { ok: false; error: { message: string; tag: string } };

export type KnownProjectPathsResult =
  | { ok: true; data: readonly KnownSkillProjectPath[] }
  | { ok: false; error: { message: string; tag: string } };

export interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export type SkillReconcileServerResult =
  | { ok: true; data: SkillReconcileResult }
  | { ok: false; error: { message: string; tag: string } };

export type ProjectInventoriesResult =
  | { ok: true; data: readonly ProjectSkillInventory[] }
  | { ok: false; error: { message: string; tag: string } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isError = (value: unknown): value is { message: string; tag: string } =>
  isRecord(value) && typeof value.message === 'string' && typeof value.tag === 'string';

const isSnapshot = (value: unknown): value is SkillManagementSnapshot =>
  isRecord(value) &&
  typeof value.configured === 'boolean' &&
  isRecord(value.config) &&
  Array.isArray(value.diagnostics) &&
  Array.isArray(value.nativeRuleFindings) &&
  Array.isArray(value.projections) &&
  Array.isArray(value.skills) &&
  isRecord(value.sourceState) &&
  value.sourceState.version === 1 &&
  isRecord(value.summary) &&
  Array.isArray(value.targets) &&
  Array.isArray(value.unmanagedEntries);

const invalidResult = (label: string): never => {
  throw new Error(`Invalid ${label} response`);
};

const parseResultEnvelope = <T>(
  value: unknown,
  label: string,
  isData: (data: unknown) => data is T,
): { ok: true; data: T } | { ok: false; error: { message: string; tag: string } } => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return invalidResult(label);
  }
  if (value.ok) {
    if (!isData(value.data)) {
      return invalidResult(label);
    }
    return { data: value.data, ok: true };
  }
  if (!isError(value.error)) {
    return invalidResult(label);
  }
  return { error: { message: value.error.message, tag: value.error.tag }, ok: false };
};

export const parseSkillSnapshotResult = (value: unknown): SkillSnapshotResult =>
  parseResultEnvelope(value, 'skills snapshot', isSnapshot);

export const parseSkillReconcileResult = (value: unknown): SkillReconcileServerResult =>
  parseResultEnvelope(
    value,
    'skills reconcile',
    (data): data is SkillReconcileResult =>
      isRecord(data) && Array.isArray(data.actions) && data.actions.every(isRecord) && isSnapshot(data.snapshot),
  );

export const parseKnownProjectPathsResult = (value: unknown): KnownProjectPathsResult =>
  parseResultEnvelope(
    value,
    'known project paths',
    (data): data is readonly KnownSkillProjectPath[] =>
      Array.isArray(data) &&
      data.every(
        (project) =>
          isRecord(project) &&
          typeof project.label === 'string' &&
          typeof project.path === 'string' &&
          typeof project.project === 'string' &&
          Number.isSafeInteger(project.sessions) &&
          (project.sessions as number) >= 0,
      ),
  );

export const parseProjectInventoriesResult = (value: unknown): ProjectInventoriesResult =>
  parseResultEnvelope(
    value,
    'skill inventories',
    (data): data is readonly ProjectSkillInventory[] =>
      Array.isArray(data) &&
      data.every(
        (inventory) =>
          isRecord(inventory) &&
          typeof inventory.projectPath === 'string' &&
          Array.isArray(inventory.diagnostics) &&
          Array.isArray(inventory.observations) &&
          inventory.observations.every(
            (observation) =>
              isRecord(observation) &&
              typeof observation.name === 'string' &&
              typeof observation.path === 'string' &&
              typeof observation.runtimeDirId === 'string',
          ),
      ),
  );
