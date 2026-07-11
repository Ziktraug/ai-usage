import { lstat, mkdir } from 'node:fs/promises';
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
  WriteSkillManagementConfigInput,
} from './contracts';
import { isMissingPathError } from './diagnostics';
import {
  applyProjectionAction,
  buildDefaultSkillTargets,
  isProjectionHealthy,
  planProjection,
  scanTargetProjections,
} from './projections';
import { parseSkillName } from './shared';
import { scanSkillSourceRepository } from './source-scan';
import { loadSkillSourceState, setSkillEnabled } from './source-state';
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
  unmanagedEntries: readonly Projection[],
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

const applyPlannedActions = async (
  snapshot: SkillManagementSnapshot,
  predicate: (skill: SourceSkill) => boolean,
): Promise<SkillReconcileResult> => {
  const actions = planReconcileActions(snapshot, predicate);
  for (const action of actions) {
    if (
      action.type === 'create-symlink' ||
      action.type === 'repair-symlink' ||
      action.type === 'unlink-managed-symlink'
    ) {
      await applyProjectionAction(action);
    }
  }
  return { actions, snapshot };
};

export const reconcileSkill = async (input: ReconcileSkillInput): Promise<SkillReconcileResult> => {
  const skillName = parseSkillName(input.skillName);
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(snapshot, (skill) => skill.name === skillName);
};

export const reconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(snapshot, activeSkillPredicate);
};

export const previewReconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  return { actions: planReconcileActions(snapshot, activeSkillPredicate), snapshot };
};

export const createSkillTargetDirectory = async (input: CreateSkillTargetDirectoryInput): Promise<void> => {
  const targetPath = parseRequiredNonEmptyString(input.path, 'target path');
  await mkdir(targetPath, { recursive: true });
};
