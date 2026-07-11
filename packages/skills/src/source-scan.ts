import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultTokenThresholds,
  maxSkillMarkdownBytes,
  type SkillDiagnostic,
  type SkillSourceState,
  type SkillTokenThreshold,
  type SourceSkill,
  type SourceSkillScan,
  type SourceSkillScanInput,
  type SourceSkillScanOptions,
} from './contracts';
import { createDiagnostic, isMissingPathError } from './diagnostics';
import { readBoundedRegularFile, withSerializedFileMutation } from './filesystem';
import {
  defaultIgnoredDirectories,
  defaultMaxFilesPerSkill,
  defaultMaxSkills,
  defaultMaxTextFileBytes,
} from './scan-options';
import { parseSkillName } from './shared';
import { approximateTokenCount, looksBinary, parseSkillMarkdown, validationStatusFor } from './skill-markdown';
import { recoverSkillMarkdownWrite, recoveryPathsForMarkdown } from './skill-markdown-io';
import { loadSkillSourceState } from './source-state';
import { parseRequiredNonEmptyString } from './validation';

const maxSkillDirectoryDepth = 64;

interface CollectedSkillFiles {
  depthLimitExceeded: boolean;
  fileLimitExceeded: boolean;
  files: readonly string[];
  unsupportedPaths: readonly string[];
}

const collectSkillFiles = async (
  directory: string,
  ignoredDirectories: ReadonlySet<string>,
  maxFiles: number,
): Promise<CollectedSkillFiles> => {
  const files: string[] = [];
  const unsupportedPaths: string[] = [];
  let depthLimitExceeded = false;
  let fileLimitExceeded = false;
  let visitedEntryCount = 0;

  const visitDirectory = async (currentDirectory: string, depth: number): Promise<boolean> => {
    if (depth > maxSkillDirectoryDepth) {
      depthLimitExceeded = true;
      return true;
    }
    const directoryHandle = await opendir(currentDirectory);
    for await (const entry of directoryHandle) {
      if (visitedEntryCount >= maxFiles) {
        fileLimitExceeded = true;
        return false;
      }
      visitedEntryCount += 1;
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }
        if (!(await visitDirectory(entryPath, depth + 1))) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        unsupportedPaths.push(entryPath);
        continue;
      }
      files.push(entryPath);
    }
    return true;
  };

  await visitDirectory(directory, 0);
  return {
    depthLimitExceeded,
    fileLimitExceeded,
    files: files.toSorted((left, right) => left.localeCompare(right)),
    unsupportedPaths: unsupportedPaths.toSorted((left, right) => left.localeCompare(right)),
  };
};

const readTextForTokenCount = async (
  filePath: string,
  maxTextFileBytes: number,
  skillName: string,
): Promise<{ diagnostics: readonly SkillDiagnostic[]; text: string }> => {
  const result = await readBoundedRegularFile(filePath, maxTextFileBytes);
  if (result.kind === 'too-large') {
    return {
      diagnostics: [
        createDiagnostic('SkillFileTooLarge', 'warning', 'Skill file is too large for token counting', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  if (result.kind !== 'ok') {
    return {
      diagnostics: [
        createDiagnostic('UnreadableSkillReferenceFile', 'warning', 'Skill reference file could not be read', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  if (looksBinary(result.buffer)) {
    return {
      diagnostics: [
        createDiagnostic('BinarySkillFileSkipped', 'info', 'Binary skill file was skipped for token counting', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  return { diagnostics: [], text: result.buffer.toString('utf8') };
};

type TokenDiagnosticKind = 'markdown' | 'reference' | 'total';

const tokenDiagnosticFor = (
  kind: TokenDiagnosticKind,
  tokenCount: number,
  threshold: SkillTokenThreshold,
  details: { path: string; skillName: string },
): SkillDiagnostic | undefined => {
  const labels: Record<TokenDiagnosticKind, string> = {
    markdown: 'SKILL.md',
    reference: 'Skill reference file',
    total: 'Total skill',
  };
  const codePrefixes: Record<TokenDiagnosticKind, string> = {
    markdown: 'SkillMarkdownToken',
    reference: 'SkillReferenceToken',
    total: 'SkillTotalToken',
  };
  if (tokenCount >= threshold.high) {
    return createDiagnostic(
      `${codePrefixes[kind]}High`,
      'error',
      `${labels[kind]} token count reached the configured high threshold`,
      details,
    );
  }
  if (tokenCount >= threshold.warn) {
    return createDiagnostic(
      `${codePrefixes[kind]}Warning`,
      'warning',
      `${labels[kind]} token count reached the configured warning threshold`,
      details,
    );
  }
  return;
};

export const scanOneSkill = async (
  skillDirectory: string,
  stateValue: SkillSourceState,
  options: Required<Pick<SourceSkillScanOptions, 'maxFilesPerSkill' | 'maxTextFileBytes' | 'tokenThresholds'>>,
  ignoredDirectories: ReadonlySet<string>,
  recoverMarkdownWrites: boolean,
): Promise<{ diagnostics: readonly SkillDiagnostic[]; skill?: SourceSkill }> => {
  const skillName = path.basename(skillDirectory);
  try {
    parseSkillName(skillName);
  } catch {
    return {
      diagnostics: [
        createDiagnostic('InvalidSkillDirectoryName', 'error', 'Skill directory name must be lowercase kebab-case', {
          path: skillDirectory,
        }),
      ],
    };
  }

  const skillMdPath = path.join(skillDirectory, 'SKILL.md');
  if (recoverMarkdownWrites) {
    try {
      const canonicalSkillDirectory = await realpath(skillDirectory);
      const canonicalSkillMarkdownPath = path.join(canonicalSkillDirectory, 'SKILL.md');
      const recoveryStatus = await withSerializedFileMutation(canonicalSkillMarkdownPath, () =>
        recoverSkillMarkdownWrite(recoveryPathsForMarkdown(canonicalSkillMarkdownPath)),
      );
      if (recoveryStatus === 'blocked') {
        return {
          diagnostics: [
            createDiagnostic(
              'SkillMarkdownRecoveryConflict',
              'error',
              'SKILL.md has an unresolved crash-recovery conflict',
              { path: skillMdPath, skillName },
            ),
          ],
        };
      }
    } catch {
      return {
        diagnostics: [
          createDiagnostic('UnreadableSkillMarkdown', 'error', 'SKILL.md crash recovery could not be checked', {
            path: skillMdPath,
            skillName,
          }),
        ],
      };
    }
  }

  const skillMdRead = await readBoundedRegularFile(skillMdPath, maxSkillMarkdownBytes);
  if (skillMdRead.kind === 'missing') {
    return {
      diagnostics: [
        createDiagnostic('MissingSkillMarkdown', 'error', 'Skill directory is missing SKILL.md', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }
  if (skillMdRead.kind === 'too-large') {
    return {
      diagnostics: [
        createDiagnostic('SkillMarkdownTooLarge', 'error', 'SKILL.md is too large to scan safely', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }
  if (skillMdRead.kind !== 'ok') {
    return {
      diagnostics: [
        createDiagnostic('UnreadableSkillMarkdown', 'error', 'SKILL.md must be a readable regular file', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }
  const skillMdText = skillMdRead.buffer.toString('utf8');

  const parsedMarkdown = parseSkillMarkdown(skillName, skillMdText);
  const diagnostics: SkillDiagnostic[] = [...parsedMarkdown.diagnostics];
  let collectedFiles: CollectedSkillFiles;
  try {
    collectedFiles = await collectSkillFiles(skillDirectory, ignoredDirectories, options.maxFilesPerSkill);
  } catch {
    collectedFiles = {
      depthLimitExceeded: false,
      fileLimitExceeded: false,
      files: [skillMdPath],
      unsupportedPaths: [],
    };
    diagnostics.push(
      createDiagnostic('UnreadableSkillDirectory', 'warning', 'Skill directory could not be fully scanned', {
        path: skillDirectory,
        skillName,
      }),
    );
  }

  if (collectedFiles.fileLimitExceeded) {
    diagnostics.push(
      createDiagnostic('SkillFileLimitExceeded', 'warning', 'Skill has more files than the configured scan limit', {
        path: skillDirectory,
        skillName,
      }),
    );
  }
  if (collectedFiles.depthLimitExceeded) {
    diagnostics.push(
      createDiagnostic('SkillDirectoryDepthExceeded', 'warning', 'Skill directory nesting exceeds the scan limit', {
        path: skillDirectory,
        skillName,
      }),
    );
  }
  for (const unsupportedPath of collectedFiles.unsupportedPaths) {
    diagnostics.push(
      createDiagnostic('UnsupportedSkillFile', 'warning', 'Skill scanner skipped a non-regular file', {
        path: unsupportedPath,
        skillName,
      }),
    );
  }

  let referenceTokens = 0;
  const referenceTokenDiagnostics: SkillDiagnostic[] = [];
  const referenceFiles = collectedFiles.files.filter((filePath) => path.basename(filePath) !== 'SKILL.md');
  for (const filePath of referenceFiles) {
    const textResult = await readTextForTokenCount(filePath, options.maxTextFileBytes, skillName);
    diagnostics.push(...textResult.diagnostics);
    const fileTokens = approximateTokenCount(textResult.text);
    referenceTokens += fileTokens;
    const tokenDiagnostic = tokenDiagnosticFor('reference', fileTokens, options.tokenThresholds.referenceFile, {
      path: filePath,
      skillName,
    });
    if (tokenDiagnostic !== undefined) {
      referenceTokenDiagnostics.push(tokenDiagnostic);
    }
  }

  const skillMdTokens = approximateTokenCount(skillMdText);
  const totalTokens = skillMdTokens + referenceTokens;
  const skillMdTokenDiagnostic = tokenDiagnosticFor('markdown', skillMdTokens, options.tokenThresholds.skillMd, {
    path: skillMdPath,
    skillName,
  });
  if (skillMdTokenDiagnostic !== undefined) {
    diagnostics.push(skillMdTokenDiagnostic);
  }
  diagnostics.push(...referenceTokenDiagnostics);
  const totalTokenDiagnostic = tokenDiagnosticFor('total', totalTokens, options.tokenThresholds.totalSkill, {
    path: skillDirectory,
    skillName,
  });
  if (totalTokenDiagnostic !== undefined) {
    diagnostics.push(totalTokenDiagnostic);
  }
  const skill: SourceSkill = {
    description: parsedMarkdown.manifest.description ?? '',
    diagnostics,
    enabled: stateValue.skillEnabledByName[skillName] ?? true,
    manifest: parsedMarkdown.manifest,
    name: skillName,
    path: skillDirectory,
    skillMdPath,
    tokenCount: {
      approximate: true,
      references: referenceTokens,
      skillMd: skillMdTokens,
      total: totalTokens,
    },
    validationStatus: validationStatusFor(diagnostics),
  };

  return { diagnostics, skill };
};

export const scanSkillSourceRepository = async (input: SourceSkillScanInput): Promise<SourceSkillScan> => {
  const sourceRepoPath = parseRequiredNonEmptyString(input.sourceRepoPath, 'sourceRepoPath');
  const stateResult =
    input.state === undefined ? await loadSkillSourceState(sourceRepoPath) : { diagnostics: [], state: input.state };
  const diagnostics: SkillDiagnostic[] = [...stateResult.diagnostics];
  const skillsDirectory = path.join(sourceRepoPath, 'skills');
  const ignoredDirectories = new Set([...defaultIgnoredDirectories, ...(input.options?.ignoredDirectories ?? [])]);
  const options = {
    maxFilesPerSkill: input.options?.maxFilesPerSkill ?? defaultMaxFilesPerSkill,
    maxSkills: input.options?.maxSkills ?? defaultMaxSkills,
    maxTextFileBytes: input.options?.maxTextFileBytes ?? defaultMaxTextFileBytes,
    tokenThresholds: input.options?.tokenThresholds ?? defaultTokenThresholds,
  };

  const skills: SourceSkill[] = [];
  try {
    const skillsDirectoryHandle = await opendir(skillsDirectory);
    let inspectedEntryCount = 0;
    for await (const entry of skillsDirectoryHandle) {
      if (inspectedEntryCount >= options.maxSkills) {
        diagnostics.push(
          createDiagnostic(
            'SourceSkillLimitExceeded',
            'warning',
            'Source skills directory has more entries than the configured scan limit',
            { path: skillsDirectory },
          ),
        );
        break;
      }
      inspectedEntryCount += 1;
      if (!entry.isDirectory()) {
        continue;
      }
      const result = await scanOneSkill(
        path.join(skillsDirectory, entry.name),
        stateResult.state,
        options,
        ignoredDirectories,
        true,
      );
      diagnostics.push(...result.diagnostics);
      if (result.skill) {
        skills.push(result.skill);
      }
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { diagnostics, skills: [] };
    }
    return {
      diagnostics: [
        ...diagnostics,
        createDiagnostic('UnreadableSkillsDirectory', 'error', 'Source skills directory could not be read', {
          path: skillsDirectory,
        }),
      ],
      skills: [],
    };
  }
  return { diagnostics, skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)) };
};
