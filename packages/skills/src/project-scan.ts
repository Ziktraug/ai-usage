import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultTokenThresholds,
  type ProjectSkillInventory,
  type ProjectSkillObservation,
  type ProjectSkillPlacement,
  projectSkillDirectories,
  type SkillDiagnostic,
  type SkillFrontmatterField,
  type SkillSourceState,
  type SourceSkillScanOptions,
} from './contracts';
import { createDiagnostic, isMissingPathError } from './diagnostics';
import {
  defaultIgnoredDirectories,
  defaultMaxFilesPerSkill,
  defaultMaxRuntimeEntries,
  defaultMaxTextFileBytes,
} from './scan-options';
import { parseSkillName } from './shared';
import { scanOneSkill } from './source-scan';

const invocationForFields = (fields: readonly SkillFrontmatterField[]): 'auto' | 'manual' =>
  fields.some((field) => field.key === 'disable-model-invocation' && field.value === true) ? 'manual' : 'auto';

const isPathWithin = (parentPath: string, childPath: string): boolean => {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const projectPlacementFor = async (
  entryPath: string,
  projectPath: string,
  sourceRepoPath?: string,
): Promise<{ pathForScan: string; placement: ProjectSkillPlacement }> => {
  const entryStat = await lstat(entryPath);
  if (!entryStat.isSymbolicLink()) {
    return { pathForScan: entryPath, placement: 'owned-directory' };
  }
  const resolved = path.resolve(path.dirname(entryPath), await readlink(entryPath));
  let resolvedRealPath: string;
  try {
    resolvedRealPath = await realpath(resolved);
  } catch {
    return { pathForScan: entryPath, placement: 'external-symlink' };
  }
  if (sourceRepoPath !== undefined) {
    const sourceSkillsPath = path.join(await realpath(sourceRepoPath), 'skills');
    if (isPathWithin(sourceSkillsPath, resolvedRealPath)) {
      return { pathForScan: entryPath, placement: 'symlink-to-source' };
    }
  }
  let projectRealPath: string;
  try {
    projectRealPath = await realpath(projectPath);
  } catch {
    return { pathForScan: entryPath, placement: 'external-symlink' };
  }
  return {
    pathForScan: entryPath,
    placement: isPathWithin(projectRealPath, resolvedRealPath) ? 'project-symlink' : 'external-symlink',
  };
};

export const scanProjectSkills = async (input: {
  options?: SourceSkillScanOptions;
  projectPaths: readonly string[];
  sourceRepoPath?: string;
}): Promise<readonly ProjectSkillInventory[]> => {
  const inventories: ProjectSkillInventory[] = [];
  const options = {
    maxFilesPerSkill: input.options?.maxFilesPerSkill ?? defaultMaxFilesPerSkill,
    maxRuntimeEntries: input.options?.maxRuntimeEntries ?? defaultMaxRuntimeEntries,
    maxTextFileBytes: input.options?.maxTextFileBytes ?? defaultMaxTextFileBytes,
    tokenThresholds: input.options?.tokenThresholds ?? defaultTokenThresholds,
  };
  const ignoredDirectories = new Set([...defaultIgnoredDirectories, ...(input.options?.ignoredDirectories ?? [])]);
  const state: SkillSourceState = { version: 1, skillEnabledByName: {} };

  for (const projectPath of input.projectPaths) {
    const diagnostics: SkillDiagnostic[] = [];
    const observations: ProjectSkillObservation[] = [];
    let projectRealPath: string;
    try {
      projectRealPath = await realpath(projectPath);
    } catch {
      inventories.push({ diagnostics, observations, projectPath });
      continue;
    }
    for (const directory of projectSkillDirectories) {
      const runtimePath = path.join(projectPath, directory.relativePath);
      try {
        const runtimeRealPath = await realpath(runtimePath);
        if (!isPathWithin(projectRealPath, runtimeRealPath)) {
          diagnostics.push(
            createDiagnostic(
              'ExternalProjectSkillDirectoryNotScanned',
              'warning',
              'External project skill directory symlink was classified without reading its content',
              { path: runtimePath, targetId: directory.id },
            ),
          );
          continue;
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          diagnostics.push(
            createDiagnostic(
              'UnreadableProjectSkillDirectory',
              'warning',
              'Project skill directory could not be inspected',
              { path: runtimePath, targetId: directory.id },
            ),
          );
        }
        continue;
      }
      let runtimeDirectoryHandle: Awaited<ReturnType<typeof opendir>>;
      try {
        runtimeDirectoryHandle = await opendir(runtimePath);
      } catch (error) {
        if (!isMissingPathError(error)) {
          diagnostics.push(
            createDiagnostic(
              'UnreadableProjectSkillDirectory',
              'warning',
              'Project skill directory could not be read',
              {
                path: runtimePath,
                targetId: directory.id,
              },
            ),
          );
        }
        continue;
      }
      let inspectedRuntimeEntryCount = 0;
      for await (const entry of runtimeDirectoryHandle) {
        if (inspectedRuntimeEntryCount >= options.maxRuntimeEntries) {
          diagnostics.push(
            createDiagnostic(
              'ProjectSkillEntryLimitExceeded',
              'warning',
              'Project skill runtime has more entries than the configured scan limit',
              { path: runtimePath, targetId: directory.id },
            ),
          );
          break;
        }
        inspectedRuntimeEntryCount += 1;
        if (!(entry.isDirectory() || entry.isSymbolicLink())) {
          continue;
        }
        const entryPath = path.join(runtimePath, entry.name);
        let placement: ProjectSkillPlacement;
        let pathForScan: string;
        try {
          ({ pathForScan, placement } = await projectPlacementFor(entryPath, projectPath, input.sourceRepoPath));
        } catch {
          diagnostics.push(
            createDiagnostic('UnreadableProjectSkillEntry', 'warning', 'Project skill entry could not be inspected', {
              path: entryPath,
              targetId: directory.id,
            }),
          );
          continue;
        }
        if (placement === 'external-symlink') {
          try {
            parseSkillName(entry.name);
          } catch {
            diagnostics.push(
              createDiagnostic(
                'InvalidSkillDirectoryName',
                'error',
                'Skill directory name must be lowercase kebab-case',
                { path: entryPath },
              ),
            );
            continue;
          }
          const externalDiagnostic = createDiagnostic(
            'ExternalProjectSkillNotScanned',
            'warning',
            'External project skill symlink was classified without reading its content',
            { path: entryPath, skillName: entry.name, targetId: directory.id },
          );
          diagnostics.push(externalDiagnostic);
          observations.push({
            description: '',
            diagnostics: [externalDiagnostic],
            invocation: 'auto',
            markdownReadable: false,
            name: entry.name,
            path: entryPath,
            placement,
            runtimeDirId: directory.id,
            skillMdPath: path.join(entryPath, 'SKILL.md'),
            validationStatus: 'warning',
          });
          continue;
        }
        const result = await scanOneSkill(pathForScan, state, options, ignoredDirectories, false);
        diagnostics.push(...result.diagnostics);
        if (result.skill === undefined) {
          continue;
        }
        observations.push({
          description: result.skill.description,
          diagnostics: result.skill.diagnostics,
          invocation: invocationForFields(result.skill.manifest.fields),
          markdownReadable: true,
          name: result.skill.name,
          path: result.skill.path,
          placement,
          runtimeDirId: directory.id,
          skillMdPath: result.skill.skillMdPath,
          tokenCount: result.skill.tokenCount,
          validationStatus: result.skill.validationStatus,
        });
      }
    }
    const runtimeOrder = new Map(projectSkillDirectories.map((directory, index) => [directory.id, index]));
    inventories.push({
      diagnostics,
      observations: observations.toSorted((left, right) => {
        const runtimeDifference =
          (runtimeOrder.get(left.runtimeDirId) ?? 0) - (runtimeOrder.get(right.runtimeDirId) ?? 0);
        return runtimeDifference === 0 ? left.name.localeCompare(right.name) : runtimeDifference;
      }),
      projectPath,
    });
  }
  return inventories;
};
