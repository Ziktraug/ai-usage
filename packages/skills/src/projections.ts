import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, readlink, rename, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Projection,
  ProjectionAction,
  ProjectionState,
  SkillDiagnostic,
  SkillTarget,
  SourceSkill,
  TargetProjectionScan,
  TargetProjectionScanInput,
} from './contracts';
import { createDiagnostic, isMissingPathError } from './diagnostics';

export const buildDefaultSkillTargets = (homePath: string): readonly SkillTarget[] => [
  {
    enabled: true,
    id: 'standard-agents',
    kind: 'standard-interop',
    label: 'Standard Agents',
    missing: false,
    observed: true,
    path: path.join(homePath, '.agents', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'claude-code',
    kind: 'standard-interop',
    label: 'Claude Code',
    missing: false,
    observed: true,
    path: path.join(homePath, '.claude', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'codex',
    kind: 'standard-interop',
    label: 'Codex',
    missing: false,
    observed: true,
    path: path.join(homePath, '.codex', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'opencode',
    kind: 'standard-interop',
    label: 'OpenCode',
    missing: false,
    observed: true,
    path: path.join(homePath, '.config', 'opencode', 'skills'),
    scope: 'system',
  },
  {
    enabled: false,
    id: 'github-copilot',
    kind: 'standard-interop',
    label: 'GitHub Copilot',
    missing: false,
    observed: false,
    path: path.join(homePath, '.config', 'github-copilot', 'skills'),
    scope: 'system',
  },
  {
    enabled: false,
    id: 'cursor',
    kind: 'standard-interop',
    label: 'Cursor',
    missing: false,
    observed: false,
    path: path.join(homePath, '.cursor', 'skills'),
    scope: 'system',
  },
];

const projectionFor = (
  skillName: string,
  targetId: string,
  expectedPath: string,
  stateValue: ProjectionState,
  options: {
    actualPath?: string;
    diagnostics?: readonly SkillDiagnostic[];
  } = {},
): Projection => {
  const projection: Projection = {
    diagnostics: options.diagnostics ?? [],
    expectedPath,
    skillName,
    state: stateValue,
    targetId,
  };
  if (options.actualPath !== undefined) {
    projection.actualPath = options.actualPath;
  }
  return projection;
};

const classifyProjectedSkill = async (skill: SourceSkill, target: SkillTarget): Promise<Projection> => {
  const expectedPath = path.join(target.path, skill.name);
  if (target.missing) {
    return projectionFor(skill.name, target.id, expectedPath, 'missing-target', {
      diagnostics: [
        createDiagnostic('MissingTarget', 'warning', 'Target directory is missing', {
          path: target.path,
          skillName: skill.name,
          targetId: target.id,
        }),
      ],
    });
  }

  let entryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    entryStat = await lstat(expectedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return projectionFor(skill.name, target.id, expectedPath, 'missing');
    }
    return projectionFor(skill.name, target.id, expectedPath, 'missing-target', {
      diagnostics: [
        createDiagnostic('UnreadableTargetEntry', 'warning', 'Target entry could not be inspected', {
          path: expectedPath,
          skillName: skill.name,
          targetId: target.id,
        }),
      ],
    });
  }

  if (entryStat.isSymbolicLink()) {
    const linkTarget = await readlink(expectedPath);
    const actualPath = path.resolve(path.dirname(expectedPath), linkTarget);
    try {
      await stat(actualPath);
    } catch {
      return projectionFor(skill.name, target.id, expectedPath, 'broken-link', { actualPath });
    }
    if (path.resolve(skill.path) === actualPath) {
      return projectionFor(skill.name, target.id, expectedPath, skill.enabled ? 'linked' : 'disabled-exposed', {
        actualPath,
      });
    }
    return projectionFor(skill.name, target.id, expectedPath, 'wrong-target', { actualPath });
  }

  return projectionFor(skill.name, target.id, expectedPath, skill.enabled ? 'unmanaged-copy' : 'disabled-exposed', {
    actualPath: expectedPath,
  });
};

const scanUnmanagedTargetEntries = async (
  target: SkillTarget,
  managedSkillNames: ReadonlySet<string>,
): Promise<readonly Projection[]> => {
  let entries: Array<{
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
    name: string;
  }>;
  try {
    entries = await readdir(target.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const projections: Projection[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (managedSkillNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(target.path, entry.name);
    if (entry.isSymbolicLink()) {
      projections.push(projectionFor(entry.name, target.id, entryPath, 'unmanaged-symlink', { actualPath: entryPath }));
      continue;
    }
    if (entry.isDirectory() || entry.isFile()) {
      projections.push(projectionFor(entry.name, target.id, entryPath, 'unmanaged-copy', { actualPath: entryPath }));
    }
  }
  return projections;
};

export const scanTargetProjections = async (input: TargetProjectionScanInput): Promise<TargetProjectionScan> => {
  const projections: Projection[] = [];
  const unmanagedEntries: Projection[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const managedSkillNames = new Set(input.skills.map((skill) => skill.name));

  for (const target of input.targets) {
    let targetMissing = target.missing;
    try {
      const targetStat = await lstat(target.path);
      targetMissing = !targetStat.isDirectory();
    } catch (error) {
      if (isMissingPathError(error)) {
        targetMissing = true;
      } else {
        diagnostics.push(
          createDiagnostic('UnreadableTarget', 'warning', 'Target directory could not be inspected', {
            path: target.path,
            targetId: target.id,
          }),
        );
        targetMissing = true;
      }
    }
    const observedTarget: SkillTarget = { ...target, missing: targetMissing, observed: !targetMissing };
    for (const skill of input.skills) {
      projections.push(await classifyProjectedSkill(skill, observedTarget));
    }
    if (!targetMissing) {
      unmanagedEntries.push(...(await scanUnmanagedTargetEntries(observedTarget, managedSkillNames)));
    }
  }

  diagnostics.push(...projections.flatMap((projection) => projection.diagnostics));
  return { diagnostics, projections, unmanagedEntries };
};

export const isProjectionHealthy = (projection: Projection | undefined): boolean => projection?.state === 'linked';

export const planProjection = (
  skill: SourceSkill,
  target: SkillTarget,
  projection: Projection | undefined,
): ProjectionAction => {
  const expectedPath = projection?.expectedPath ?? path.join(target.path, skill.name);
  if (projection === undefined) {
    return {
      path: expectedPath,
      reason: 'projection is unavailable',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (!skill.enabled) {
    if (
      projection.state === 'linked' ||
      (projection.state === 'disabled-exposed' && projection.actualPath === skill.path)
    ) {
      return {
        observedSourcePath: projection.actualPath ?? skill.path,
        path: projection.expectedPath,
        skillName: skill.name,
        sourcePath: skill.path,
        targetId: target.id,
        type: 'unlink-managed-symlink',
      };
    }
    if (projection.state === 'disabled-exposed') {
      return {
        path: projection.expectedPath,
        reason: 'disabled skill remains exposed by unmanaged content',
        skillName: skill.name,
        targetId: target.id,
        type: 'refuse-unmanaged-mutation',
      };
    }
    return {
      path: projection.expectedPath,
      reason: 'disabled skill has no managed symlink to remove',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  // Warning-status skills (heavy tokens, unknown frontmatter fields…) stay
  // projectable; only structurally invalid skills are refused.
  if (skill.validationStatus === 'invalid') {
    return {
      path: projection.expectedPath,
      reason: 'invalid skills cannot be projected',
      skillName: skill.name,
      targetId: target.id,
      type: 'refuse-unmanaged-mutation',
    };
  }

  if (!target.enabled) {
    return {
      path: projection.expectedPath,
      reason: 'target is disabled',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (projection.state === 'missing') {
    return {
      path: projection.expectedPath,
      skillName: skill.name,
      sourcePath: skill.path,
      targetId: target.id,
      type: 'create-symlink',
    };
  }

  if (projection.state === 'broken-link' || projection.state === 'wrong-target') {
    if (projection.actualPath === undefined) {
      return {
        path: projection.expectedPath,
        reason: 'observed symlink target is unavailable',
        skillName: skill.name,
        targetId: target.id,
        type: 'refuse-unmanaged-mutation',
      };
    }
    return {
      observedSourcePath: projection.actualPath,
      path: projection.expectedPath,
      skillName: skill.name,
      sourcePath: skill.path,
      targetId: target.id,
      type: 'repair-symlink',
    };
  }

  if (projection.state === 'linked') {
    return {
      path: projection.expectedPath,
      reason: 'already linked',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  return {
    path: projection.expectedPath,
    reason: `refusing to mutate ${projection.state}`,
    skillName: skill.name,
    targetId: target.id,
    type: 'refuse-unmanaged-mutation',
  };
};

const assertObservedProjectionUnchanged = async (projectionPath: string, observedSourcePath: string): Promise<void> => {
  const projectionStat = await lstat(projectionPath);
  if (!projectionStat.isSymbolicLink()) {
    throw new Error('Refusing to mutate a projection that changed after observation');
  }
  const actualSourcePath = path.resolve(path.dirname(projectionPath), await readlink(projectionPath));
  if (actualSourcePath !== path.resolve(observedSourcePath)) {
    throw new Error('Refusing to mutate a projection that changed after observation');
  }
};

const restoreClaimedProjection = async (claimedPath: string, projectedPath: string): Promise<void> => {
  try {
    await lstat(projectedPath);
    throw new Error(`Refusing to overwrite an interloper; claimed projection retained at ${claimedPath}`);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  const claimedStat = await lstat(claimedPath);
  if (claimedStat.isSymbolicLink()) {
    await symlink(await readlink(claimedPath), projectedPath);
    await unlink(claimedPath);
    return;
  }
  if (claimedStat.isFile()) {
    await link(claimedPath, projectedPath);
    await unlink(claimedPath);
    return;
  }
  if (claimedStat.isDirectory()) {
    await rename(claimedPath, projectedPath);
    return;
  }
  throw new Error(`Unsupported claimed projection retained at ${claimedPath}`);
};

const claimObservedProjection = async (projectedPath: string, observedSourcePath: string): Promise<string> => {
  await assertObservedProjectionUnchanged(projectedPath, observedSourcePath);
  const claimedPath = path.join(path.dirname(projectedPath), `.${path.basename(projectedPath)}.${randomUUID()}.old`);
  await rename(projectedPath, claimedPath);
  try {
    await assertObservedProjectionUnchanged(claimedPath, observedSourcePath);
    // Yield once so competing filesystem actors can become visible before the exclusive install.
    await delay(5);
    return claimedPath;
  } catch (error) {
    await restoreClaimedProjection(claimedPath, projectedPath);
    throw error;
  }
};

export const applyProjectionAction = async (action: ProjectionAction): Promise<void> => {
  if (action.type === 'noop' || action.type === 'refuse-unmanaged-mutation') {
    return;
  }

  if (action.type === 'create-symlink') {
    await mkdir(path.dirname(action.path), { recursive: true });
    await symlink(action.sourcePath, action.path);
    return;
  }

  if (action.type === 'repair-symlink') {
    const claimedPath = await claimObservedProjection(action.path, action.observedSourcePath);
    try {
      await symlink(action.sourcePath, action.path);
    } catch (error) {
      await restoreClaimedProjection(claimedPath, action.path);
      throw error;
    }
    await unlink(claimedPath);
    return;
  }

  if (action.type === 'unlink-managed-symlink') {
    const claimedPath = await claimObservedProjection(action.path, action.observedSourcePath);
    try {
      await unlink(claimedPath);
    } catch (error) {
      await restoreClaimedProjection(claimedPath, action.path);
      throw error;
    }
  }
};
