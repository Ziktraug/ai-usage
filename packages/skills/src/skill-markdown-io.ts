import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { maxSkillMarkdownBytes, type SkillMarkdownDocument, type SkillMarkdownWriteInput } from './contracts';
import { isMissingPathError, isRecord } from './diagnostics';
import {
  atomicWriteFile,
  existingRegularFileMode,
  readBoundedRegularFile,
  sameFileIdentity,
  withSerializedFileMutation,
  writeExclusiveFile,
} from './filesystem';
import { parseSkillName } from './shared';
import { assertRecord, parseRequiredNonEmptyString, parseString } from './validation';

const sha256 = (buffer: Buffer | string): string => createHash('sha256').update(buffer).digest('hex');

const skillMarkdownPathFor = (sourceRepoPath: string, skillName: string): string =>
  path.join(sourceRepoPath, 'skills', parseSkillName(skillName), 'SKILL.md');

const isInsideDirectory = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative === '' || !(relative.startsWith('..') || path.isAbsolute(relative));
};

interface SkillMarkdownLocation {
  filePath: string;
  markdownPath: string;
}

const resolveSkillMarkdownLocation = async (
  sourceRepoPath: string,
  skillName: string,
): Promise<SkillMarkdownLocation | undefined> => {
  const filePath = skillMarkdownPathFor(sourceRepoPath, skillName);
  try {
    const realSourcePath = await realpath(sourceRepoPath);
    const realSkillsPath = await realpath(path.join(realSourcePath, 'skills'));
    const realSkillPath = await realpath(path.join(realSkillsPath, skillName));
    if (!(isInsideDirectory(realSourcePath, realSkillsPath) && isInsideDirectory(realSkillsPath, realSkillPath))) {
      return;
    }
    return { filePath, markdownPath: path.join(realSkillPath, 'SKILL.md') };
  } catch {
    return;
  }
};

export const readSkillMarkdown = async (input: {
  skillName: string;
  sourceRepoPath: string;
}): Promise<SkillMarkdownDocument> => {
  const skillName = parseSkillName(input.skillName);
  const location = await resolveSkillMarkdownLocation(input.sourceRepoPath, skillName);
  if (location === undefined) {
    throw new Error('skill markdown not found');
  }
  return await withSerializedFileMutation(location.markdownPath, async () => {
    const recoveryPaths = recoveryPathsForMarkdown(location.markdownPath);
    if ((await recoverSkillMarkdownWrite(recoveryPaths)) === 'blocked') {
      throw new Error('skill markdown has an unresolved recovery conflict');
    }
    const fileRead = await readBoundedRegularFile(location.markdownPath, maxSkillMarkdownBytes);
    if (fileRead.kind === 'too-large') {
      throw new Error('skill markdown is too large');
    }
    if (fileRead.kind !== 'ok') {
      throw new Error('skill markdown not found');
    }
    return {
      content: fileRead.buffer.toString('utf8'),
      path: location.filePath,
      sha256: sha256(fileRead.buffer),
      skillName,
    };
  });
};

const sha256Pattern = /^[a-f0-9]{64}$/;

export const parseSkillMarkdownWriteInput = (input: unknown): SkillMarkdownWriteInput => {
  const record = assertRecord(input, 'skill markdown write input');
  const content = parseString(record.content, 'content');
  if (Buffer.byteLength(content, 'utf8') > maxSkillMarkdownBytes) {
    throw new Error('content must be at most 262144 bytes');
  }
  const baseSha256 = parseRequiredNonEmptyString(record.baseSha256, 'baseSha256');
  if (!sha256Pattern.test(baseSha256)) {
    throw new Error('baseSha256 must be a 64-character lowercase hex string');
  }
  return {
    baseSha256,
    content,
    skillName: parseSkillName(record.skillName),
  };
};

const linkClaimedMarkdownNoClobber = async (claimedPath: string, markdownPath: string): Promise<boolean> => {
  try {
    await link(claimedPath, markdownPath);
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  return true;
};

type SkillMarkdownWriteResult = { ok: true } | { ok: false; reason: 'conflict' | 'not-found' | 'too-large' };

interface SkillMarkdownWriteJournal {
  baseSha256: string;
  newSha256: string;
  operationId: string;
  phase: 'claimed' | 'prepared' | 'published';
  tempName: string;
  version: 1;
}

export interface SkillMarkdownRecoveryPaths {
  claimPath: string;
  journalPath: string;
  markdownPath: string;
}

const skillMarkdownJournalMaxBytes = 4096;
const skillMarkdownTempNamePattern = /^\.SKILL\.md\.ai-usage\.[a-z0-9-]+\.tmp$/;

export const recoveryPathsForMarkdown = (markdownPath: string): SkillMarkdownRecoveryPaths => ({
  claimPath: path.join(path.dirname(markdownPath), '.SKILL.md.ai-usage.claim'),
  journalPath: path.join(path.dirname(markdownPath), '.SKILL.md.ai-usage.journal.json'),
  markdownPath,
});

const parseSkillMarkdownWriteJournal = (value: unknown): SkillMarkdownWriteJournal | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.baseSha256 !== 'string' ||
    !sha256Pattern.test(value.baseSha256) ||
    typeof value.newSha256 !== 'string' ||
    !sha256Pattern.test(value.newSha256) ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    (value.phase !== 'prepared' && value.phase !== 'claimed' && value.phase !== 'published') ||
    typeof value.tempName !== 'string' ||
    !skillMarkdownTempNamePattern.test(value.tempName)
  ) {
    return;
  }
  if (value.tempName !== `.SKILL.md.ai-usage.${value.operationId}.tmp`) {
    return;
  }
  return value as unknown as SkillMarkdownWriteJournal;
};

type SkillMarkdownJournalRead =
  | { kind: 'invalid' }
  | { kind: 'missing' }
  | {
      identity: { dev: number | bigint; ino: number | bigint };
      journal: SkillMarkdownWriteJournal;
      kind: 'ok';
    };

type RecoveryArtifactValidation =
  | { kind: 'invalid' }
  | { kind: 'missing' }
  | { identity: { dev: number | bigint; ino: number | bigint }; kind: 'valid' };

const readSkillMarkdownWriteJournal = async (journalPath: string): Promise<SkillMarkdownJournalRead> => {
  const journalRead = await readBoundedRegularFile(journalPath, skillMarkdownJournalMaxBytes);
  if (journalRead.kind === 'missing') {
    return { kind: 'missing' };
  }
  if (journalRead.kind !== 'ok') {
    return { kind: 'invalid' };
  }
  try {
    const journal = parseSkillMarkdownWriteJournal(JSON.parse(journalRead.buffer.toString('utf8')) as unknown);
    return journal === undefined ? { kind: 'invalid' } : { identity: journalRead.identity, journal, kind: 'ok' };
  } catch {
    return { kind: 'invalid' };
  }
};

const writeSkillMarkdownJournal = async (journalPath: string, journal: SkillMarkdownWriteJournal): Promise<void> =>
  atomicWriteFile(journalPath, `${JSON.stringify(journal)}\n`);

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const validateRecoveryArtifact = async (
  artifactPath: string,
  expectedSha256: string,
): Promise<RecoveryArtifactValidation> => {
  const artifactRead = await readBoundedRegularFile(artifactPath, maxSkillMarkdownBytes);
  if (artifactRead.kind === 'missing') {
    return { kind: 'missing' };
  }
  if (artifactRead.kind !== 'ok' || sha256(artifactRead.buffer) !== expectedSha256) {
    return { kind: 'invalid' };
  }
  return { identity: artifactRead.identity, kind: 'valid' };
};

const removeArtifactWithIdentity = async (
  artifactPath: string,
  identity: { dev: number | bigint; ino: number | bigint },
): Promise<boolean> => {
  try {
    const artifactStat = await lstat(artifactPath);
    if (!sameFileIdentity(artifactStat, identity)) {
      return false;
    }
    await unlink(artifactPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const journalsEqual = (left: SkillMarkdownWriteJournal, right: SkillMarkdownWriteJournal): boolean =>
  left.baseSha256 === right.baseSha256 &&
  left.newSha256 === right.newSha256 &&
  left.operationId === right.operationId &&
  left.phase === right.phase &&
  left.tempName === right.tempName &&
  left.version === right.version;

const cleanupValidatedSkillMarkdownJournal = async (
  paths: SkillMarkdownRecoveryPaths,
  journal: SkillMarkdownWriteJournal,
  expected?: {
    journalIdentity: { dev: number | bigint; ino: number | bigint };
    tempValidation: RecoveryArtifactValidation;
  },
): Promise<boolean> => {
  const temporaryPath = path.join(path.dirname(paths.markdownPath), journal.tempName);
  const tempValidation = await validateRecoveryArtifact(temporaryPath, journal.newSha256);
  if (tempValidation.kind === 'invalid') {
    return false;
  }
  const journalRead = await readSkillMarkdownWriteJournal(paths.journalPath);
  if (journalRead.kind !== 'ok' || !journalsEqual(journalRead.journal, journal)) {
    return false;
  }
  if (expected !== undefined) {
    if (!sameFileIdentity(journalRead.identity, expected.journalIdentity)) {
      return false;
    }
    if (expected.tempValidation.kind !== tempValidation.kind) {
      return false;
    }
    if (
      expected.tempValidation.kind === 'valid' &&
      tempValidation.kind === 'valid' &&
      !sameFileIdentity(expected.tempValidation.identity, tempValidation.identity)
    ) {
      return false;
    }
  }
  if (tempValidation.kind === 'valid' && !(await removeArtifactWithIdentity(temporaryPath, tempValidation.identity))) {
    return false;
  }
  return await removeArtifactWithIdentity(paths.journalPath, journalRead.identity);
};

const journalReadIsUnchanged = async (
  journalPath: string,
  expected: Extract<SkillMarkdownJournalRead, { kind: 'ok' }>,
): Promise<boolean> => {
  const current = await readSkillMarkdownWriteJournal(journalPath);
  return (
    current.kind === 'ok' &&
    sameFileIdentity(current.identity, expected.identity) &&
    journalsEqual(current.journal, expected.journal)
  );
};

export const recoverSkillMarkdownWrite = async (paths: SkillMarkdownRecoveryPaths): Promise<'blocked' | 'ready'> => {
  const journalRead = await readSkillMarkdownWriteJournal(paths.journalPath);
  if (journalRead.kind === 'invalid') {
    return 'blocked';
  }
  if (journalRead.kind === 'missing') {
    const claimRead = await readBoundedRegularFile(paths.claimPath, maxSkillMarkdownBytes);
    if (claimRead.kind === 'missing') {
      return 'ready';
    }
    const markdownRead = await readBoundedRegularFile(paths.markdownPath, maxSkillMarkdownBytes);
    if (
      claimRead.kind !== 'ok' ||
      markdownRead.kind !== 'ok' ||
      !sameFileIdentity(claimRead.identity, markdownRead.identity)
    ) {
      return 'blocked';
    }
    const currentMarkdownStat = await lstat(paths.markdownPath);
    if (!sameFileIdentity(currentMarkdownStat, markdownRead.identity)) {
      return 'blocked';
    }
    return (await removeArtifactWithIdentity(paths.claimPath, claimRead.identity)) ? 'ready' : 'blocked';
  }
  const { journal } = journalRead;
  const tempValidation = await validateRecoveryArtifact(
    path.join(path.dirname(paths.markdownPath), journal.tempName),
    journal.newSha256,
  );
  if (tempValidation.kind === 'invalid') {
    return 'blocked';
  }
  // The writer persists prepared -> claims Markdown -> persists claimed -> creates temp.
  // Therefore any prepared journal accompanied by a temp is not an ai-usage state.
  if (journal.phase === 'prepared' && tempValidation.kind !== 'missing') {
    return 'blocked';
  }
  const cleanupExpected = { journalIdentity: journalRead.identity, tempValidation };
  const claimValidation = await validateRecoveryArtifact(paths.claimPath, journal.baseSha256);
  if (claimValidation.kind === 'invalid') {
    return 'blocked';
  }
  const markdownRead = await readBoundedRegularFile(paths.markdownPath, maxSkillMarkdownBytes);
  if (claimValidation.kind === 'missing') {
    if (markdownRead.kind !== 'ok') {
      return 'blocked';
    }
    const markdownSha = sha256(markdownRead.buffer);
    const isPreparedRollback =
      journal.phase === 'prepared' && tempValidation.kind === 'missing' && markdownSha === journal.baseSha256;
    const isLaterPublication =
      journal.phase !== 'prepared' &&
      markdownSha === journal.newSha256 &&
      (tempValidation.kind === 'missing' || sameFileIdentity(tempValidation.identity, markdownRead.identity));
    if (!(isPreparedRollback || isLaterPublication)) {
      return 'blocked';
    }
    return (await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected)) ? 'ready' : 'blocked';
  }
  if (markdownRead.kind === 'missing') {
    const currentClaimStat = await lstat(paths.claimPath);
    if (
      !(
        sameFileIdentity(currentClaimStat, claimValidation.identity) &&
        (await journalReadIsUnchanged(paths.journalPath, journalRead))
      )
    ) {
      return 'blocked';
    }
    const restored = await linkClaimedMarkdownNoClobber(paths.claimPath, paths.markdownPath);
    if (!(restored && (await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected)))) {
      return 'blocked';
    }
    return (await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity)) ? 'ready' : 'blocked';
  }
  if (markdownRead.kind !== 'ok') {
    return 'blocked';
  }
  const markdownSha = sha256(markdownRead.buffer);
  const isPublished =
    journal.phase !== 'prepared' &&
    markdownSha === journal.newSha256 &&
    tempValidation.kind === 'valid' &&
    sameFileIdentity(tempValidation.identity, markdownRead.identity);
  const isRollback =
    markdownSha === journal.baseSha256 && sameFileIdentity(markdownRead.identity, claimValidation.identity);
  if (!(isPublished || isRollback)) {
    return 'blocked';
  }
  if (!(await journalReadIsUnchanged(paths.journalPath, journalRead))) {
    return 'blocked';
  }
  if (isRollback) {
    if (!(await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected))) {
      return 'blocked';
    }
    return (await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity)) ? 'ready' : 'blocked';
  }
  if (!(await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity))) {
    return 'blocked';
  }
  return (await cleanupValidatedSkillMarkdownJournal(paths, journal, cleanupExpected)) ? 'ready' : 'blocked';
};

const claimSkillMarkdown = async (paths: SkillMarkdownRecoveryPaths): Promise<boolean> => {
  if (await pathExists(paths.claimPath)) {
    return false;
  }
  try {
    await rename(paths.markdownPath, paths.claimPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const restoreClaimAndCleanupJournal = async (
  paths: SkillMarkdownRecoveryPaths,
  journal: SkillMarkdownWriteJournal,
  reason: 'conflict' | 'not-found' | 'too-large',
): Promise<SkillMarkdownWriteResult> => {
  const journalRead = await readSkillMarkdownWriteJournal(paths.journalPath);
  const tempValidation = await validateRecoveryArtifact(
    path.join(path.dirname(paths.markdownPath), journal.tempName),
    journal.newSha256,
  );
  if (journalRead.kind !== 'ok' || !journalsEqual(journalRead.journal, journal) || tempValidation.kind === 'invalid') {
    return { ok: false, reason: 'conflict' };
  }
  const claimValidation = await validateRecoveryArtifact(paths.claimPath, journal.baseSha256);
  if (claimValidation.kind !== 'valid') {
    return { ok: false, reason: 'conflict' };
  }
  const currentClaimStat = await lstat(paths.claimPath);
  if (
    !(
      sameFileIdentity(currentClaimStat, claimValidation.identity) &&
      (await journalReadIsUnchanged(paths.journalPath, journalRead))
    )
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const restored = await linkClaimedMarkdownNoClobber(paths.claimPath, paths.markdownPath);
  if (
    !(
      restored &&
      (await cleanupValidatedSkillMarkdownJournal(paths, journal, {
        journalIdentity: journalRead.identity,
        tempValidation,
      })) &&
      (await removeArtifactWithIdentity(paths.claimPath, claimValidation.identity))
    )
  ) {
    return { ok: false, reason: 'conflict' };
  }
  return { ok: false, reason };
};

export const writeSkillMarkdown = async (input: {
  baseSha256: string;
  content: string;
  skillName: string;
  sourceRepoPath: string;
}): Promise<SkillMarkdownWriteResult> => {
  const skillName = parseSkillName(input.skillName);
  if (Buffer.byteLength(input.content, 'utf8') > maxSkillMarkdownBytes) {
    return { ok: false, reason: 'too-large' };
  }
  if (!sha256Pattern.test(input.baseSha256)) {
    throw new Error('baseSha256 must be a 64-character lowercase hex string');
  }
  const location = await resolveSkillMarkdownLocation(input.sourceRepoPath, skillName);
  if (location === undefined) {
    return { ok: false, reason: 'not-found' };
  }
  const recoveryPaths = recoveryPathsForMarkdown(location.markdownPath);
  return await withSerializedFileMutation(location.markdownPath, async () => {
    if ((await recoverSkillMarkdownWrite(recoveryPaths)) === 'blocked') {
      return { ok: false, reason: 'conflict' };
    }
    const currentRead = await readBoundedRegularFile(location.markdownPath, maxSkillMarkdownBytes);
    if (currentRead.kind === 'too-large') {
      return { ok: false, reason: 'too-large' };
    }
    if (currentRead.kind !== 'ok') {
      return { ok: false, reason: 'not-found' };
    }
    if (sha256(currentRead.buffer) !== input.baseSha256) {
      return { ok: false, reason: 'conflict' };
    }
    const operationId = randomUUID();
    let journal: SkillMarkdownWriteJournal = {
      baseSha256: input.baseSha256,
      newSha256: sha256(input.content),
      operationId,
      phase: 'prepared',
      tempName: `.SKILL.md.ai-usage.${operationId}.tmp`,
      version: 1,
    };
    await writeSkillMarkdownJournal(recoveryPaths.journalPath, journal);
    if (!(await claimSkillMarkdown(recoveryPaths))) {
      return (await cleanupValidatedSkillMarkdownJournal(recoveryPaths, journal))
        ? { ok: false, reason: 'not-found' }
        : { ok: false, reason: 'conflict' };
    }
    journal = { ...journal, phase: 'claimed' };
    await writeSkillMarkdownJournal(recoveryPaths.journalPath, journal);
    const claimedRead = await readBoundedRegularFile(recoveryPaths.claimPath, maxSkillMarkdownBytes);
    if (claimedRead.kind === 'too-large') {
      return await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'too-large');
    }
    if (claimedRead.kind !== 'ok') {
      return await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'not-found');
    }
    if (sha256(claimedRead.buffer) !== input.baseSha256) {
      return await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'conflict');
    }
    const temporaryPath = path.join(path.dirname(location.markdownPath), journal.tempName);
    try {
      const mode = await existingRegularFileMode(recoveryPaths.claimPath, 0o600);
      await writeExclusiveFile(temporaryPath, input.content, mode);
    } catch (error) {
      await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'conflict');
      throw error;
    }
    try {
      await link(temporaryPath, location.markdownPath);
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') {
        await cleanupValidatedSkillMarkdownJournal(recoveryPaths, journal);
        return { ok: false, reason: 'conflict' };
      }
      await restoreClaimAndCleanupJournal(recoveryPaths, journal, 'conflict');
      throw error;
    }
    journal = { ...journal, phase: 'published' };
    await writeSkillMarkdownJournal(recoveryPaths.journalPath, journal);
    const publishedJournalRead = await readSkillMarkdownWriteJournal(recoveryPaths.journalPath);
    const publishedTempValidation = await validateRecoveryArtifact(temporaryPath, journal.newSha256);
    const publishedMarkdownRead = await readBoundedRegularFile(location.markdownPath, maxSkillMarkdownBytes);
    const claimValidation = await validateRecoveryArtifact(recoveryPaths.claimPath, journal.baseSha256);
    if (
      publishedJournalRead.kind !== 'ok' ||
      !journalsEqual(publishedJournalRead.journal, journal) ||
      publishedTempValidation.kind !== 'valid' ||
      publishedMarkdownRead.kind !== 'ok' ||
      !sameFileIdentity(publishedTempValidation.identity, publishedMarkdownRead.identity) ||
      claimValidation.kind !== 'valid' ||
      !(await journalReadIsUnchanged(recoveryPaths.journalPath, publishedJournalRead)) ||
      !(await removeArtifactWithIdentity(recoveryPaths.claimPath, claimValidation.identity)) ||
      !(await cleanupValidatedSkillMarkdownJournal(recoveryPaths, journal, {
        journalIdentity: publishedJournalRead.identity,
        tempValidation: publishedTempValidation,
      }))
    ) {
      throw new Error('skill markdown recovery artifacts changed before cleanup');
    }
    return { ok: true };
  });
};
