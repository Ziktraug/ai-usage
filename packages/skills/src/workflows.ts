import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSkillConfigInput } from './config';
import type {
  CreateSkillTargetDirectoryInput,
  LoadSkillManagementSnapshotInput,
  Projection,
  ProjectionAction,
  ReconcileSkillInput,
  SkillDiagnostic,
  SkillManagementConfig,
  SkillManagementConfigDocument,
  SkillManagementSnapshot,
  SkillManagementSnapshotSummary,
  SkillReconcileResult,
  SkillSourceState,
  SkillTarget,
  SourceSkill,
  SourceSkillScanOptions,
  ToggleSkillEnabledInput,
  UnmanagedEntry,
  WriteSkillManagementConfigInput,
} from './contracts';
import { isMissingPathError } from './diagnostics';
import { projectionLockIdentityForTarget, withSkillProjectionLock } from './projection-lock';
import {
  applyProjectionAction,
  buildDefaultSkillTargets,
  isProjectionHealthy,
  planProjection,
  scanTargetProjections,
} from './projections';
import { parseSkillName } from './shared';
import { scanSkillSourceRepository } from './source-scan';
import { loadSkillSourceState, setSkillEnabled, withSkillSourceStateLock } from './source-state';
import { parseRequiredNonEmptyString } from './validation';

const emptySkillManagementSnapshot = (
  config: SkillManagementConfig,
  diagnostics: readonly SkillDiagnostic[] = [],
): SkillManagementSnapshot => ({
  config,
  configured: false,
  diagnostics,
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { version: 1, skillEnabledByName: {} },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: diagnostics.length,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
});

const targetLabelFor = (targetId: string): string =>
  targetId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

const buildConfiguredSkillTargets = (config: SkillManagementConfig, homePath: string): readonly SkillTarget[] => {
  const configuredTargets = config.targets;
  if (configuredTargets === undefined) {
    return buildDefaultSkillTargets(homePath);
  }
  return Object.entries(configuredTargets).map(([targetId, targetConfig]) => ({
    enabled: targetConfig.enabled,
    id: targetId,
    kind: targetConfig.kind,
    label: targetLabelFor(targetId),
    missing: false,
    observed: false,
    path: targetConfig.path,
    scope: targetConfig.scope,
  }));
};

const observeSkillTargets = async (targets: readonly SkillTarget[]): Promise<readonly SkillTarget[]> => {
  const observedTargets: SkillTarget[] = [];
  for (const target of targets) {
    try {
      const targetStat = await lstat(target.path);
      const isDirectory = targetStat.isDirectory();
      observedTargets.push({
        ...target,
        missing: !isDirectory,
        observed: isDirectory,
      });
    } catch (error) {
      observedTargets.push({
        ...target,
        missing: isMissingPathError(error) ? true : target.missing,
        observed: false,
      });
    }
  }
  return observedTargets;
};

const snapshotSummary = (
  skills: readonly SourceSkill[],
  targets: readonly SkillTarget[],
  projections: readonly Projection[],
  unmanagedEntries: readonly UnmanagedEntry[],
  diagnostics: readonly SkillDiagnostic[],
): SkillManagementSnapshotSummary => {
  const healthyProjectionCount = projections.filter(isProjectionHealthy).length;
  return {
    activeSkillCount: skills.filter((skill) => skill.enabled).length,
    diagnosticCount: diagnostics.length,
    healthyProjectionCount,
    skillCount: skills.length,
    targetCount: targets.length,
    unhealthyProjectionCount: projections.length - healthyProjectionCount,
    unmanagedEntryCount: unmanagedEntries.length,
  };
};

export const loadSkillManagementSnapshot = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillManagementSnapshot> => {
  const config = input.config.skills === undefined ? {} : parseSkillConfigInput(input.config.skills);
  if (config.sourceRepoPath === undefined) {
    return emptySkillManagementSnapshot(config);
  }

  const sourceState = await loadSkillSourceState(config.sourceRepoPath);
  const sourceScanOptions: SourceSkillScanOptions = {};
  if (config.tokenThresholds !== undefined) {
    sourceScanOptions.tokenThresholds = config.tokenThresholds;
  }
  const sourceScan = await scanSkillSourceRepository({
    options: sourceScanOptions,
    sourceRepoPath: config.sourceRepoPath,
    state: sourceState.state,
  });
  const targets = await observeSkillTargets(buildConfiguredSkillTargets(config, input.homePath));
  const projectionScan = await scanTargetProjections({ skills: sourceScan.skills, targets });
  const diagnostics = [...sourceState.diagnostics, ...sourceScan.diagnostics, ...projectionScan.diagnostics];

  return {
    config,
    configured: true,
    diagnostics,
    nativeRuleFindings: [],
    projections: projectionScan.projections,
    skills: sourceScan.skills,
    sourceState: sourceState.state,
    summary: snapshotSummary(
      sourceScan.skills,
      targets,
      projectionScan.projections,
      projectionScan.unmanagedEntries,
      diagnostics,
    ),
    targets,
    unmanagedEntries: projectionScan.unmanagedEntries,
  };
};

export const writeSkillManagementConfig = async (
  input: WriteSkillManagementConfigInput,
): Promise<SkillManagementConfigDocument> => {
  const skills = parseSkillConfigInput(input.skills);
  const nextConfig: SkillManagementConfigDocument = {
    ...input.config,
    skills,
  };
  await input.writeConfig(nextConfig);
  return nextConfig;
};

export const toggleSkillEnabled = async (input: ToggleSkillEnabledInput): Promise<SkillSourceState> =>
  setSkillEnabled(input.sourceRepoPath, input.skillName, input.enabled);

const activeSkillPredicate = (skill: SourceSkill): boolean => skill.enabled && skill.validationStatus !== 'invalid';

const planReconcileActions = (
  snapshot: SkillManagementSnapshot,
  predicate: (skill: SourceSkill) => boolean,
): ProjectionAction[] => {
  const actions: ProjectionAction[] = [];
  for (const skill of snapshot.skills.filter(predicate)) {
    for (const target of snapshot.targets.filter((candidate) => candidate.enabled)) {
      const projection = snapshot.projections.find(
        (candidate) => candidate.skillName === skill.name && candidate.targetId === target.id,
      );
      const action = planProjection(skill, target, projection);
      if (action.type !== 'noop') {
        actions.push(action);
      }
    }
  }
  return actions;
};

interface ReconcileWorkflowHooks {
  afterPlanning?(actions: readonly ProjectionAction[]): Promise<void>;
}

type MutableProjectionAction = Extract<
  ProjectionAction,
  { type: 'create-symlink' | 'repair-symlink' | 'unlink-managed-symlink' }
>;

const isMutableProjectionAction = (action: ProjectionAction): action is MutableProjectionAction =>
  action.type === 'create-symlink' || action.type === 'repair-symlink' || action.type === 'unlink-managed-symlink';

const expectedEnabledState = (action: MutableProjectionAction): boolean => action.type !== 'unlink-managed-symlink';

const staleIntentAction = (action: ProjectionAction): ProjectionAction => ({
  path: action.path,
  reason: 'source skill enabled state changed after planning',
  skillName: action.skillName,
  targetId: action.targetId,
  type: 'noop',
});

const applyPlannedActions = async (
  input: LoadSkillManagementSnapshotInput,
  snapshot: SkillManagementSnapshot,
  predicate: (skill: SourceSkill) => boolean,
  privateStatePath: string,
  hooks: ReconcileWorkflowHooks = {},
): Promise<SkillReconcileResult> => {
  const actions = planReconcileActions(snapshot, predicate);
  await hooks.afterPlanning?.(actions);
  if (!actions.some(isMutableProjectionAction)) {
    return { actions, snapshot: await loadSkillManagementSnapshot(input) };
  }

  const sourceRepoPath = snapshot.config.sourceRepoPath;
  if (sourceRepoPath === undefined) {
    throw new Error('Cannot apply a projection without a configured source repository');
  }
  const appliedActions = await withSkillSourceStateLock(sourceRepoPath, async () => {
    const currentSourceState = await loadSkillSourceState(sourceRepoPath);
    if (currentSourceState.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new Error('source skill state must be readable JSON before projections can be reconciled');
    }
    const results: ProjectionAction[] = [];
    for (const action of actions) {
      if (!isMutableProjectionAction(action)) {
        results.push(action);
        continue;
      }
      const currentEnabled = currentSourceState.state.skillEnabledByName[action.skillName] ?? true;
      if (currentEnabled !== expectedEnabledState(action)) {
        results.push(staleIntentAction(action));
        continue;
      }
      await applyProjectionAction(action, { privateStatePath });
      results.push(action);
    }
    return results;
  });
  return { actions: appliedActions, snapshot: await loadSkillManagementSnapshot(input) };
};

export const reconcileSkill = async (
  input: ReconcileSkillInput,
  hooks: ReconcileWorkflowHooks = {},
): Promise<SkillReconcileResult> => {
  const skillName = parseSkillName(input.skillName);
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(
    input,
    snapshot,
    (skill) => skill.name === skillName,
    path.join(input.homePath, '.config', 'ai-usage'),
    hooks,
  );
};

export const reconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
  hooks: ReconcileWorkflowHooks = {},
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(
    input,
    snapshot,
    activeSkillPredicate,
    path.join(input.homePath, '.config', 'ai-usage'),
    hooks,
  );
};

export const previewReconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  const actions = planReconcileActions(snapshot, activeSkillPredicate);
  return { actions, snapshot };
};

export const createSkillTargetDirectory = async (input: CreateSkillTargetDirectoryInput): Promise<void> => {
  const targetPath = path.resolve(parseRequiredNonEmptyString(input.path, 'target path'));
  let existingParent = targetPath;
  while (true) {
    try {
      const parentStat = await lstat(existingParent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error(`Skill target ancestor must be a non-symlink directory: ${existingParent}`);
      }
      break;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(existingParent);
      if (parent === existingParent) {
        throw new Error('Skill target has no observable directory ancestor');
      }
      existingParent = parent;
    }
  }

  const observedParentStat = await lstat(existingParent);
  const observedParentIdentity = { dev: String(observedParentStat.dev), ino: String(observedParentStat.ino) };
  const lockIdentity = await projectionLockIdentityForTarget(targetPath);
  await withSkillProjectionLock(input.privateStatePath, lockIdentity, async () => {
    const revalidatedLockIdentity = await projectionLockIdentityForTarget(targetPath);
    if (revalidatedLockIdentity !== lockIdentity) {
      throw new Error('Skill target ancestor identity changed before directory creation');
    }
    const currentParentStat = await lstat(existingParent);
    if (
      currentParentStat.isSymbolicLink() ||
      !currentParentStat.isDirectory() ||
      String(currentParentStat.dev) !== observedParentIdentity.dev ||
      String(currentParentStat.ino) !== observedParentIdentity.ino
    ) {
      throw new Error('Skill target ancestor identity changed before directory creation');
    }
    let current = existingParent;
    const missingComponents = path.relative(existingParent, targetPath).split(path.sep).filter(Boolean);
    for (const component of missingComponents) {
      current = path.join(current, component);
      try {
        await mkdir(current);
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
          throw error;
        }
      }
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        throw new Error(`Skill target component must be a non-symlink directory: ${current}`);
      }
    }
  });
};
